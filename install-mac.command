#!/bin/bash
# KRASAVACODE — установщик для macOS.
# Можно запускать двумя способами:
#   1. Дабл-клик на скачанный файл (требует разрешить через System Settings → Privacy)
#   2. curl -fsSL <url> | bash       (работает мгновенно, без Gatekeeper'а)
set -e

# Не выводим ANSI-clear если запущены через pipe (curl|bash)
if [ -t 1 ]; then clear; fi

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║              KRASAVACODE                     ║"
echo "  ║   Бесплатный вайбкодинг — установка для Mac  ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

# Определяем процессор Mac (Apple Silicon vs Intel)
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  BIN_NAME="krasavacode-mac-arm64"
  echo "  Твой Mac: Apple Silicon (M1/M2/M3/M4)"
else
  BIN_NAME="krasavacode-mac-x64"
  echo "  Твой Mac: Intel"
fi

INSTALL_DIR="$HOME/krasavacode"
BIN_PATH="$INSTALL_DIR/krasavacode"
SHORTCUT="$HOME/Desktop/ВАЙБКОДИНГ.command"

mkdir -p "$INSTALL_DIR"

URL="https://github.com/alexrexby/krasavacode/releases/latest/download/$BIN_NAME"

echo ""
echo "  📥 Скачиваю программу (≈60 МБ, 30 секунд)…"
echo ""
curl --fail --location --progress-bar -o "$BIN_PATH" "$URL"

# Делаем исполняемым и снимаем macOS-карантин
chmod +x "$BIN_PATH"
xattr -d com.apple.quarantine "$BIN_PATH" 2>/dev/null || true

# Кладём на рабочий стол ярлык, который дабл-кликается.
# Скрипт сам определит, нужно ли запустить setup (если провайдеры
# не подключены) или сразу запустить вайбкодинг.
cat > "$SHORTCUT" <<EOF
#!/bin/bash
PROJECTS="\$HOME/krasavacode-projects"
mkdir -p "\$PROJECTS"
cd "\$PROJECTS"
"$BIN_PATH"
EOF
chmod +x "$SHORTCUT"
xattr -d com.apple.quarantine "$SHORTCUT" 2>/dev/null || true

echo ""
echo "  ✅ Готово!"
echo ""
echo "  На твоём Рабочем столе появился значок «ВАЙБКОДИНГ»."
echo "  Дабл-клик — и пиши свою задачу."
echo ""
echo "  При первом запуске докачается ещё ≈100 МБ (Node.js и Claude Code),"
echo "  это один раз. Дальше — мгновенно."
echo ""
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  СЛЕДУЮЩИЙ ШАГ — подключаем бесплатные ИИ"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  По умолчанию работает простая модель."
echo "  Подключи Cerebras (14k запросов/день) — это главное."
echo "  Можно ещё Groq и Gemini для надёжности."
echo "  Всё бесплатно, без карты, занимает ~1 минуту."
echo ""

if [ -t 0 ]; then
  # Интерактивный режим (дабл-клик на .command) — запускаем setup прямо тут
  echo "  Открываю окно подключения в браузере..."
  sleep 1
  exec "$BIN_PATH" setup
else
  # Pipe-mode (curl | bash) — открываем новое окно Терминала с setup,
  # потому что в pipe нет TTY для интерактивного выбора и stdin закрыт.
  echo "  Открываю новое окно Терминала с подключением провайдеров..."
  osascript <<EOF >/dev/null 2>&1 || true
tell application "Terminal"
  activate
  do script "'$BIN_PATH' setup"
end tell
EOF
  echo ""
  echo "  ✅ Если новое окно не открылось — запусти вручную:"
  echo "     '$BIN_PATH' setup"
fi
