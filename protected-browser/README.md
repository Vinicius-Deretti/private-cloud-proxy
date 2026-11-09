# Private Cloud Chromium (Windows, prévia)

Navegador baseado em **Electron/Chromium**, separado do Chrome instalado. Ele usa o cliente HTTP CONNECT local já existente. O `TUNNEL_TOKEN` continua sendo solicitado exclusivamente pelo launcher e nunca é enviado ao processo Electron.

## Executar

1. Baixe o **PrivateCloudProxy-Protegido-Windows.zip** da [página de downloads](../downloads/windows/README.md) e extraia tudo em uma única pasta do usuário.
2. Execute **Start-Private-Proxy-Protegido.cmd** e informe o segredo do serviço Render (entrada oculta).
3. O cliente inicia a porta loopback, valida autenticação e cota, e só então abre o navegador protegido.
4. Digite um endereço no campo superior. Ctrl+L seleciona o endereço. Há Voltar, Avançar e Atualizar.

O aplicativo usa `BaseWindow.setContentProtection(true)`, que invoca a proteção `WDA_EXCLUDEFROMCAPTURE` no Windows 10 2004+. A proteção é aplicada **antes de mostrar a janela**. A janela do navegador não deve aparecer em capturas produzidas por APIs compatíveis do Windows, mas **não há garantia** contra fotografias, drivers, capturadores incompatíveis, páginas que exportem conteúdo, ou software com acesso privilegiado. Não tente usá-lo para contornar políticas de monitoramento em ambientes gerenciados.

O Chrome tradicional **não é modificado**. Este é outro navegador, com perfil e cookies separados. Pode haver diferenças em serviços como WhatsApp Web, DRM, login federado, videochamadas e extensões. Janelas pop-up externas são bloqueadas para evitar abertura desprotegida. Não há extensão, atualização automática nem promessa de captura completamente invisível.

## Limitações e segurança

- Somente navegação HTTP/HTTPS com proxy fixo `127.0.0.1:17831`; se o proxy parar, a navegação falha. WebRTC/UDP não recebe tunelamento.
- Não precisa de administrador. O navegador executa com sandbox de renderização, context isolation e sem Node.js nas páginas remotas.
- O aplicativo não configura `ignore-certificate-errors` nem desativa verificação TLS.
- As quotas locais (4 GiB/mês) e remotas (4 GiB/processo, além dos 5 GB/mês de saída do Render Free) continuam valendo.
- O binário é compilado pela ação GitHub em Windows. Por ser uma prévia **sem assinatura digital**, o Windows pode alertar ao executar. Confira origem, hash SHA-256 e o código-fonte antes de executar.
- Para voltar ao navegador padrão, execute `Start-Private-Proxy.cmd` no mesmo pacote.

A versão protegida não é um fork completo do Google Chrome; é um shell Electron com Chromium incorporado e barra de navegação básica. Não há garantia de funcionamento de funcionalidades específicas do Google Chrome.
