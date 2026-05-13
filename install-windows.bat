@echo off
REM KRASAVACODE - installer for Windows.
REM File is saved as UTF-8 with BOM so cyrillic renders correctly under chcp 65001.

setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1

cls
echo.
echo   =============================================
echo                K R A S A V A C O D E
echo       Установка вайбкодинга для Windows
echo   =============================================
echo.

set "INSTALL_DIR=%USERPROFILE%\krasavacode"
set "BIN_PATH=%INSTALL_DIR%\krasavacode.exe"
set "SHORTCUT=%USERPROFILE%\Desktop\ВАЙБКОДИНГ.bat"
set "URL=https://github.com/alexrexby/krasavacode/releases/latest/download/krasavacode.exe"

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

echo   Скачиваю программу (~110 МБ, около минуты)...
echo   Если интернет медленный — может занять до 10 минут, не закрывай окно.
echo.

where curl >nul 2>&1
if %ERRORLEVEL% EQU 0 (
  curl --fail --location --progress-bar -o "%BIN_PATH%" "%URL%"
) else (
  powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%BIN_PATH%'"
)

if not exist "%BIN_PATH%" (
  echo.
  echo   X Не удалось скачать. Проверь интернет и попробуй ещё раз.
  pause
  exit /b 1
)

REM Ярлык на Рабочем столе для повторного запуска
> "%SHORTCUT%" echo @echo off
>> "%SHORTCUT%" echo chcp 65001 ^>nul
>> "%SHORTCUT%" echo if not exist "%%USERPROFILE%%\krasavacode-projects" mkdir "%%USERPROFILE%%\krasavacode-projects"
>> "%SHORTCUT%" echo cd /d "%%USERPROFILE%%\krasavacode-projects"
>> "%SHORTCUT%" echo "%BIN_PATH%"
>> "%SHORTCUT%" echo echo.
>> "%SHORTCUT%" echo echo Нажми любую клавишу чтобы закрыть окно...
>> "%SHORTCUT%" echo pause ^>nul

echo.
echo   + Готово!
echo.
echo   На Рабочем столе появился значок «ВАЙБКОДИНГ».
echo.
echo   =============================================
echo   СЛЕДУЮЩИЙ ШАГ — подключаем AI-провайдер
echo   =============================================
echo.
echo   Polza.ai — российский, оплата картой РФ, без VPN (~100₽ хватает надолго).
echo   Или OpenRouter — бесплатный, но нужен VPN (50 запросов/день).
echo.
echo   Сейчас в браузере откроется окно подключения.
echo   Не закрывай это чёрное окно — оно нужно после настройки!
echo.
echo   Через 3 секунды откроется браузер...
timeout /t 3 /nobreak >nul
"%BIN_PATH%" setup
echo.
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo   X krasavacode упал. Лог: %USERPROFILE%\.krasavacode\last-crash.log
  echo   Запусти "krasavacode doctor" или отправь лог наставнику.
) else (
  echo   + Сессия завершена. Чтобы начать заново — дабл-клик по ВАЙБКОДИНГ на Рабочем столе.
)
echo.
echo   Нажми любую клавишу чтобы закрыть это окно...
pause >nul
