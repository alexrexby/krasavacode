#!/bin/bash
# KRASAVACODE — установщик для macOS.
# Дабл-клик на этот файл — и всё установится само.
set -e

clear
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

# Кладём на рабочий стол ярлык, который дабл-кликается
cat > "$SHORTCUT" <<EOF
#!/bin/bash
cd "\$HOME"
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
echo "  Запустить прямо сейчас? [Enter — да, Ctrl+C — позже]"
read -r
exec "$BIN_PATH"
