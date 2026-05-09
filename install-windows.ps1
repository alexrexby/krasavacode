# KRASAVACODE - Windows installer (PowerShell)
# Run: powershell -ExecutionPolicy Bypass -Command "iwr https://is.gd/<short> -useb | iex"

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host ""
Write-Host "  ============================================="
Write-Host "                K R A S A V A C O D E"
Write-Host "    Бесплатный вайбкодинг — установка для Win"
Write-Host "  ============================================="
Write-Host ""

$installDir = Join-Path $env:USERPROFILE "krasavacode"
$binPath = Join-Path $installDir "krasavacode.exe"
$shortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "ВАЙБКОДИНГ.bat"
$url = "https://github.com/alexrexby/krasavacode/releases/latest/download/krasavacode.exe"

if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

Write-Host "  Скачиваю программу (~110 МБ, около минуты)..."
Write-Host ""

try {
    Invoke-WebRequest -Uri $url -OutFile $binPath -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "  X Не удалось скачать. Проверь интернет и попробуй ещё раз."
    Read-Host "  Нажми Enter для выхода"
    exit 1
}

if (-not (Test-Path $binPath)) {
    Write-Host "  X Файл не появился после скачивания."
    Read-Host "  Нажми Enter для выхода"
    exit 1
}

# Создаём ярлык-bat на рабочем столе
$shortcutContent = @"
@echo off
cd /d "%USERPROFILE%"
"$binPath"
pause
"@
Set-Content -Path $shortcut -Value $shortcutContent -Encoding Default

Write-Host ""
Write-Host "  + Готово!"
Write-Host ""
Write-Host "  На Рабочем столе появился значок «ВАЙБКОДИНГ»."
Write-Host ""
Write-Host "  ============================================="
Write-Host "  СЛЕДУЮЩИЙ ШАГ — подключаем бесплатные ИИ"
Write-Host "  ============================================="
Write-Host ""
Write-Host "  По умолчанию работает простая модель."
Write-Host "  Подключи Cerebras (14k запросов/день) — это главное."
Write-Host "  Можно ещё Groq и Gemini для надёжности."
Write-Host "  Всё бесплатно, без карты, занимает ~1 минуту."
Write-Host ""
Write-Host "  Запускаю окно подключения в браузере..."
Write-Host ""

# Запускаем krasavacode setup в новом окне cmd, чтобы пользователь
# видел прогресс и не потерял окно установщика.
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "`"$binPath`" setup"
