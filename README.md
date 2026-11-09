# ChromeProtegido + Private Cloud Proxy

**Projeto experimental desenvolvido exclusivamente para estudo e aprendizado.**

Esta edição utiliza o **ChromeProtegido fornecido pelo usuário**, preservando sua
interface com abas, favoritos, histórico e downloads. A adaptação conecta esse
navegador ao proxy privado hospedado na Render.

## Aviso de responsabilidade

O projeto é disponibilizado para fins educacionais, sem garantia de funcionamento,
disponibilidade, segurança absoluta ou adequação a uma finalidade específica.
**O autor não se responsabiliza pela forma como terceiros utilizarem este projeto,
nem por consequências de uso indevido, nos limites da legislação aplicável.**
Cada usuário é responsável por suas ações, pelos recursos que configurar e por
obter as autorizações necessárias. Use somente em ambientes e redes autorizados,
respeitando a legislação, as políticas de rede e os termos dos serviços acessados.

## Como funciona

```text
Seu ChromeProtegido
        │ HTTP/HTTPS por proxy local
        ▼
Cliente Node em 127.0.0.1
        │ WSS criptografado e autenticado
        ▼
Render Free → destinos públicos na internet
```

O HTTPS entre navegador e site permanece validado. O segredo do túnel fica no
cliente Node e não é enviado ao processo Electron. Se o proxy parar, a navegação
remota falha; o navegador não passa silenciosamente para conexão direta.

## Requisitos

- Windows 10/11 de 64 bits e uma pasta gravável do seu usuário.
- Acesso à internet e um serviço Render configurado com `TUNNEL_TOKEN`.
- Não exige administrador, SSH, VPN, domínio pago ou Node instalado previamente.

## Passo a passo: usar o navegador pronto

