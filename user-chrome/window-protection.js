// Proteção de captura de tela do Windows (SetWindowDisplayAffinity com
// WDA_EXCLUDEFROMCAPTURE, Windows 10 2004+). O Electron expõe essa API por
// BrowserWindow.setContentProtection(true). Capturas por PrintScreen, Ferramenta
// de Captura, Xbox Game Bar e APIs de captura compatíveis passam a mostrar a
// janela em preto/transparente. Não protege contra fotografias, drivers ou
// capturadores com acesso privilegiado.

// Eventos após os quais o Windows/Electron pode recriar ou reexibir a janela
// nativa; a afinidade é reaplicada para que a proteção não se perca.
const EVENTOS_REAPLICAR = ['show', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus']

const protegidas = new WeakSet()

function aplicar(janela) {
  if (!janela || (typeof janela.isDestroyed === 'function' && janela.isDestroyed())) return
  janela.setContentProtection(true)
}

// Deve ser chamada logo após criar a janela, que precisa ter sido criada com
// show: false; ela só é exibida depois que a proteção está ativa.
function protegerJanela(janela, { exibir = true } = {}) {
  aplicar(janela)
  if (!protegidas.has(janela)) {
    protegidas.add(janela)
    for (const evento of EVENTOS_REAPLICAR) janela.on(evento, () => aplicar(janela))

    // DevTools abre em janela própria, fora da proteção: bloqueado.
    const wc = janela.webContents
    if (wc && typeof wc.on === 'function') {
      wc.on('devtools-opened', () => wc.closeDevTools())
    }
  }

  // Independe do registro acima: 'browser-window-created' protege a janela
  // dentro do construtor, antes de main.js pedir para exibi-la.
  if (exibir && typeof janela.once === 'function') {
    janela.once('ready-to-show', () => {
      aplicar(janela)
      janela.show()
    })
  }
  return janela
}

// Rede de segurança: qualquer outra janela criada pelo app também é protegida.
function protegerTodasAsJanelas(app) {
  app.on('browser-window-created', (_event, janela) => protegerJanela(janela, { exibir: false }))
}

module.exports = { EVENTOS_REAPLICAR, protegerJanela, protegerTodasAsJanelas }
