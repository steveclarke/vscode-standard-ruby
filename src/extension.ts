import { exec } from 'child_process'
import { homedir } from 'os'
import * as path from 'path'
import { satisfies } from 'semver'
import {
  Diagnostic,
  DiagnosticSeverity,
  ExtensionContext,
  OutputChannel,
  TextDocument,
  WorkspaceFolder,
  commands,
  window,
  workspace,
  ProviderResult,
  TextEdit,
  TextEditor,
  ThemeColor,
  StatusBarAlignment,
  StatusBarItem
} from 'vscode'
import {
  DidOpenTextDocumentNotification,
  Disposable,
  Executable,
  ExecuteCommandRequest,
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn
} from 'vscode-languageclient/node'

class ExecError extends Error {
  command: string
  options: object
  code: number | undefined
  stdout: string
  stderr: string

  constructor (message: string, command: string, options: object, code: number | undefined, stdout: string, stderr: string) {
    super(message)
    this.command = command
    this.options = options
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }

  log (): void {
    log(`Command \`${this.command}\` failed with exit code ${this.code ?? '?'} (exec options: ${JSON.stringify(this.options)})`)
    if (this.stdout.length > 0) {
      log(`stdout:\n${this.stdout}`)
    }
    if (this.stderr.length > 0) {
      log(`stderr:\n${this.stderr}`)
    }
  }
}

const promiseExec = async function (command: string, options: { cwd: string }): Promise<{ stdout: string, stderr: string }> {
  return await new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      stdout = stdout.toString().trim()
      stderr = stderr.toString().trim()
      if (error != null) {
        reject(new ExecError(error.message, command, options, error.code, stdout, stderr))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

// Multi-root workspace support: one language client per workspace folder
export const languageClients: Map<string, LanguageClient> = new Map()
let outputChannel: OutputChannel | undefined
let statusBarItem: StatusBarItem | undefined
// Diagnostic cache is now per-folder
const diagnosticCaches: Map<string, Map<string, Diagnostic[]>> = new Map()

// Legacy export for backward compatibility (returns first client or null)
export function getLanguageClient (): LanguageClient | null {
  const firstClient = languageClients.values().next().value
  return firstClient ?? null
}

function getFolderKey (folder: WorkspaceFolder): string {
  return folder.uri.toString()
}

function getWorkspaceFolderForDocument (document: TextDocument): WorkspaceFolder | undefined {
  return workspace.getWorkspaceFolder(document.uri)
}

function getClientForDocument (document: TextDocument): LanguageClient | undefined {
  const folder = getWorkspaceFolderForDocument(document)
  if (folder == null) return undefined
  return languageClients.get(getFolderKey(folder))
}

function getDiagnosticCache (folder: WorkspaceFolder): Map<string, Diagnostic[]> {
  const key = getFolderKey(folder)
  let cache = diagnosticCaches.get(key)
  if (cache == null) {
    cache = new Map()
    diagnosticCaches.set(key, cache)
  }
  return cache
}

function log (s: string): void {
  outputChannel?.appendLine(`[client] ${s}`)
}

function getConfig<T> (key: string): T | undefined {
  return workspace.getConfiguration('standardRuby').get<T>(key)
}

function supportedLanguage (languageId: string): boolean {
  return languageId === 'ruby' || languageId === 'gemfile'
}

function registerCommands (): Disposable[] {
  return [
    commands.registerCommand('standardRuby.start', startAllLanguageServers),
    commands.registerCommand('standardRuby.stop', stopAllLanguageServers),
    commands.registerCommand('standardRuby.restart', restartAllLanguageServers),
    commands.registerCommand('standardRuby.showOutputChannel', () => outputChannel?.show()),
    commands.registerCommand('standardRuby.formatAutoFixes', formatAutoFixes)
  ]
}

function registerWorkspaceListeners (): Disposable[] {
  return [
    workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration('standardRuby')) {
        await restartAllLanguageServers()
      }
    }),
    workspace.onDidChangeWorkspaceFolders(async event => {
      // Stop servers for removed folders
      for (const folder of event.removed) {
        await stopLanguageServerForFolder(folder)
      }
      // Start servers for added folders
      for (const folder of event.added) {
        await startLanguageServerForFolder(folder)
      }
    })
  ]
}

