import {
  Diagnostic,
  TextDocument,
  WorkspaceFolder,
  workspace
} from 'vscode'
import {
  DidOpenTextDocumentNotification,
  Disposable,
  LanguageClient
} from 'vscode-languageclient/node'

export interface ClientManagerOptions {
  log: (message: string) => void
  createClient: (folder: WorkspaceFolder) => Promise<LanguageClient | null>
  shouldEnableForFolder: (folder: WorkspaceFolder) => Promise<boolean>
  onError: (message: string, folder: WorkspaceFolder) => Promise<void>
  onStatusUpdate: () => void
  supportedLanguage: (languageId: string) => boolean
}

/**
 * Manages multiple language clients for multi-root workspace support.
 * Each workspace folder gets its own language server instance.
 */
export class ClientManager {
  private readonly clients: Map<string, LanguageClient> = new Map()
  private readonly diagnosticCaches: Map<string, Map<string, Diagnostic[]>> = new Map()
  private readonly watchers: Map<string, Disposable[]> = new Map()
  private readonly pendingStarts: Set<string> = new Set()
  private readonly options: ClientManagerOptions

  constructor (options: ClientManagerOptions) {
    this.options = options
  }

  /**
   * Get the language client for a document's workspace folder.
   */
  getClient (document: TextDocument): LanguageClient | undefined {
    const folder = workspace.getWorkspaceFolder(document.uri)
    if (folder == null) return undefined
    return this.clients.get(this.getFolderKey(folder))
  }

  /**
   * Get the first available client (for backward compatibility).
   */
  getFirstClient (): LanguageClient | null {
    const first = this.clients.values().next().value
    return first ?? null
  }

  /**
   * Get the number of active clients.
   */
  get size (): number {
    return this.clients.size
  }

  /**
   * Iterate over all clients.
   */
  values (): IterableIterator<LanguageClient> {
    return this.clients.values()
  }

  /**
   * Get diagnostics for a document from its folder's cache.
   */
  getDiagnostics (document: TextDocument): Diagnostic[] | undefined {
    const folder = workspace.getWorkspaceFolder(document.uri)
    if (folder == null) return undefined
    const cache = this.diagnosticCaches.get(this.getFolderKey(folder))
    return cache?.get(document.uri.toString())
  }

  /**
   * Get the diagnostic cache for a folder (used by buildLanguageClientOptions).
   */
  getDiagnosticCacheForFolder (folder: WorkspaceFolder): Map<string, Diagnostic[]> {
    const key = this.getFolderKey(folder)
    let cache = this.diagnosticCaches.get(key)
    if (cache == null) {
      cache = new Map()
      this.diagnosticCaches.set(key, cache)
    }
    return cache
  }

  /**
   * Register watchers for a folder (called by buildLanguageClientOptions).
   */
  registerWatchers (folder: WorkspaceFolder, watcherDisposables: Disposable[]): void {
    this.watchers.set(this.getFolderKey(folder), watcherDisposables)
  }

  /**
   * Start the language server for a specific workspace folder.
   */
  async startForFolder (folder: WorkspaceFolder): Promise<void> {
    const key = this.getFolderKey(folder)

    // Already running for this folder
    if (this.clients.has(key)) return

    // Prevent race condition: if start is already in progress, skip
    if (this.pendingStarts.has(key)) return
    this.pendingStarts.add(key)

    try {
      // Check if we should enable for this folder
      if (!(await this.options.shouldEnableForFolder(folder))) {
        this.options.log(`Skipping workspace folder "${folder.name}" - extension disabled or not applicable`)
        return
      }

      const client = await this.options.createClient(folder)
      if (client != null) {
        this.clients.set(key, client)
        await client.start()
        await this.afterStart(client, folder)
        this.options.log(`Language server started for "${folder.name}"`)
      }
    } catch (error) {
      this.clients.delete(key)
      this.cleanupWatchers(key)
      this.options.log(`Failed to start language server for "${folder.name}": ${String(error)}`)
      await this.options.onError(`Failed to start Standard Ruby Language Server for "${folder.name}"`, folder)
    } finally {
      this.pendingStarts.delete(key)
    }
  }

