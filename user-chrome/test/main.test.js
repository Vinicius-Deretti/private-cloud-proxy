const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

test('inicializa controles de rede na sessao Chromium e abre configuracoes isoladas', async () => {
  const browserWindowOptions = []
  const proxyCalls = []
  const previousPort = process.env.PCP_PROXY_PORT
  delete process.env.PCP_PROXY_PORT
  const handlers = new Map()
  const listeners = new Map()
  const windows = []
  const originalLoad = Module._load
  let menuTemplate

  class FakeBrowserWindow {
    constructor(options) { browserWindowOptions.push(options); windows.push(this) }
    setContentProtection() {}
    once() {}
    show() {}
    loadURL() {}
    loadFile() {}
    on() {}
    setBrowserView() {}
    getContentSize() { return [1280, 720] }
    webContents = { send() {}, once(_event, callback) { callback() } }
    static getAllWindows() { return [] }
  }

  const fakeSession = {
    setProxy: async config => { proxyCalls.push(config) },
    closeAllConnections: async () => {},
    webRequest: { onCompleted() {}, onErrorOccurred() {} },
    fetch: async () => ({ status: 204 }),
    setPermissionRequestHandler: () => {},
    on: () => {}
  }
  class FakeBrowserView {
    constructor() { this.webContents = { canGoBack: () => false, canGoForward: () => false, setWindowOpenHandler() {}, on() {}, loadURL() {}, close() {}, stop() {} } }
    setBounds() {}
  }

  Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { commandLine: { appendSwitch() {} }, whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getPath: () => path.join(__dirname, '.tmp-user-data') },
        BrowserWindow: FakeBrowserWindow,
        BrowserView: FakeBrowserView,
        Menu: { buildFromTemplate: template => { menuTemplate = template; return template }, setApplicationMenu: () => {} },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: (channel, listener) => listeners.set(channel, listener) },
        safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value) },
        session: { defaultSession: fakeSession }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    delete require.cache[require.resolve(path.join(__dirname, '..', 'main.js'))]
    require(path.join(__dirname, '..', 'main.js'))
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(proxyCalls, [{ mode: 'fixed_servers', proxyRules: 'http=127.0.0.1:17831;https=127.0.0.1:17831', proxyBypassRules: '<-loopback>' }])
    assert.equal(browserWindowOptions[0].skipTaskbar, true)
    assert.equal(browserWindowOptions[0].webPreferences.contextIsolation, true)
    assert.equal(handlers.has('network:get-state'), true)
    assert.equal(handlers.has('network:apply'), true)
    assert.equal(handlers.has('network:diagnose'), true)
    assert.equal(listeners.has('network:save-on-close'), true)

    assert.equal(handlers.has('browser:panel'), true)
    assert.equal(handlers.has('browser:show-download'), true)
    assert.throws(() => handlers.get('browser:state')({ sender: {} }), /origem/i)
    const trusted = { sender: windows[0].webContents }
    assert.equal(handlers.get('browser:state')(trusted).tabs[0].url, 'browser://newtab')
    handlers.get('browser:panel')(trusted, 'favorites')
    assert.equal(handlers.get('browser:state')(trusted).panel, 'favorites')
    assert.throws(() => handlers.get('browser:panel')(trusted, 'invalid'), /Painel/)

    const networkMenu = menuTemplate.find(item => item.label === 'Rede')
    networkMenu.submenu[0].click()
    const settingsOptions = browserWindowOptions.at(-1)
    assert.equal(settingsOptions.webPreferences.nodeIntegration, false)
    assert.equal(settingsOptions.webPreferences.contextIsolation, true)
    assert.match(settingsOptions.webPreferences.preload, /preload-network-settings\.js$/)
  } finally {
    Module._load = originalLoad
    if (previousPort === undefined) delete process.env.PCP_PROXY_PORT
    else process.env.PCP_PROXY_PORT = previousPort
  }
})
