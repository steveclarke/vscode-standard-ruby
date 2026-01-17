import * as assert from 'assert'
import { Uri } from 'vscode'
import { ClientManager, ClientManagerOptions, normalizePathForGlob } from '../../clientManager'

// Mock WorkspaceFolder
function createMockFolder (name: string, fsPath: string): any {
  return {
    name,
    uri: Uri.file(fsPath),
    index: 0
  }
}

// Mock LanguageClient
function createMockClient (): any {
  return {
    start: async () => {},
    stop: async () => {},
    sendNotification: async () => {},
    code2ProtocolConverter: {
      asOpenTextDocumentParams: (doc: any) => ({ textDocument: { uri: doc.uri.toString() } })
    }
  }
}

// Mock TextDocument
function createMockDocument (uri: string, languageId: string = 'ruby'): any {
  return {
    uri: Uri.parse(uri),
    languageId
  }
}

suite('ClientManager', () => {
  suite('normalizePathForGlob', () => {
    test('converts Windows backslashes to forward slashes', async () => {
      assert.strictEqual(
        normalizePathForGlob('C:\\Users\\dev\\project'),
        'C:/Users/dev/project'
      )
    })

    test('leaves Unix paths unchanged', async () => {
      assert.strictEqual(
        normalizePathForGlob('/Users/dev/project'),
        '/Users/dev/project'
      )
    })

    test('handles mixed separators', async () => {
      assert.strictEqual(
        normalizePathForGlob('C:\\Users/dev\\project'),
        'C:/Users/dev/project'
      )
    })
  })

  suite('client lifecycle', () => {
    test('startForFolder creates a client for the folder', async () => {
      const folder = createMockFolder('my-app', '/workspace/my-app')
      const mockClient = createMockClient()
      let clientCreated = false

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => {
          clientCreated = true
          return mockClient
        },
        shouldEnableForFolder: async () => true,
        onError: async () => {},
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)
      await manager.startForFolder(folder)

      assert.strictEqual(clientCreated, true)
      assert.strictEqual(manager.size, 1)
    })

    test('startForFolder skips when shouldEnableForFolder returns false', async () => {
      const folder = createMockFolder('my-app', '/workspace/my-app')
      let clientCreated = false

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => {
          clientCreated = true
          return createMockClient()
        },
        shouldEnableForFolder: async () => false,
        onError: async () => {},
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)
      await manager.startForFolder(folder)

      assert.strictEqual(clientCreated, false)
      assert.strictEqual(manager.size, 0)
    })

    test('startForFolder does not create duplicate clients', async () => {
      const folder = createMockFolder('my-app', '/workspace/my-app')
      let createCount = 0

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => {
          createCount++
          return createMockClient()
        },
        shouldEnableForFolder: async () => true,
        onError: async () => {},
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)
      await manager.startForFolder(folder)
      await manager.startForFolder(folder)

      assert.strictEqual(createCount, 1)
      assert.strictEqual(manager.size, 1)
    })

    test('stopForFolder removes the client', async () => {
      const folder = createMockFolder('my-app', '/workspace/my-app')
      let stopCalled = false
      const mockClient = {
        ...createMockClient(),
        stop: async () => { stopCalled = true }
      }

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => mockClient,
        shouldEnableForFolder: async () => true,
        onError: async () => {},
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)
      await manager.startForFolder(folder)
      assert.strictEqual(manager.size, 1)

      await manager.stopForFolder(folder)
      assert.strictEqual(stopCalled, true)
      assert.strictEqual(manager.size, 0)
    })
  })

  suite('race condition prevention', () => {
    test('concurrent startForFolder calls only create one client', async () => {
      const folder = createMockFolder('my-app', '/workspace/my-app')
      let createCount = 0

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => {
          createCount++
          // Simulate some async work
          await new Promise(resolve => setTimeout(resolve, 10))
          return createMockClient()
        },
        shouldEnableForFolder: async () => true,
        onError: async () => {},
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)

      // Start two concurrent calls
      await Promise.all([
        manager.startForFolder(folder),
        manager.startForFolder(folder)
      ])

      assert.strictEqual(createCount, 1)
      assert.strictEqual(manager.size, 1)
    })
  })

  suite('multiple folders', () => {
    test('manages separate clients for different folders', async () => {
      const folder1 = createMockFolder('rails-app', '/workspace/rails-app')
      const folder2 = createMockFolder('cli-tool', '/workspace/cli-tool')
      const clients: any[] = []

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => {
          const client = createMockClient()
          clients.push(client)
          return client
        },
        shouldEnableForFolder: async () => true,
        onError: async () => {},
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)
      await manager.startForFolder(folder1)
      await manager.startForFolder(folder2)

      assert.strictEqual(manager.size, 2)
      assert.strictEqual(clients.length, 2)
    })

    test('stopAll stops all clients', async () => {
      const folder1 = createMockFolder('rails-app', '/workspace/rails-app')
      const folder2 = createMockFolder('cli-tool', '/workspace/cli-tool')
      let stopCount = 0

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => ({
          ...createMockClient(),
          stop: async () => { stopCount++ }
        }),
        shouldEnableForFolder: async () => true,
        onError: async () => {},
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)
      await manager.startForFolder(folder1)
      await manager.startForFolder(folder2)
      assert.strictEqual(manager.size, 2)

      await manager.stopAll()
      assert.strictEqual(stopCount, 2)
      assert.strictEqual(manager.size, 0)
    })
  })

  suite('diagnostic cache', () => {
    test('getDiagnosticCacheForFolder returns consistent cache', async () => {
      const folder = createMockFolder('my-app', '/workspace/my-app')

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => createMockClient(),
        shouldEnableForFolder: async () => true,
        onError: async () => {},
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)
      const cache1 = manager.getDiagnosticCacheForFolder(folder)
      const cache2 = manager.getDiagnosticCacheForFolder(folder)

      assert.strictEqual(cache1, cache2)
    })
  })

  suite('watcher cleanup', () => {
    test('stopForFolder disposes watchers', async () => {
      const folder = createMockFolder('my-app', '/workspace/my-app')
      let watcherDisposed = false

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => createMockClient(),
        shouldEnableForFolder: async () => true,
        onError: async () => {},
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)
      await manager.startForFolder(folder)

      // Register a mock watcher
      manager.registerWatchers(folder, [{
        dispose: () => { watcherDisposed = true }
      }])

      await manager.stopForFolder(folder)
      assert.strictEqual(watcherDisposed, true)
    })
  })

  suite('error handling', () => {
    test('startForFolder calls onError when client creation fails', async () => {
      const folder = createMockFolder('my-app', '/workspace/my-app')
      let errorCalled = false
      let errorMessage = ''

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => {
          throw new Error('Connection failed')
        },
        shouldEnableForFolder: async () => true,
        onError: async (message) => {
          errorCalled = true
          errorMessage = message
        },
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)
      await manager.startForFolder(folder)

      assert.strictEqual(errorCalled, true)
      assert.ok(errorMessage.includes('my-app'))
      assert.strictEqual(manager.size, 0)
    })

    test('startForFolder cleans up on failure', async () => {
      const folder = createMockFolder('my-app', '/workspace/my-app')
      let watcherDisposed = false

      const options: ClientManagerOptions = {
        log: () => {},
        createClient: async () => {
          throw new Error('Connection failed')
        },
        shouldEnableForFolder: async () => true,
        onError: async () => {},
        onStatusUpdate: () => {},
        supportedLanguage: (id) => id === 'ruby'
      }

      const manager = new ClientManager(options)

      // Pre-register watchers (simulating partial setup before failure)
      manager.registerWatchers(folder, [{
        dispose: () => { watcherDisposed = true }
      }])

      await manager.startForFolder(folder)

      assert.strictEqual(watcherDisposed, true)
      assert.strictEqual(manager.size, 0)
    })
  })
})