export enum BundleStatus {
  valid = 0,
  missing = 1,
  errored = 2
}

export enum StandardBundleStatus {
  included = 0,
  excluded = 1,
  errored = 2
}

async function displayBundlerError (e: ExecError, folder: WorkspaceFolder): Promise<void> {
  e.log()
  log(`Failed to invoke Bundler in workspace folder "${folder.name}". After resolving the issue, run the command \`Standard Ruby: Start Language Server\``)
  if (getConfig<string>('mode') !== 'enableUnconditionally') {
    await displayError(`Failed to run Bundler in "${folder.name}" while initializing Standard Ruby`, ['Show Output'])
  }
}

async function isValidBundlerProject (folder: WorkspaceFolder): Promise<BundleStatus> {
  try {
    await promiseExec('bundle list --name-only', { cwd: folder.uri.fsPath })
    return BundleStatus.valid
  } catch (e) {
    if (!(e instanceof ExecError)) return BundleStatus.errored

    if (e.stderr.startsWith('Could not locate Gemfile')) {
      log(`No Gemfile found in workspace folder "${folder.name}"`)
      return BundleStatus.missing
    } else {
      await displayBundlerError(e, folder)
      return BundleStatus.errored
    }
  }
}

async function isInBundle (folder: WorkspaceFolder): Promise<StandardBundleStatus> {
  try {
    await promiseExec('bundle show standard', { cwd: folder.uri.fsPath })
    return StandardBundleStatus.included
  } catch (e) {
    if (!(e instanceof ExecError)) return StandardBundleStatus.errored

    if (e.stderr.startsWith('Could not locate Gemfile') || e.stderr === 'Could not find gem \'standard\'.') {
      return StandardBundleStatus.excluded
    } else {
      await displayBundlerError(e, folder)
      return StandardBundleStatus.errored
    }
  }
}

async function shouldEnableIfBundleIncludesStandard (folder: WorkspaceFolder): Promise<boolean> {
  const standardStatus = await isInBundle(folder)
  if (standardStatus === StandardBundleStatus.excluded) {
    log(`Skipping workspace folder "${folder.name}" - standard gem not in bundle`)
  }
  return standardStatus === StandardBundleStatus.included
}

async function shouldEnableForFolder (folder: WorkspaceFolder): Promise<boolean> {
  let bundleStatus
  switch (getConfig<string>('mode')) {
    case 'enableUnconditionally':
      return true
    case 'enableViaGemfileOrMissingGemfile':
      bundleStatus = await isValidBundlerProject(folder)
      if (bundleStatus === BundleStatus.valid) {
        return await shouldEnableIfBundleIncludesStandard(folder)
      } else {
        return bundleStatus === BundleStatus.missing
      }
    case 'enableViaGemfile':
      return await shouldEnableIfBundleIncludesStandard(folder)
    case 'onlyRunGlobally':
      return true
    case 'disable':
      return false
    default:
      log('Invalid value for standardRuby.mode')
      return false
  }
}

function hasCustomizedCommandPath (): boolean {
  const customCommandPath = getConfig<string>('commandPath')
  return customCommandPath != null && customCommandPath.length > 0
}

const variablePattern = /\$\{([^}]*)\}/
function resolveCommandPath (folder: WorkspaceFolder): string {
  let customCommandPath = getConfig<string>('commandPath') ?? ''

  for (let match = variablePattern.exec(customCommandPath); match != null; match = variablePattern.exec(customCommandPath)) {
    switch (match[1]) {
      case 'cwd':
        customCommandPath = customCommandPath.replace(match[0], folder.uri.fsPath)
        break
      case 'pathSeparator':
        customCommandPath = customCommandPath.replace(match[0], path.sep)
        break
      case 'userHome':
        customCommandPath = customCommandPath.replace(match[0], homedir())
        break
    }
  }

  return customCommandPath
}

