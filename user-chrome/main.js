const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { app, BrowserWindow, BrowserView, Menu, ipcMain, safeStorage, session, shell } = require('electron')
const { PrivateCloudNetworkManager, PrivateCloudDiagnostics, bridgePort } = require('./network/private-cloud-proxy')
const { BrowserStore } = require('./browser/browser-store')
const { TabManager } = require('./browser/tab-manager')
const { protegerJanela, protegerTodasAsJanelas } = require('./window-protection')

// Keep all navigation on the existing TCP proxy, including WebRTC policy.
app.commandLine.appendSwitch('disable-quic')
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')
app.commandLine.appendSwitch('dns-prefetch-disable')

protegerTodasAsJanelas(app)

const browsers = new Map()

function focusedBrowser() {
  const focused = BrowserWindow.getFocusedWindow()
  return [...browsers.values()].find(browser => browser.window === focused) || browsers.values().next().value
}

function browserAction(action) {
  const browser = focusedBrowser()
  if (!browser) return
  if (action === 'new') {
    browser.tabs.createTab()
    browser.window.webContents.focus()
    browser.window.webContents.send('browser:action', 'focus-address')
  }
  else if (action === 'close') browser.tabs.closeTab(browser.tabs.activeId)
  else if (action === 'focus-address') {
    browser.window.webContents.focus()
    browser.window.webContents.send('browser:action', action)
  } else if (['history', 'downloads', 'favorites'].includes(action)) {
    browser.tabs.setPanel(browser.tabs.panel === action ? null : action)
  } else if (action === 'favorite') {
    const tab = browser.tabs.activeTab
    if (tab) browser.tabs.store.toggleFavorite(tab.url, tab.title)
  } else browser.tabs.command(action)
}

function installBrowserHandlers(store) {
  const handle = (channel, handler) => ipcMain.handle(`browser:${channel}`, (event, ...args) => {
    const browser = browsers.get(event.sender)
    if (!browser || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) throw new Error('Origem não autorizada.')
    return handler(browser.tabs, ...args)
  })
  handle('state', tabs => tabs.snapshot())
  handle('new-tab', (tabs, url) => tabs.createTab(url))
  handle('activate', (tabs, id) => tabs.activateTab(id))
  handle('close', (tabs, id) => tabs.closeTab(id))
  handle('navigate', (tabs, url) => tabs.navigate(url))
  handle('command', (tabs, command) => tabs.command(command))
  handle('panel', (tabs, panel) => tabs.setPanel(panel))
  handle('favorite', tabs => {
    const tab = tabs.activeTab
    if (tab) store.toggleFavorite(tab.url, tab.title)
  })
  handle('network-settings', () => { criarJanelaConfiguracoes(); return true })
  handle('show-download', (_tabs, id) => {
    const download = store.getSnapshot().downloads.find(item => item.id === id)
    if (!download || download.state !== 'completed' || !download.path || !fs.existsSync(download.path)) {
      throw new Error('O arquivo não está disponível na pasta de downloads.')
    }
    shell.showItemInFolder(download.path)
    return true
  })
}

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath
  }

  get(key) {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'))[key]
    } catch {
      return undefined
    }
  }

  set(key, value) {
    let data = {}
    try { data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) } catch {}
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify({ ...data, [key]: value }), { encoding: 'utf8', mode: 0o600 })
  }
}

function chromiumFetch(browserSession) {
  return async (target, timeoutMs) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      if (typeof browserSession.fetch !== 'function') throw new Error('A sessao Chromium nao oferece fetch para diagnostico.')
      return await browserSession.fetch(target, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

function criarNavegador(store) {
  const minhaJanela = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 780,
    minHeight: 560,
    title: 'Chrome Protegido',
    show: false,
    backgroundColor: '#f4f6fb',
    autoHideMenuBar: false,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload-browser-shell.js') }
  })
  protegerJanela(minhaJanela)
  minhaJanela.loadFile(path.join(__dirname, 'renderer', 'browser-shell.html'))
  const tabs = new TabManager({ BrowserView, window: minhaJanela, store, notify: state => minhaJanela.webContents.send('browser:state', state) })
  browsers.set(minhaJanela.webContents, { tabs, window: minhaJanela })
  const update = () => tabs.emit()
  store.on('change', update)
  minhaJanela.on('close', () => {
    store.off('change', update)
    browsers.delete(minhaJanela.webContents)
    tabs.dispose()
  })
  minhaJanela.on('resize', () => tabs.layout())
  minhaJanela.webContents.once('did-finish-load', () => tabs.createTab())
  return minhaJanela
}

function criarJanelaConfiguracoes() {
  const janela = new BrowserWindow({
    width: 760,
    height: 820,
    title: 'Configurações de rede',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-network-settings.js')
    }
  })
  protegerJanela(janela)
  janela.loadFile(path.join(__dirname, 'renderer', 'network-settings.html'))
  return janela
}

