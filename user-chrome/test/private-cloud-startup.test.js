const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('failed proxy initialization exits before creating any browser window', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'supplied-chrome-startup-'))
  fs.writeFileSync(path.join(directory, 'network-settings.json'), JSON.stringify({ 'network-config': { mode: 'direct' } }))
  const originalLoad = Module._load
  let windows = 0, exitCode
  const switches = []
  class Window {
    constructor() { windows++ }
    setContentProtection() {}
    once() {}
    show() {}
    loadFile() {}
    on() {}
    setBrowserView() {}
    getContentSize() { return [1280, 820] }
    webContents = { send() {}, once(_event, callback) { callback() } }
    static getAllWindows() { return [] }
  }
  class View {
    constructor() { this.webContents = { canGoBack: () => false, canGoForward: () => false, setWindowOpenHandler() {}, on() {}, loadURL() {}, close() {}, stop() {} } }
    setBounds() {}
  }
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return {
      app: { commandLine: { appendSwitch: (...args) => switches.push(args) }, whenReady: () => Promise.resolve(), on() {}, quit() {}, exit: code => { exitCode = code }, getPath: () => directory },
      BrowserWindow: Window, BrowserView: View,
      Menu: { buildFromTemplate: value => value, setApplicationMenu() {} },
      ipcMain: { handle() {}, on() {} }, safeStorage: {},
      session: { defaultSession: { setProxy: async () => { throw new Error('proxy configuration rejected') }, closeAllConnections: async () => {}, webRequest: {}, setPermissionRequestHandler() {}, on() {} } }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    const main = require('../main')
    await assert.rejects(main.ready)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(windows, 0)
    assert.equal(exitCode, 1)
    assert.ok(!switches.some(([name]) => name.includes('ignore-certificate-errors')))
  } finally { Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }) }
})
