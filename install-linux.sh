#!/bin/bash
# KRASAVACODE — установщик для Linux (Ubuntu/Debian/Fedora/etc).
# Запуск:  curl -fsSL https://is.gd/<short> | bash
set -e

if [ -t 1 ]; then clear || true; fi

echo ""
echo "  ╔════════════════════════════════════════════════════╗"
echo "  ║                  KRASAVACODE                       ║"
echo "  ║    Бесплатный вайбкодинг — установка для Linux     ║"
echo "  ╚════════════════════════════════════════════════════╝"
echo ""

# Архитектура
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) BIN_NAME="krasavacode-linux-x64" ;;
  aarch64|arm64)
    echo "  ⚠️  ARM64 (Apple Silicon Linux / Raspberry Pi) пока не поддерживается."
    echo "     Используй x86_64 или попробуй npx krasavacode."
    exit 1 ;;
  *)
    echo "  ⚠️  Неподдерживаемая архитектура: $ARCH"
    echo "     Попробуй npx krasavacode (нужен Node.js 20+)."
    exit 1 ;;
esac

# Проверяем зависимости
for cmd in curl chmod mkdir; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "  ⚠️  Не хватает команды: $cmd"; exit 1; }
done

INSTALL_DIR="$HOME/.local/bin"
BIN_PATH="$INSTALL_DIR/krasavacode"
PROJECTS="$HOME/krasavacode-projects"
URL="https://github.com/alexrexby/krasavacode/releases/latest/download/$BIN_NAME"

mkdir -p "$INSTALL_DIR"
mkdir -p "$PROJECTS"

echo "  📥 Скачиваю программу (≈100 МБ)…"
if curl -fL --progress-bar -o "$BIN_PATH" "$URL"; then
  echo "  ✓ Скачано: $(du -h "$BIN_PATH" | cut -f1)"
else
  echo ""
  echo "  ✗ Не удалось скачать. Проверь интернет."
  echo "    URL: $URL"
  exit 1
fi
chmod +x "$BIN_PATH"

# Проверяем что ~/.local/bin в PATH
ADDED_PATH=0
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ] && ! grep -q '\.local/bin' "$rc"; then
      echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
      ADDED_PATH=1
    fi
  done
fi

echo ""
echo "  ✅ Готово!"
echo ""
echo "  Программа установлена: $BIN_PATH"
echo "  Папка для проектов:    $PROJECTS"

if [ "$ADDED_PATH" = "1" ]; then
  echo ""
  echo "  ℹ️  Добавил $INSTALL_DIR в твой PATH (~/.bashrc / ~/.zshrc)."
  echo "     Перезапусти терминал или выполни: source ~/.bashrc"
fi

echo ""
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  СЛЕДУЮЩИЙ ШАГ — подключаем бесплатные ИИ"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Cerebras (14k запросов/день) — главное."
echo "  Опционально Groq, OpenRouter, Gemini для надёжности."
echo "  Всё бесплатно, без карты."
echo ""

# Если интерактивный терминал — запускаем setup сразу
if [ -t 0 ] && [ -t 1 ]; then
  echo "  Запускаю мастер подключения…"
  echo ""
  exec "$BIN_PATH" setup
else
  echo "  Запусти мастер: $BIN_PATH setup"
  echo "  Или просто: krasavacode setup  (после source ~/.bashrc)"
fi
