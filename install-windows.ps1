# KRASAVACODE - Windows installer (PowerShell)
# Run: powershell -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; iwr https://is.gd/<short> -useb | iex"

$ErrorActionPreference = 'Stop'
# PowerShell 5.1 defaults to TLS 1.0/1.1 → modern hosts reject it. Force TLS 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
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

# Создаём ярлык-bat на рабочем столе — открывает claude в sandbox-папке
$shortcutContent = @"
@echo off
if not exist "%USERPROFILE%\krasavacode-projects" mkdir "%USERPROFILE%\krasavacode-projects"
cd /d "%USERPROFILE%\krasavacode-projects"
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
Write-Host "  СЛЕДУЮЩИЙ ШАГ — подключаем AI-провайдер"
Write-Host "  ============================================="
Write-Host ""
Write-Host "  Polza.ai — российский, оплата картой РФ, без VPN (~100₽ хватает надолго)."
Write-Host "  Или OpenRouter — бесплатный, но нужен VPN (50 запросов/день)."
Write-Host ""
Write-Host "  Сейчас в браузере откроется окно подключения."
Write-Host "  Не закрывай это окно PowerShell — оно нужно после настройки!"
Write-Host ""
Start-Sleep -Seconds 2

# Запускаем setup прямо в этом окне (не в новом!) — чтобы ученик не путался
# между окнами установщика и приложения.
& $binPath setup

Write-Host ""
if ($LASTEXITCODE -ne 0) {
    Write-Host "  X krasavacode упал. Лог: $env:USERPROFILE\.krasavacode\last-crash.log"
    Write-Host "  Запусти 'krasavacode doctor' или отправь лог наставнику."
} else {
    Write-Host "  + Сессия завершена. Чтобы начать заново — дабл-клик по ВАЙБКОДИНГ на Рабочем столе."
}
Write-Host ""
Read-Host "  Нажми Enter чтобы закрыть это окно"
