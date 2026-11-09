@echo off
setlocal
rem Repositorio: usa o Chrome Protegido do codigo-fonte (npm ci em user-chrome).
if not defined PCP_PROTECTED_BROWSER_EXE if exist "%~dp0user-chrome\node_modules\electron\dist\electron.exe" (
  set "PCP_PROTECTED_BROWSER_EXE=%~dp0user-chrome\node_modules\electron\dist\electron.exe"
  set "PCP_PROTECTED_BROWSER_APP=%~dp0user-chrome"
)
cd /d "%~dp0"
set "BRIDGE_DIR=%~dp0"
set "BRIDGE_NODE=%~dp0.runtime\node-v24.22.1-win-x64\node.exe"
if exist "%BRIDGE_NODE%" goto run
where powershell.exe >nul 2>nul
if errorlevel 1 goto failed
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $root=Join-Path $env:BRIDGE_DIR '.runtime'; New-Item -ItemType Directory -Force -Path $root | Out-Null; $zip=Join-Path $root 'node.zip'; Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip' -OutFile $zip; if((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne 'D2046D28C2C3DCD211AC5145C0BF30E2047EF9DFB306693C8C6E2ECCD8B95FA5'){Remove-Item -LiteralPath $zip; throw 'Checksum invalido'}; Expand-Archive -LiteralPath $zip -DestinationPath $root -Force; Remove-Item -LiteralPath $zip"
if errorlevel 1 goto failed
:run
"%BRIDGE_NODE%" "%~dp0bridge\bootstrap.mjs"
if errorlevel 1 goto failed
"%BRIDGE_NODE%" "%~dp0bridge\start.mjs"
if errorlevel 1 goto failed
exit /b 0
:failed
echo Falha. Nenhuma politica do Windows ou verificacao TLS foi desativada.
echo Use o pacote completo extraido em uma pasta gravavel do usuario.
pause
exit /b 1