1. Abra a [Release do seu ChromeProtegido integrado](https://github.com/Lopes-V/proxy/releases/tag/user-chrome-preview).
2. Baixe **`PrivateCloudProxy-UserChrome-Windows.zip`**. O arquivo `.sha256` da
   mesma Release permite conferir a integridade do download.
3. Feche clientes antigos do proxy e as janelas antigas do navegador.
4. **Extraia o ZIP inteiro** numa pasta gravável, por exemplo
   `%USERPROFILE%\Documents\PrivateCloudProxy`. Execute a partir da pasta
   extraída, mantendo todos os arquivos juntos.
   Para salvar o token localmente, copie `.env.example` para `.env` e preencha
   `TUNNEL_TOKEN` com o valor do Render. O `.env` é ignorado pelo Git e não
   acompanha o pacote. Deixe-o vazio se preferir digitar o segredo ao iniciar.
5. Abra **`Start-Private-Proxy.cmd`**. Esse iniciador seleciona automaticamente o
   `ChromeProtegido.exe` que acompanha o pacote.
6. No primeiro uso, o iniciador baixa o Node portátil oficial e verifica seu
   SHA-256. As dependências do proxy já acompanham o pacote.
7. Se `TUNNEL_TOKEN` estiver preenchido em `.env`, o cliente o carrega sem
   exibi-lo. Caso contrário, informe o segredo quando solicitado; a entrada fica
   oculta e não é salva. Não envie esse valor ao chat, GitHub ou terceiros.
8. Aguarde a verificação de autenticação, certificado e cota. A primeira abertura
   após suspensão da Render pode demorar; o prazo de espera é de até 90 segundos.
9. O **seu ChromeProtegido** será aberto. Use a barra de endereços ou pesquisa e
   suas abas normalmente. Mantenha a janela do cliente aberta durante o uso.
10. Para encerrar, feche o navegador e pressione **Ctrl+C** na janela do cliente.

A URL do serviço existente vem pré-configurada:
`wss://private-cloud-proxy-free.onrender.com/tunnel`.

**Baixe o pacote da Release, não apenas o ZIP do código-fonte:** o código no Git
não inclui os arquivos grandes do runtime Windows. O antigo pacote
`PrivateCloudProxy-Protegido-Windows.zip` pertence à outra interface; o pacote
`PrivateCloudProxy-UserChrome-Windows.zip` usa o navegador enviado pelo usuário.

### Conferir o download no PowerShell

Este comando não exige administrador:

```powershell
Get-FileHash -Algorithm SHA256 .\PrivateCloudProxy-UserChrome-Windows.zip
```

Compare o resultado com o arquivo `.sha256` publicado na mesma Release.

## Conferir a conexão

1. Abra `https://example.com` no navegador integrado.
2. Abra `https://api.ipify.org?format=json` para observar o IP público de saída.
   Ele pode mudar após reinicializações do provedor.
3. Para testar a interrupção segura, pare o cliente com Ctrl+C e tente carregar
   uma nova página. A conexão deve falhar, mantendo o acesso direto bloqueado.

Na edição integrada, a tela de rede informa que a conexão é gerenciada. As opções
de acesso direto, PAC por domínio e troca de proxy ficam bloqueadas. Isso não
apaga as configurações antigas do navegador nem o histórico mensal do cliente.

## Configurar seu próprio serviço na Render

Para estudar com sua própria conta e suas próprias credenciais:

1. Vincule seu repositório ao Render e aplique o Blueprint `render.yaml`.
2. Confirme somente o **Web Service Free**, sem banco, disco ou recurso pago.
   Não cadastre cartão nem habilite cobrança para seguir este procedimento.
3. Aguarde o CI e o deploy. O Blueprint usa **After CI Checks Pass** e o comando
   de build executa os testes. Para um serviço já criado, siga
   [o guia de configurações do Render](docs/RENDER-SETTINGS.md).
4. Guarde o `TUNNEL_TOKEN` no painel privado do Render. Cada proprietário deve
   utilizar seu próprio segredo; nenhum valor real acompanha este repositório.
5. Ao construir seu pacote, configure o endpoint `wss://SEU-SERVICO.onrender.com/tunnel`.
   O empacotador aceita `--endpoint` conforme sua ajuda `--help`.

O proprietário do serviço atual confirmou plano Free sem método de pagamento.
Isso não substitui a conferência da sua própria conta. Cotas compartilhadas e
restrições da Render continuam aplicáveis; o projeto não mede a fatura do provedor.

## Limites e falhas comuns

- Cliente: **4 GiB por mês UTC** (uso pessoal), com contabilidade persistente e conservadora.
  O Render Free inclui 5 GB/mês de saída e suspende os serviços até o mês seguinte se
  isso for excedido sem forma de pagamento; os 4 GiB deixam margem para overhead.
- Relay: **4 GiB por processo**, 32 túneis simultâneos, 1 GiB por túnel e 2.000
  aberturas por dia. O cliente usa até 24 túneis e uma fila limitada.
- O Render Free suspende serviços ociosos e pode restringir saída incomum. Não há
  pings artificiais para impedir a suspensão nem garantia de disponibilidade.
- A edição preserva o runtime Electron/Chromium fornecido pelo usuário. Essa
  integração não é uma atualização de segurança desse runtime nem o Chrome oficial.
- WebRTC/UDP não é tunelado; alguns recursos de sites podem ser incompatíveis.
- A proteção de captura existente depende das APIs e da versão do Windows; não
  garante bloqueio de todas as formas de captura.

| Código ou situação | O que fazer |
|---|---|
| `SECRET_INVALID` / `RELAY_AUTH_FAILED` | Confira o valor completo de `TUNNEL_TOKEN` no seu painel Render. |
| `CLIENT_TRAFFIC_LIMIT` | A cota local acabou. Preserve o arquivo de consumo; não o apague para reiniciar a cota. |
| `REMOTE_TRAFFIC_LIMIT` | O orçamento remoto acabou; repetir a requisição não resolve esse limite. |
| `LOCAL_PORT_BUSY` / `CLIENT_LOCK_UNAVAILABLE` | Feche o cliente anterior e tente novamente. |
| `RELAY_TLS_FAILED` | Confira a URL e a confiança TLS da rede; não desative a validação de certificados. |
| O navegador não abriu | Confirme a extração completa, incluindo a pasta `ChromeProtegido`. |
| Demora na primeira página | Aguarde a retomada natural do serviço Free. |

Outros diagnósticos estão em [WINDOWS-STARTUP.md](docs/WINDOWS-STARTUP.md).
Ao relatar uma falha, envie somente a mensagem e o código, sem segredos, cookies
ou URLs privadas.

## Credenciais, chaves e dados

- Chaves privadas e credenciais reais não devem entrar no Git nem nos pacotes.
- O empacotador rejeita arquivos de chave/credencial e material PEM privado.
- `TUNNEL_TOKEN` é obrigatório para autenticar; ele não está embutido no código.
- O arquivo local `.env` pode guardar esse token; ele é ignorado pelo Git e não é distribuído. O pacote inclui apenas `.env.example` vazio.
- O perfil e os dados de navegação ficam localmente no computador do usuário.
- O consumo fica em `%LOCALAPPDATA%\PrivateCloudProxy\bridge-usage.json`. Esse
  arquivo é preservado nas atualizações e não deve ser editado para burlar cotas.
- Chaves temporárias de testes são geradas durante a execução e não são
  distribuídas como credenciais do sistema.

## Desenvolvimento e testes

```sh
npm ci --ignore-scripts
npm test
npm --prefix user-chrome test
python3 -m unittest discover -s scripts/test -p test_package_user_chrome.py
```

A construção do pacote reutiliza o arquivo original do Drive com SHA-256 fixado e
preserva todos os arquivos do runtime, exceto `resources/app.asar`. Veja
[o guia de construção e smoke nativo Windows](docs/USER-CHROME-WINDOWS.md).
As licenças originais dos componentes acompanham o pacote.

Os testes existentes do proxy incluem TLS, autenticação, política de destinos,
DNS, concorrência e ausência de acesso direto. O smoke nativo do Chrome fornecido
exige navegação HTTP pelo proxy, HTTPS real por CONNECT para `https://example.com`
com a validação TLS normal do Chromium e falha com o proxy parado. A conclusão
desses testes nativos depende de um relatório aprovado no CI Windows; eles não
comprovam todas as funcionalidades de sites. O resultado efetivo do CI e os
relatórios da Release indicam o que passou naquela versão.