async function getCommand (folder: WorkspaceFolder): Promise<string> {
  if (hasCustomizedCommandPath()) {
    return resolveCommandPath(folder)
  } else if (getConfig<string>('mode') !== 'onlyRunGlobally' && await isInBundle(folder) === StandardBundleStatus.included) {
    return 'bundle exec standardrb'
  } else {
    return 'standardrb'
  }
}

const requiredGemVersion = '>= 1.24.3'
async function supportedVersionOfStandard (command: string, folder: WorkspaceFolder): Promise<boolean> {
  try {
    const { stdout } = await promiseExec(`${command} -v`, { cwd: folder.uri.fsPath })
    const version = stdout.trim()
    if (satisfies(version, requiredGemVersion)) {
      return true
    } else {
      log(`Disabling for "${folder.name}" - unsupported standard version.`)
      log(`  Version reported by \`${command} -v\`: ${version} (${requiredGemVersion} required)`)
      await displayError(`Unsupported standard version in "${folder.name}": ${version} (${requiredGemVersion} required)`, ['Show Output'])
      return false
    }
  } catch (e) {
    if (e instanceof ExecError) e.log()
    log(`Failed to verify the version of standard in "${folder.name}", proceeding anyway…`)
    return true
  }
}

async function buildExecutable (folder: WorkspaceFolder): Promise<Executable | undefined> {
  const command = await getCommand(folder)
  if (command == null) {
    await displayError(`Could not find Standard Ruby executable for "${folder.name}"`, ['Show Output', 'View Settings'])
  } else if (await supportedVersionOfStandard(command, folder)) {
    const [exe, ...args] = (command).split(' ')
    return {
      command: exe,
      args: args.concat('--lsp'),
      options: {
        cwd: folder.uri.fsPath
      }
    }
  }
}

function buildLanguageClientOptions (folder: WorkspaceFolder): LanguageClientOptions {
  const diagnosticCache = getDiagnosticCache(folder)

  return {
    documentSelector: [
      { scheme: 'file', language: 'ruby', pattern: `${folder.uri.fsPath}/**/*` },
      { scheme: 'file', pattern: `${folder.uri.fsPath}/**/Gemfile` }
    ],
    diagnosticCollectionName: `standardRuby-${folder.name}`,
    workspaceFolder: folder,
    initializationFailedHandler: (error) => {
      log(`Language server initialization failed for "${folder.name}": ${String(error)}`)
      return false
    },
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    outputChannel,
    synchronize: {
      fileEvents: [
        workspace.createFileSystemWatcher(`${folder.uri.fsPath}/**/.standard.yml`),
        workspace.createFileSystemWatcher(`${folder.uri.fsPath}/**/.standard_todo.yml`),
        workspace.createFileSystemWatcher(`${folder.uri.fsPath}/**/Gemfile.lock`)
      ]
    },
    middleware: {
      provideDocumentFormattingEdits: (document, options, token, next): ProviderResult<TextEdit[]> => {
        if (getConfig<boolean>('autofix') ?? true) {
          return next(document, options, token)
        }
      },
      handleDiagnostics: (uri, diagnostics, next) => {
        diagnosticCache.set(uri.toString(), diagnostics)
        updateStatusBar()
        next(uri, diagnostics)
      }
    }
  }
}

async function createLanguageClient (folder: WorkspaceFolder): Promise<LanguageClient | null> {
  const run = await buildExecutable(folder)
  if (run != null) {
    log(`Starting language server for "${folder.name}": ${run.command} ${run.args?.join(' ') ?? ''} (cwd: ${folder.uri.fsPath})`)
    return new LanguageClient(
      `Standard Ruby (${folder.name})`,
      { run, debug: run },
      buildLanguageClientOptions(folder)
    )
  } else {
    return null
  }
}

