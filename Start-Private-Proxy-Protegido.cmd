@echo off
setlocal
rem Pacote antigo (Private Cloud Chromium), se presente; senao Start-Private-Proxy.cmd
rem usa o ChromeProtegido do pacote ou do codigo-fonte.
set "LEGACY_EXE=%~dp0Private Cloud Chromium-win32-x64\Private Cloud Chromium.exe"
if exist "%LEGACY_EXE%" set "PCP_PROTECTED_BROWSER_EXE=%LEGACY_EXE%"
call "%~dp0Start-Private-Proxy.cmd"
exit /b %errorlevel%
