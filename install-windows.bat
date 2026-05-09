@echo off
REM KRASAVACODE — установщик для Windows.
REM Дабл-клик на этот файл — и всё установится само.

setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1

cls
echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║              KRASAVACODE                     ║
echo   ║ Бесплатный вайбкодинг — установка для Win    ║
echo   ╚══════════════════════════════════════════════╝
echo.

set "INSTALL_DIR=%USERPROFILE%\krasavacode"
set "BIN_PATH=%INSTALL_DIR%\krasavacode.exe"
set "SHORTCUT=%USERPROFILE%\Desktop\ВАЙБКОДИНГ.bat"
set "URL=https://github.com/alexrexby/krasavacode/releases/latest/download/krasavacode.exe"

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

echo   📥 Скачиваю программу (≈110 МБ, около минуты)...
echo.

REM Используем curl (есть в Win10+) либо PowerShell как fallback
where curl >nul 2>&1
if %ERRORLEVEL% EQU 0 (
  curl --fail --location --progress-bar -o "%BIN_PATH%" "%URL%"
) else (
  powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%BIN_PATH%'"
)

if not exist "%BIN_PATH%" (
  echo.
  echo   ❌ Не удалось скачать. Проверь интернет и попробуй ещё раз.
  pause
  exit /b 1
)

REM Создаём ярлык на рабочем столе
> "%SHORTCUT%" echo @echo off
>> "%SHORTCUT%" echo cd /d "%%USERPROFILE%%"
>> "%SHORTCUT%" echo "%BIN_PATH%"
>> "%SHORTCUT%" echo pause

echo.
echo   ✅ Готово!
echo.
echo   На твоём Рабочем столе появился значок «ВАЙБКОДИНГ».
echo.
echo   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   СЛЕДУЮЩИЙ ШАГ — подключаем бесплатные ИИ
echo   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
echo   По умолчанию работает простая модель.
echo   Подключи Cerebras (14k запросов/день) — это главное.
echo   Можно ещё Groq и Gemini для надёжности.
echo   Всё бесплатно, без карты, занимает ~1 минуту.
echo.
echo   Сейчас откроется окно подключения в браузере.
echo   Нажми любую клавишу для продолжения.
pause >nul
"%BIN_PATH%" setup