async function displayError (message: string, actions: string[]): Promise<void> {
  const action = await window.showErrorMessage(message, ...actions)
  switch (action) {
    case 'Restart':
      await restartAllLanguageServers()
      break
    case 'Show Output':
      outputChannel?.show()
      break
    case 'View Settings':
      await commands.executeCommand('workbench.action.openSettings', 'standardRuby')
      break
    default:
      if (action != null) log(`Unknown action: ${action}`)
  }
}

async function syncOpenDocumentsWithLanguageServer (client: LanguageClient, folder: WorkspaceFolder): Promise<void> {
  for (const textDocument of workspace.textDocuments) {
    if (supportedLanguage(textDocument.languageId)) {
      const docFolder = getWorkspaceFolderForDocument(textDocument)
      if (docFolder != null && getFolderKey(docFolder) === getFolderKey(folder)) {
        await client.sendNotification(
          DidOpenTextDocumentNotification.type,
          client.code2ProtocolConverter.asOpenTextDocumentParams(textDocument)
        )
      }
    }
  }
}

async function handleActiveTextEditorChange (editor: TextEditor | undefined): Promise<void> {
  if (editor == null) {
    updateStatusBar()
    return
  }

  const client = getClientForDocument(editor.document)
  if (client == null) {
    updateStatusBar()
    return
  }

  const folder = getWorkspaceFolderForDocument(editor.document)
  if (folder == null) {
    updateStatusBar()
    return
  }

  const diagnosticCache = getDiagnosticCache(folder)
  if (supportedLanguage(editor.document.languageId) && !diagnosticCache.has(editor.document.uri.toString())) {
    await client.sendNotification(
      DidOpenTextDocumentNotification.type,
      client.code2ProtocolConverter.asOpenTextDocumentParams(editor.document)
    )
  }
  updateStatusBar()
}

async function afterStartLanguageServer (client: LanguageClient, folder: WorkspaceFolder): Promise<void> {
  diagnosticCaches.set(getFolderKey(folder), new Map())
  await syncOpenDocumentsWithLanguageServer(client, folder)
  updateStatusBar()
}

async function startLanguageServerForFolder (folder: WorkspaceFolder): Promise<void> {
  const key = getFolderKey(folder)

  // Already running for this folder
  if (languageClients.has(key)) return

  // Check if we should enable for this folder
  if (!(await shouldEnableForFolder(folder))) {
    log(`Skipping workspace folder "${folder.name}" - extension disabled or not applicable`)
    return
  }

  try {
    const client = await createLanguageClient(folder)
    if (client != null) {
      languageClients.set(key, client)
      await client.start()
      await afterStartLanguageServer(client, folder)
      log(`Language server started for "${folder.name}"`)
    }
  } catch (error) {
    languageClients.delete(key)
    log(`Failed to start language server for "${folder.name}": ${String(error)}`)
    await displayError(
      `Failed to start Standard Ruby Language Server for "${folder.name}"`, ['Restart', 'Show Output']
    )
  }
}

async function stopLanguageServerForFolder (folder: WorkspaceFolder): Promise<void> {
  const key = getFolderKey(folder)
  const client = languageClients.get(key)

  if (client == null) return

  log(`Stopping language server for "${folder.name}"...`)
  await client.stop()
  languageClients.delete(key)
  diagnosticCaches.delete(key)
}

async function startAllLanguageServers (): Promise<void> {
  const folders = workspace.workspaceFolders ?? []
  for (const folder of folders) {
    await startLanguageServerForFolder(folder)
  }
}

async function stopAllLanguageServers (): Promise<void> {
  log('Stopping all language servers...')
  for (const [key, client] of languageClients) {
    await client.stop()
    languageClients.delete(key)
  }
  diagnosticCaches.clear()
}

