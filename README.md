# KRASAVACODE

Однокнопочный бесплатный вайбкодинг на Claude Code — для учеников.

## Установка и запуск

### Вариант А — у меня есть Node.js

```bash
npx krasavacode
```

Всё. Pollinations работает без логина и без карты. Если у тебя Node старее 20 — наш CLI сам подтянет нужную версию.

### Вариант Б — у меня нет ничего

Скачай готовый бинарник из последнего релиза:
**https://github.com/alexrexby/krasavacode/releases/latest**

| Твоя ОС | Файл |
|---|---|
| Windows | `krasavacode.exe` |
| macOS Apple Silicon (M1/M2/M3/M4) | `krasavacode-mac-arm64` |
| macOS Intel | `krasavacode-mac-x64` |
| Linux x64 | `krasavacode-linux-x64` |

После скачивания — открой терминал в папке со скачанным файлом и запусти:

**Windows:**
```
krasavacode.exe
```
Если выскочит «Windows protected your PC» → жми **More info** → **Run anyway**.

**macOS:**
```bash
chmod +x krasavacode-mac-arm64
xattr -d com.apple.quarantine krasavacode-mac-arm64   # снимает блок Gatekeeper
./krasavacode-mac-arm64
```

**Linux:**
```bash
chmod +x krasavacode-linux-x64
./krasavacode-linux-x64
```

При первом запуске бинарник скачает Node.js и Claude Code в `~/.krasavacode/` (≈100 МБ, один раз). Дальше — мгновенно.

## Если хочется моделей помощнее

```bash
npx krasavacode upgrade
```

Откроется дашборд OmniRoute в браузере. Подключи одним кликом:
- **Kiro AI** — Claude Sonnet/Haiku через AWS Builder ID
- **Qoder** — Kimi K2 / Qwen3-Coder / DeepSeek-R1
- **Qwen Code** — 4 модели Alibaba
- **LongCat** — 50M токенов в день

Всё бесплатно, без карты.

## Если что-то не работает

```bash
npx krasavacode doctor
```

Покажет что сломано. Самые частые проблемы:
- **Корпоративный прокси / Россия / Китай** → запусти upgrade и в дашборде включи SOCKS5
- **Порт 3456 занят** → перезапусти терминал

## Что под капотом

```
krasavacode  →  claude-code-router (порт 3456)  →  Pollinations
                (Anthropic ↔ OpenAI bridge)        (free, no API key)
```

CLI = `@anthropic-ai/claude-code` с подменённым `ANTHROPIC_BASE_URL`. Все обновления Claude Code от Anthropic прилетают автоматом.

## Лицензия

MIT. Pollinations / Kiro AI / Qoder / другие провайдеры имеют свои ToS — читай их условия.