  /**
   * Stop the language server for a specific workspace folder.
   */
  async stopForFolder (folder: WorkspaceFolder): Promise<void> {
    const key = this.getFolderKey(folder)
    const client = this.clients.get(key)

    if (client == null) return

    this.options.log(`Stopping language server for "${folder.name}"...`)
    await client.stop()
    this.clients.delete(key)
    this.diagnosticCaches.delete(key)
    this.cleanupWatchers(key)
  }

  /**
   * Start language servers for all workspace folders.
   */
  async startAll (): Promise<void> {
    const folders = workspace.workspaceFolders ?? []
    for (const folder of folders) {
      await this.startForFolder(folder)
    }
  }

  /**
   * Stop all language servers.
   */
  async stopAll (): Promise<void> {
    this.options.log('Stopping all language servers...')
    for (const [key, client] of this.clients) {
      await client.stop()
      this.clients.delete(key)
    }
    this.diagnosticCaches.clear()
    this.cleanupAllWatchers()
  }

  /**
   * Restart all language servers.
   */
  async restartAll (): Promise<void> {
    this.options.log('Restarting all language servers...')
    await this.stopAll()
    await this.startAll()
  }

  /**
   * Create a disposable that handles workspace folder changes.
   */
  createWorkspaceFolderListener (): Disposable {
    return workspace.onDidChangeWorkspaceFolders(async event => {
      // Stop servers for removed folders
      for (const folder of event.removed) {
        await this.stopForFolder(folder)
      }
      // Start servers for added folders
      for (const folder of event.added) {
        await this.startForFolder(folder)
      }
    })
  }

  /**
   * Send a document open notification if needed (for editor change handling).
   */
  async notifyDocumentOpenIfNeeded (document: TextDocument): Promise<void> {
    if (!this.options.supportedLanguage(document.languageId)) return

    const folder = workspace.getWorkspaceFolder(document.uri)
    if (folder == null) return

    const client = this.clients.get(this.getFolderKey(folder))
    if (client == null) return

    const cache = this.getDiagnosticCacheForFolder(folder)
    if (!cache.has(document.uri.toString())) {
      await client.sendNotification(
        DidOpenTextDocumentNotification.type,
        client.code2ProtocolConverter.asOpenTextDocumentParams(document)
      )
    }
  }

  // Private helpers

  private getFolderKey (folder: WorkspaceFolder): string {
    return folder.uri.toString()
  }

  private async afterStart (client: LanguageClient, folder: WorkspaceFolder): Promise<void> {
    this.diagnosticCaches.set(this.getFolderKey(folder), new Map())
    await this.syncOpenDocuments(client, folder)
    this.options.onStatusUpdate()
  }

  private async syncOpenDocuments (client: LanguageClient, folder: WorkspaceFolder): Promise<void> {
    const key = this.getFolderKey(folder)
    for (const doc of workspace.textDocuments) {
      if (this.options.supportedLanguage(doc.languageId)) {
        const docFolder = workspace.getWorkspaceFolder(doc.uri)
        if (docFolder != null && this.getFolderKey(docFolder) === key) {
          await client.sendNotification(
            DidOpenTextDocumentNotification.type,
            client.code2ProtocolConverter.asOpenTextDocumentParams(doc)
          )
        }
      }
    }
  }

  private cleanupWatchers (key: string): void {
    const watcherList = this.watchers.get(key)
    if (watcherList != null) {
      watcherList.forEach(w => w.dispose())
      this.watchers.delete(key)
    }
  }

  private cleanupAllWatchers (): void {
    for (const [key, watcherList] of this.watchers) {
      watcherList.forEach(w => w.dispose())
      this.watchers.delete(key)
    }
  }
}

/**
 * Normalize path for glob patterns (Windows uses backslashes which don't work in globs).
 */
export function normalizePathForGlob (fsPath: string): string {
  return fsPath.replace(/\\/g, '/')
}
