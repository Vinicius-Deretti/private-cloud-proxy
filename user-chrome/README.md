# Edição integrada ao Private Cloud Proxy

Estes são os fontes do ChromeProtegido enviados pelo usuário. A interface de navegação foi preservada. A edição integrada usa rede gerenciada e requer o cliente de proxy ativo; as opções de acesso direto da documentação original abaixo não ficam disponíveis nesta edição.

Para executar, use o pacote completo e `Start-Private-Proxy.cmd`. Consulte [o passo a passo do sistema](../README.md) e [o guia do pacote](../docs/USER-CHROME-WINDOWS.md).

**Projeto para estudo, sem garantia. O autor não se responsabiliza pelo uso indevido por terceiros, nos limites da legislação aplicável. Cada usuário responde por suas ações e autorizações.**

---

## Documentação original do navegador

# Meu Chrome Protegido

## Roteamento por domínio com proxy autorizado

Em **Rede > Configurações de rede**, selecione HTTP/HTTPS ou SOCKS5, informe o endpoint corporativo autorizado e escolha **Somente aos domínios informados**. Informe os domínios separados por vírgula, por exemplo: `store.steampowered.com, checkout.steampowered.com, steamcommunity.com, steampowered.com`.

O Chromium recebe um PAC: cada domínio e subdomínio listado retorna somente `PROXY` ou `SOCKS5`; os demais retornam `DIRECT`. Não há `DIRECT` como alternativa para uma correspondência. Se o proxy autorizado falhar, a requisição protegida falha sem rota direta. Para HTTPS, o diagnóstico confirma CONNECT antes da validação TLS, que permanece habilitada. Credenciais usam o armazenamento seguro do sistema quando disponível.

Aplicativo Electron para Windows com proteção de tela nativa.

### Proteção contra captura de tela

Todas as janelas usam `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` do
Windows 10 2004+ (via `setContentProtection`, em `window-protection.js`). Print
Screen, Ferramenta de Captura, Xbox Game Bar e gravadores que usam as APIs do
Windows mostram a janela em preto ou transparente.

- As janelas são criadas ocultas e só aparecem depois que a proteção está ativa.
- A proteção é reaplicada ao exibir, restaurar, maximizar, entrar/sair de tela
  cheia e receber foco.
- Qualquer outra janela criada pelo aplicativo também é protegida; DevTools é
  fechado automaticamente, pois abriria uma janela fora da proteção.

Não há proteção contra fotografias da tela, drivers de captura ou software com
acesso privilegiado. Menus nativos e caixas de diálogo do sistema não são
cobertos.

## Navegação

A página inicial é local: abrir uma aba não carrega sites externos. Digite um
endereço ou uma busca na barra superior ou no campo central. Buscas usam
Google (o DuckDuckGo não responde pelo servidor no Render); endereços locais como `localhost:8080` e `127.0.0.1:3000` são aceitos.

- Feche uma aba pelo **×** ou pelo botão do meio do mouse. Fechar a última abre
  uma nova aba local. Até dez abas fechadas podem ser reabertas durante a sessão.
- A **estrela** adiciona ou remove o site atual dos favoritos. Os favoritos
  aparecem na barra e na página inicial; Ctrl+clique abre em outra aba.
- **Favoritos**, **Histórico** e **Downloads** abrem um painel lateral com filtro.
  O histórico guarda até 1.000 URLs recentes e os downloads até 100 registros.
- Downloads mostram progresso, conclusão, cancelamento ou interrupção. Use
  **Mostrar na pasta** para localizar um arquivo concluído.
- O ícone de rede e o menu **Rede** abrem as configurações existentes de proxy.

| Atalho | Ação |
| --- | --- |
| Ctrl+L | Selecionar a barra de endereço |
| Ctrl+T / Ctrl+W | Abrir / fechar aba |
| Ctrl+Shift+T | Reabrir aba fechada |
| Ctrl+Tab / Ctrl+Shift+Tab | Próxima / anterior |
| Alt+← / Alt+→ | Voltar / avançar |
| Ctrl+R ou F5 | Recarregar |
| Alt+Home | Página inicial local |
| Ctrl+D | Adicionar / remover favorito |
| Ctrl+H / Ctrl+J / Ctrl+Shift+O | Histórico / downloads / favoritos |

