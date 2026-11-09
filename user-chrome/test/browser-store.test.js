const assert = require('node:assert/strict')
const test = require('node:test')
const { normalizeAddress } = require('../browser/address')
const { BrowserStore } = require('../browser/browser-store')

test('normaliza URL HTTP e texto de busca', () => {
  assert.equal(normalizeAddress('https://example.com/a'), 'https://example.com/a')
  assert.equal(normalizeAddress('pesquisa segura'), 'https://www.google.com/search?q=pesquisa%20segura')
  assert.throws(() => normalizeAddress('javascript:alert(1)'), /HTTP/)
})

test('mantem favoritos e historico sem duplicar a mesma URL', () => {
  const data = new Map()
  const store = new BrowserStore(data)
  store.toggleFavorite('https://example.com', 'Exemplo')
  store.recordHistory('https://example.com', 'Exemplo')
  store.recordHistory('https://example.com', 'Novo titulo')
  assert.equal(store.getSnapshot().favorites.length, 1)
  assert.equal(store.getSnapshot().history.length, 1)
  assert.equal(store.getSnapshot().history[0].title, 'Novo titulo')
})

test('aceita endereco local, IP e porta sem transformar em busca', () => {
  assert.equal(normalizeAddress('localhost:8080/teste'), 'http://localhost:8080/teste')
  assert.equal(normalizeAddress('127.0.0.1:3000'), 'http://127.0.0.1:3000/')
  assert.equal(normalizeAddress('example.com:8443'), 'https://example.com:8443/')
  assert.equal(normalizeAddress(''), 'browser://newtab')
})

test('dados persistidos invalidos nao impedem abrir o navegador', () => {
  const store = new BrowserStore(new Map([['browser-data', { favorites: 'invalido', history: [null, { url: 'javascript:alert(1)' }], downloads: null }]]))
  assert.deepEqual(store.getSnapshot(), { favorites: [], history: [], downloads: [] })
})

test('downloads sao atualizados no mesmo registro e restaurados como interrompidos', () => {
  const data = new Map()
  const store = new BrowserStore(data)
  store.recordDownload({ id: 'download-1', filename: 'arquivo.zip', state: 'progressing' })
  store.updateDownload('download-1', { receivedBytes: 512, totalBytes: 1024 })
  assert.equal(store.getSnapshot().downloads.length, 1)
  assert.equal(store.getSnapshot().downloads[0].receivedBytes, 512)
  assert.equal(new BrowserStore(data).getSnapshot().downloads[0].state, 'interrupted')
  store.updateDownload('download-1', { state: 'completed' })
  assert.equal(new BrowserStore(data).getSnapshot().downloads[0].state, 'completed')
})

test('paginas internas nao viram favoritos', () => {
  const store = new BrowserStore(new Map())
  store.toggleFavorite('browser://newtab', 'Nova aba')
  assert.equal(store.getSnapshot().favorites.length, 0)
})

test('abre dominios internacionalizados digitados sem protocolo', () => {
  assert.equal(normalizeAddress('exemplo.empresa.br/caminho'), 'https://exemplo.empresa.br/caminho')
  assert.equal(normalizeAddress('café.com.br/cardápio'), 'https://xn--caf-dma.com.br/card%C3%A1pio')
  assert.equal(normalizeAddress('例え.テスト'), 'https://xn--r8jz45g.xn--zckzah/')
  assert.equal(normalizeAddress('pesquisa com espaços'), 'https://www.google.com/search?q=pesquisa%20com%20espa%C3%A7os')
})
