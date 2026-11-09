@echo off
rem Mantido por compatibilidade: abre sempre o ChromeProtegido.
call "%~dp0Start-Private-Proxy.cmd"
exit /b %errorlevel%
