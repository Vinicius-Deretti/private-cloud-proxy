@echo off
setlocal
cd /d "%~dp0"
set "BRIDGE_DIR=%~dp0"
set "BRIDGE_NODE_DIR=%~dp0.runtime\node-v24.22.1-win-x64"
set "BRIDGE_NODE=%BRIDGE_NODE_DIR%\node.exe"
if exist "%BRIDGE_NODE%" goto browser
where powershell.exe >nul 2>nul
if errorlevel 1 goto failed
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $root=Join-Path $env:BRIDGE_DIR '.runtime'; New-Item -ItemType Directory -Force -Path $root | Out-Null; $zip=Join-Path $root 'node.zip'; Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip' -OutFile $zip; if((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne 'D2046D28C2C3DCD211AC5145C0BF30E2047EF9DFB306693C8C6E2ECCD8B95FA5'){Remove-Item -LiteralPath $zip; throw 'Checksum invalido'}; Expand-Archive -LiteralPath $zip -DestinationPath $root -Force; Remove-Item -LiteralPath $zip"
if errorlevel 1 goto failed
:browser
rem Sempre o ChromeProtegido; o Chrome instalado nunca e escolhido por este launcher.
rem 1) Pacote: ChromeProtegido\ChromeProtegido.exe ao lado deste arquivo.
if not defined PCP_PROTECTED_BROWSER_EXE if exist "%~dp0ChromeProtegido\ChromeProtegido.exe" set "PCP_PROTECTED_BROWSER_EXE=%~dp0ChromeProtegido\ChromeProtegido.exe"
if defined PCP_PROTECTED_BROWSER_EXE goto run
rem 2) Repositorio: Electron do codigo-fonte em user-chrome (instalado na primeira execucao).
if not exist "%~dp0user-chrome\package.json" goto nobrowser
if exist "%~dp0user-chrome\node_modules\electron\dist\electron.exe" goto userchrome
echo Preparando o ChromeProtegido (primeira execucao, baixa o Electron)...
set "PATH=%BRIDGE_NODE_DIR%;%PATH%"
call "%BRIDGE_NODE_DIR%\npm.cmd" ci --prefix "%~dp0user-chrome" --no-audit --no-fund
if errorlevel 1 goto failed
if not exist "%~dp0user-chrome\node_modules\electron\dist\electron.exe" goto nobrowser
:userchrome
set "PCP_PROTECTED_BROWSER_EXE=%~dp0user-chrome\node_modules\electron\dist\electron.exe"
set "PCP_PROTECTED_BROWSER_APP=%~dp0user-chrome"
:run
"%BRIDGE_NODE%" "%~dp0bridge\bootstrap.mjs"
if errorlevel 1 goto failed
"%BRIDGE_NODE%" "%~dp0bridge\start.mjs"
if errorlevel 1 goto failed
exit /b 0
:nobrowser
echo Falha [PROTECTED_BROWSER_MISSING]: ChromeProtegido nao encontrado.
echo Use o pacote completo ou um clone com a pasta user-chrome.
pause
exit /b 1
:failed
echo Falha. Nenhuma politica do Windows ou verificacao TLS foi desativada.
echo Use o pacote completo extraido em uma pasta gravavel do usuario.
pause
exit /b 1
