const assert = require('node:assert/strict')
const test = require('node:test')
const { EVENTOS_REAPLICAR, protegerJanela, protegerTodasAsJanelas } = require('../window-protection')

function janelaFalsa() {
  const ouvintes = new Map()
  const wcOuvintes = new Map()
  const janela = {
    chamadas: [],
    protecoes: 0,
    devtoolsFechado: 0,
    setContentProtection(valor) { this.protecoes++; this.chamadas.push(['protect', valor]) },
    show() { this.chamadas.push(['show']) },
    on(evento, fn) { ouvintes.set(evento, [...(ouvintes.get(evento) || []), fn]) },
    once(evento, fn) { this.on(evento, fn) },
    emit(evento) { for (const fn of ouvintes.get(evento) || []) fn() },
    isDestroyed: () => false,
    webContents: {
      on(evento, fn) { wcOuvintes.set(evento, fn) },
      closeDevTools() { janela.devtoolsFechado++ },
      emit(evento) { wcOuvintes.get(evento)?.() }
    }
  }
  return janela
}

test('aplica a proteção antes de exibir a janela', () => {
  const janela = janelaFalsa()
  protegerJanela(janela)
  assert.deepEqual(janela.chamadas, [['protect', true]])
  janela.emit('ready-to-show')
  assert.deepEqual(janela.chamadas.slice(-2), [['protect', true], ['show']])
})

test('reaplica a proteção após minimizar, maximizar e tela cheia', () => {
  const janela = janelaFalsa()
  protegerJanela(janela)
  for (const evento of EVENTOS_REAPLICAR) janela.emit(evento)
  assert.equal(janela.protecoes, 1 + EVENTOS_REAPLICAR.length)
})

test('não registra a mesma janela duas vezes e fecha DevTools', () => {
  const janela = janelaFalsa()
  protegerJanela(janela)
  protegerJanela(janela)
  janela.emit('restore')
  assert.equal(janela.protecoes, 3)
  janela.webContents.emit('devtools-opened')
  assert.equal(janela.devtoolsFechado, 1)
})

test('exibe a janela mesmo se ela já foi protegida por browser-window-created', () => {
  const janela = janelaFalsa()
  protegerJanela(janela, { exibir: false })
  protegerJanela(janela)
  janela.emit('ready-to-show')
  assert.deepEqual(janela.chamadas.at(-1), ['show'])
  janela.emit('restore')
  assert.equal(janela.chamadas.filter(([c]) => c === 'protect').length, 4)
})

test('protege qualquer janela criada pelo aplicativo', () => {
  let ouvinte
  protegerTodasAsJanelas({ on: (evento, fn) => { assert.equal(evento, 'browser-window-created'); ouvinte = fn } })
  const janela = janelaFalsa()
  ouvinte({}, janela)
  assert.deepEqual(janela.chamadas, [['protect', true]])
})
