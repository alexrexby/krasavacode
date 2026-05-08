# KRASAVACODE

Однокнопочный бесплатный вайбкодинг на Claude Code — для учеников.

## Установка и запуск

**Один способ:**

```bash
npx krasavacode
```

Всё. Pollinations работает без логина и без карты, лимитов хватит на 2–5 учебных MVP.

При первой команде ставится локальный gateway и Claude Code (один раз, ~30 сек). Потом запуск моментальный.

## Если хочешь больше моделей

```bash
npx krasavacode upgrade
```

Откроется дашборд в браузере. Там одним кликом подключишь:
- **Kiro AI** — Claude Sonnet/Haiku через AWS Builder ID
- **Qoder** — Kimi K2 / Qwen3-Coder / DeepSeek-R1
- **Qwen Code** — 4 модели Alibaba
- **LongCat** — 50M токенов в день

Всё бесплатно, без карты.

## Если что-то не работает

```bash
npx krasavacode doctor
```

Покажет, что сломано. Самые частые проблемы:
- **Старый Node.js** → обнови до 20+ с https://nodejs.org
- **Порт занят** → перезапусти терминал
- **Корпоративный прокси/Россия/Китай** → запусти upgrade и в дашборде включи SOCKS5

## Что под капотом

```
krasavacode  →  локальный OmniRoute  →  Pollinations / Kiro / Qoder / …
                (free gateway, MIT)     (free providers без карты)
```

CLI = `@anthropic-ai/claude-code` с подменённым backend. Все обновления Claude Code от Anthropic прилетают автоматом.

## Бинарники без Node.js

Для уроков с непрофильными студентами — скачай готовый бинарник со страницы релиза:
- `krasavacode.exe` (Windows)
- `krasavacode-mac-arm64`, `krasavacode-mac-x64` (macOS)
- `krasavacode-linux-x64` (Linux)

Дабл-клик → откроется терминал с Claude Code. Node.js не нужен.

> Замечание: бинарники тащат portable Node при первом запуске (~30 МБ, один раз). После — работают офлайн.

## Лицензия

MIT. Pollinations / Kiro AI / Qoder / другие провайдеры имеют свои ToS — читай их условия. На свой риск.
