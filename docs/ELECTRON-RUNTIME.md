# user-chrome: Electron 31 (EOL) e BrowserView (deprecated) — relatório

Status: **investigação apenas, nada migrado.** Decisão pendente do mantenedor.
Legenda: **[lido]** = verificado no código deste repositório;
**[não verificado]** = depende de fonte externa ou do runtime do Drive, que não
está disponível localmente.

## Como o runtime chega ao usuário

- [lido] O release Windows é montado por `scripts/package-user-chrome.py` a partir
  do `main.zip` do Drive (`user-chrome/UPSTREAM.json`, SHA-256 e tamanho fixos).
- [lido] `verify_runtime()` exige que **todo** arquivo do runtime extraído, exceto
  `resources/app.asar`, tenha o mesmo SHA-256 do arquivo fornecido. Só o
  `app.asar` (nosso código JS) é substituído.
- [lido] `user-chrome/package.json` declara `electron: ^31.0.0` (local: 31.7.7) só
  para testes/integração. O binário que o usuário executa é o
  `ChromeProtegido.exe` do Drive. [não verificado] a versão exata do Electron
  dentro desse exe. Como medir: no app, `process.versions.electron`; ou
  `(Get-Item ChromeProtegido.exe).VersionInfo` no PowerShell.

## 1. Dá para atualizar a major do Electron sem trocar o arquivo do Drive?

**Não, com o pipeline atual.** A major do Electron é a do executável e das DLLs
do runtime (`ChromeProtegido.exe`, `*.dll`, `*.pak`, `icudtl.dat`,
`v8_context_snapshot.bin`…), e todos esses arquivos são fixados por hash. Trocar
qualquer um deles faz o empacotador falhar com "Runtime file changed", por
design.

Alternativas, todas exigindo decisão:

1. **Novo arquivo fornecido** (Drive) com Electron atual: só atualiza hash/tamanho
   em `UPSTREAM.json` e `package-user-chrome.py`. Menor mudança de código.
2. **Runtime oficial do Electron** (zip `electron-vNN-win32-x64.zip` do GitHub
   Releases, verificado por `SHASUMS256.txt`) renomeando `electron.exe` para
   `ChromeProtegido.exe`. Remove a dependência do Drive, mas perde ícone e
   metadados do exe (exigiria `rcedit`) e muda o princípio registrado em
   `UPSTREAM.json` ("preserve supplied runtime").
3. Ficar no 31 e migrar só a view (abaixo): reduz o risco de API, mas **não**
   resolve EOL (sem patches de segurança do Chromium). Para um navegador que abre
   sites arbitrários, isso é o risco principal.

Referência no próprio repositório: [lido] `protected-browser/` já usa Electron
45.2.2 com `BaseWindow` + `WebContentsView` (`protected-browser/main.cjs:4,106-116`),
incluindo `setContentProtection(true)`.

## 2. O que quebraria ao migrar BrowserView → WebContentsView

[não verificado] `WebContentsView` existe desde o Electron 30, então a migração
**cabe no runtime 31 atual** e entra só no `app.asar` (sem tocar o Drive).

| Ponto | Hoje [lido] | Com WebContentsView |
|---|---|---|
| Criação | `new BrowserView({webPreferences:{sandbox:true,…}})` em `browser/tab-manager.js:37` | `new WebContentsView({webPreferences:…})`, mesmas preferências |
| Anexar/trocar aba | `window.setBrowserView(view)` / `setBrowserView(null)` em `tab-manager.js:138` | `window.contentView.addChildView(view)` + `removeChildView(anterior)`; não existe "substituir" atômico, `attach()` precisa remover a anterior explicitamente |
| Layout | `view.setBounds(...)` manual em `layout()` | Igual (`setBounds`). Não usa `setAutoResize`, então nada a portar |
| Fechar aba | `view.webContents.close()` | Continua obrigatório: remover a view não destrói o `webContents` |
| Fundo | sem cor definida | [não verificado] o padrão do WebContentsView é fundo branco; pode piscar branco na troca de aba ou na nova aba escura. Usar `view.setBackgroundColor` |
| Injeção para teste | `TabManager({ BrowserView, … })` (`main.js:121`) | Renomear a dependência injetada; os fakes de `test/tab-manager.test.js` precisam de `contentView.addChildView/removeChildView` |
| Integração Electron | `window.getBrowserView()` em `integration/browser-shell.electron.js` (10 linhas) e `integration/private-proxy.electron.js` (4) | Reescrever via `window.contentView.children` ou expor a aba ativa do `TabManager` |
| Proteção de captura | `setContentProtection(true)` na BrowserWindow (`window-protection.js:16`) | Atua na janela inteira (as views filhas estão no mesmo HWND), mas **precisa ser revalidado** em captura real; fora de escopo desta rodada e não deve mudar |
| Ordem Z / painel lateral | BrowserView fica acima do HTML; o painel reduz a largura | Views filhas também ficam acima do webContents da janela; a lógica de `PANEL_WIDTH` continua válida |

Inalterados [lido]: `session.setProxy`/`closeAllConnections`/`resolveProxy`,
`app.on('login')`, `will-download`, `setPermissionRequestHandler`,
`setWindowOpenHandler`, `will-navigate`/`will-redirect`. Não dependem do tipo de
view. Ao subir a major, conferir as breaking changes de cada versão entre 31 e
a alvo para esses eventos, em especial a assinatura de `did-start-navigation`
usada com argumentos posicionais em `tab-manager.js:51` [não verificado].

## Recomendação (para decidir depois)

1. Primeiro migrar para WebContentsView **dentro do 31** (só `app.asar`; testes
   unitários + `npm run test:browser` + integração de proxy como gate).
2. Em seguida, trocar o runtime por um Electron suportado (opção 1 ou 2 acima),
   repetindo a validação de proteção de captura em hardware real.