Favoritos, histórico e registros de download ficam no perfil local do aplicativo,
sem sincronização. A proteção nativa de captura permanece habilitada. As páginas
remotas continuam isoladas do Node.js e dos controles internos do navegador.

### Verificar as melhorias

```powershell
npm test
npm run test:browser
npm run test:integration
```

`test:browser` executa o Electron real com perfil temporário, removido ao terminar,
e um servidor HTTP local. Valida controles da interface, favoritos, painel,
fechamento/reabertura, erros e um download local. As falhas HTTP e a rejeição de
`javascript:` exibidas nesse teste são casos de erro intencionais. O teste não
comprova acesso a sites externos nem substitui validação de um proxy corporativo.

Para usar as alterações no código, execute `npm start`. Executáveis já existentes
em `dist` precisam ser gerados novamente para incorporar as mudanças.

## Pré-requisitos

- Windows 10 ou superior;
- [Node.js](https://nodejs.org/) LTS (18 ou mais recente), que já inclui o `npm`.

## Executar durante o desenvolvimento

No PowerShell, abra a pasta do projeto e instale as dependências (necessário apenas na primeira vez ou após mudanças no `package.json`):

```powershell
npm install
```

Em seguida, inicie o aplicativo:

```powershell
npm start
```

## Gerar o executável (.exe)

Com o PowerShell aberto na raiz do projeto, execute:

```powershell
npm run dist
```

O comando usa o Electron Builder para criar os pacotes Windows na pasta `dist`:

- `ChromeProtegido Setup 1.0.0.exe`: instalador do aplicativo;
- `ChromeProtegido 1.0.0.exe`: versão portátil, que pode ser executada sem instalação.

Os nomes incluem a versão definida em `package.json`. Ao alterar o campo `version`, os nomes dos arquivos também serão atualizados.

## Observações

- Execute `npm install` antes de gerar o `.exe` em uma máquina nova.
- A pasta `dist` é criada automaticamente pelo comando de geração e também contém arquivos auxiliares do empacotamento.
- Como o aplicativo não possui assinatura digital configurada, o Windows pode exibir um aviso do SmartScreen ao abrir o executável em outro computador.

## Conectividade e proxy

Abra **Rede > Configurações de rede** para escolher conexão direta, proxy
HTTP/HTTPS ou SOCKS5. A alteração é aplicada à sessão Chromium do navegador e
fecha conexões existentes para que as novas requisições usem a configuração
selecionada. As credenciais de proxy são protegidas pelo armazenamento seguro
do sistema operacional quando ele estiver disponível; elas nunca aparecem no
histórico ou no estado mostrado pela tela.

Um **túnel autorizado** é configurado como um endpoint SOCKS5 ou HTTP/HTTPS
já criado pela infraestrutura aprovada (por exemplo, um proxy corporativo ou
um listener local de túnel). O aplicativo não cria túneis SSH/VPN e não tenta
contornar filtros de rede.

O botão de teste separa DNS, TCP, TLS/certificado, HTTP/1.1, HTTP/2 e a
conectividade do proxy. Uma conexão TCP bem-sucedida não é apresentada como
sucesso HTTP. HTTP/3/QUIC depende do servidor, da rede e do Chromium; como o
Electron não expõe as etapas do handshake QUIC, a tela informa essa limitação
em vez de alegar confirmação de HTTP/3.

### Testes de integração de rede

Execute `npm run test:integration` para usar uma sessão Chromium temporária e
servidores HTTP/proxy somente locais. O procedimento valida conexão direta,
rejeição de proxy inválido em `127.0.0.1:19999` sem fallback direto,
encaminhamento por proxy local, regras HTTP/HTTPS/SOCKS5 e restauração para
conexão direta em `finally`. Ele não desativa TLS, não altera firewall e não
faz conexões por proxies externos. Execute `npm test` para os diagnósticos de
classificação DNS, TCP, TLS/certificado e proxy.