function criarAplicacao() {
  const browserSession = session.defaultSession
  const store = new JsonStore(path.join(app.getPath('userData'), 'network-settings.json'))
  const browserStore = new BrowserStore(store)
  installBrowserHandlers(browserStore)
  const diagnostics = new PrivateCloudDiagnostics({ chromiumFetch: chromiumFetch(browserSession) })
  const manager = new PrivateCloudNetworkManager({ session: browserSession, storage: store, secureStorage: safeStorage, diagnostics, port: bridgePort(process.env.PCP_PROXY_PORT) })
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserSession.on('will-download', (_event, item) => {
    const id = randomUUID()
    let lastUpdate = 0
    const progress = state => ({ state, path: item.getSavePath(), receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() })
    browserStore.recordDownload({ id, filename: item.getFilename(), startedAt: new Date().toISOString(), ...progress('started') })
    item.on('updated', (_event, state) => {
      if (Date.now() - lastUpdate < 500 && state === 'progressing') return
      lastUpdate = Date.now()
      browserStore.updateDownload(id, progress(state))
    })
    item.once('done', (_event, state) => {
      browserStore.updateDownload(id, { ...progress(state), finishedAt: new Date().toISOString() })
    })
  })

  ipcMain.handle('network:get-state', () => manager.getPublicState())
  ipcMain.handle('network:apply', (_event, config) => manager.apply(config))
  ipcMain.on('network:save-on-close', (_event, config) => {
    manager.apply(config).catch(error => manager.recordEvent({ type: 'configuration-save-error', error: error.message }))
  })
  ipcMain.handle('network:diagnose', (_event, target) => manager.diagnose(target))
  app.on('login', (event, _webContents, request, authInfo, callback) => manager.handleLogin(event, request, authInfo, callback))

  const menu = Menu.buildFromTemplate([
    { label: 'Navegador', submenu: [
      { label: 'Nova aba', accelerator: 'CmdOrCtrl+T', click: () => browserAction('new') },
      { label: 'Fechar aba', accelerator: 'CmdOrCtrl+W', click: () => browserAction('close') },
      { label: 'Reabrir aba fechada', accelerator: 'CmdOrCtrl+Shift+T', click: () => browserAction('reopen') },
      { type: 'separator' },
      { label: 'Próxima aba', accelerator: 'Ctrl+Tab', click: () => browserAction('next') },
      { label: 'Aba anterior', accelerator: 'Ctrl+Shift+Tab', click: () => browserAction('previous') },
      { label: 'Barra de endereço', accelerator: 'CmdOrCtrl+L', click: () => browserAction('focus-address') },
      { type: 'separator' },
      { label: 'Voltar', accelerator: 'Alt+Left', click: () => browserAction('back') },
      { label: 'Avançar', accelerator: 'Alt+Right', click: () => browserAction('forward') },
      { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: () => browserAction('reload') },
      { label: 'Recarregar página', accelerator: 'F5', click: () => browserAction('reload') },
      { label: 'Página inicial', accelerator: 'Alt+Home', click: () => browserAction('home') },
      { type: 'separator' }, { role: 'quit', label: 'Sair' }
    ] },
    { label: 'Editar', submenu: [
      { role: 'undo', label: 'Desfazer' }, { role: 'redo', label: 'Refazer' }, { type: 'separator' },
      { role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' },
      { role: 'paste', label: 'Colar' }, { role: 'selectAll', label: 'Selecionar tudo' }
    ] },
    { label: 'Biblioteca', submenu: [
      { label: 'Adicionar ou remover favorito', accelerator: 'CmdOrCtrl+D', click: () => browserAction('favorite') },
      { label: 'Favoritos', accelerator: 'CmdOrCtrl+Shift+O', click: () => browserAction('favorites') },
      { label: 'Histórico', accelerator: 'CmdOrCtrl+H', click: () => browserAction('history') },
      { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => browserAction('downloads') }
    ] },
    { label: 'Rede', submenu: [{ label: 'Configurações de rede…', click: criarJanelaConfiguracoes }] }
  ])
  Menu.setApplicationMenu(menu)
  return manager.restore().catch(error => {
    manager.recordEvent({ type: 'configuration-restore-error', error: 'PRIVATE_PROXY_INIT_FAILED' })
    throw error
  }).then(() => ({ manager, store: browserStore }))
}

const ready = app.whenReady().then(async () => {
  const { store } = await criarAplicacao()
  const window = criarNavegador(store)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) criarNavegador(store)
  })
  return window
})

ready.catch(() => {
  console.error('[PRIVATE_PROXY_INIT_FAILED] Nao foi possivel aplicar a conexao gerenciada.')
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

module.exports = { JsonStore, chromiumFetch, criarAplicacao, criarJanelaConfiguracoes, criarNavegador, ready }
