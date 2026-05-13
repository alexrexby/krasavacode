@echo off
REM KRASAVACODE - installer for Windows.
REM Double-click this file - everything installs automatically.

setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1

cls
echo.
echo   =============================================
echo                K R A S A V A C O D E
echo     Free vibecoding - install for Windows
echo   =============================================
echo.

set "INSTALL_DIR=%USERPROFILE%\krasavacode"
set "BIN_PATH=%INSTALL_DIR%\krasavacode.exe"
set "SHORTCUT=%USERPROFILE%\Desktop\VIBECODE.bat"
set "URL=https://github.com/alexrexby/krasavacode/releases/latest/download/krasavacode.exe"

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

echo   Downloading (~110 MB, about a minute)...
echo.

where curl >nul 2>&1
if %ERRORLEVEL% EQU 0 (
  curl --fail --location --progress-bar -o "%BIN_PATH%" "%URL%"
) else (
  powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%BIN_PATH%'"
)

if not exist "%BIN_PATH%" (
  echo.
  echo   X Download failed. Check internet and try again.
  pause
  exit /b 1
)

REM Create desktop shortcut — opens claude in sandbox folder
> "%SHORTCUT%" echo @echo off
>> "%SHORTCUT%" echo if not exist "%%USERPROFILE%%\krasavacode-projects" mkdir "%%USERPROFILE%%\krasavacode-projects"
>> "%SHORTCUT%" echo cd /d "%%USERPROFILE%%\krasavacode-projects"
>> "%SHORTCUT%" echo "%BIN_PATH%"
>> "%SHORTCUT%" echo pause

echo.
echo   + Done!
echo.
echo   Desktop shortcut "VIBECODE" was created.
echo.
echo   =============================================
echo   NEXT STEP - connect free AI providers
echo   =============================================
echo.
echo   Default model is weak. Connect Cerebras (14k req/day) -
echo   that is the main one. Groq and Gemini optional.
echo   All free, no card, takes about 1 minute.
echo.
echo   Opening connection window in 3 seconds (no clicking needed)...
timeout /t 3 /nobreak >nul
"%BIN_PATH%" setup
echo.
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo   X krasavacode crashed. Crash log: %USERPROFILE%\.krasavacode\last-crash.log
  echo   Run "krasavacode doctor" or send the log to your mentor.
) else (
  echo   + Session finished. To start again, double-click VIBECODE on Desktop.
)
echo.
pause