async function restartAllLanguageServers (): Promise<void> {
  log('Restarting all language servers...')
  await stopAllLanguageServers()
  await startAllLanguageServers()
}

// Legacy function names for backward compatibility
async function startLanguageServer (): Promise<void> {
  await startAllLanguageServers()
}

async function stopLanguageServer (): Promise<void> {
  await stopAllLanguageServers()
}

async function restartLanguageServer (): Promise<void> {
  await restartAllLanguageServers()
}

async function formatAutoFixes (): Promise<void> {
  const editor = window.activeTextEditor
  if (editor == null || !supportedLanguage(editor.document.languageId)) return

  const client = getClientForDocument(editor.document)
  if (client == null) return

  try {
    await client.sendRequest(ExecuteCommandRequest.type, {
      command: 'standardRuby.formatAutoFixes',
      arguments: [{
        uri: editor.document.uri.toString(),
        version: editor.document.version
      }]
    })
  } catch (e) {
    await displayError(
      'Failed to apply Standard Ruby fixes to the document.', ['Show Output']
    )
  }
}

function createStatusBarItem (): StatusBarItem {
  const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 0)
  statusBarItem.command = 'workbench.action.problems.focus'
  return statusBarItem
}

function updateStatusBar (): void {
  if (statusBarItem == null) return
  const editor = window.activeTextEditor

  if (editor == null || !supportedLanguage(editor.document.languageId)) {
    statusBarItem.hide()
    return
  }

  const folder = getWorkspaceFolderForDocument(editor.document)
  const client = folder != null ? languageClients.get(getFolderKey(folder)) : undefined

  if (client == null) {
    statusBarItem.hide()
    return
  }

  const diagnosticCache = folder != null ? getDiagnosticCache(folder) : undefined
  const diagnostics = diagnosticCache?.get(editor.document.uri.toString())

  if (diagnostics == null) {
    statusBarItem.tooltip = 'Standard Ruby'
    statusBarItem.text = 'Standard $(ruby)'
    statusBarItem.color = undefined
    statusBarItem.backgroundColor = undefined
  } else {
    const errorCount = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error).length
    const warningCount = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Warning).length
    const otherCount = diagnostics.filter((d) =>
      d.severity === DiagnosticSeverity.Information ||
        d.severity === DiagnosticSeverity.Hint
    ).length
    if (errorCount > 0) {
      statusBarItem.tooltip = `Standard Ruby: ${errorCount === 1 ? '1 error' : `${errorCount} errors`}`
      statusBarItem.text = 'Standard $(error)'
      statusBarItem.backgroundColor = new ThemeColor('statusBarItem.errorBackground')
    } else if (warningCount > 0) {
      statusBarItem.tooltip = `Standard Ruby: ${warningCount === 1 ? '1 warning' : `${warningCount} warnings`}`
      statusBarItem.text = 'Standard $(warning)'
      statusBarItem.backgroundColor = new ThemeColor('statusBarItem.warningBackground')
    } else if (otherCount > 0) {
      statusBarItem.tooltip = `Standard Ruby: ${otherCount === 1 ? '1 hint' : `${otherCount} issues`}`
      statusBarItem.text = 'Standard $(info)'
      statusBarItem.backgroundColor = undefined
    } else {
      statusBarItem.tooltip = 'Standard Ruby: No issues!'
      statusBarItem.text = 'Standard $(ruby)'
      statusBarItem.backgroundColor = undefined
    }
  }
  statusBarItem.show()
}

export async function activate (context: ExtensionContext): Promise<void> {
  outputChannel = window.createOutputChannel('Standard Ruby')
  statusBarItem = createStatusBarItem()
  window.onDidChangeActiveTextEditor(handleActiveTextEditorChange)
  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    ...registerCommands(),
    ...registerWorkspaceListeners()
  )

  log('Activating Standard Ruby extension with multi-root workspace support')
  await startAllLanguageServers()
}

export async function deactivate (): Promise<void> {
  await stopAllLanguageServers()
}
