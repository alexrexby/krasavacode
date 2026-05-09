# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ESM Node.js wrapper, который заворачивает оригинальный `@anthropic-ai/claude-code` в локальный gateway, чтобы ученик получал бесплатный вайбкодинг через Pollinations или Gemini, не открывая Anthropic-аккаунт. Сами зависимости (claude-code, claude-code-router) ставятся в `~/.krasavacode/runtime/` при первом запуске — ничего глобально в систему не пишется.

Точки входа:
- `bin/krasavacode.js` — единственный CLI entrypoint. Сабкоманды: `doctor`, `upgrade`, `setup-gemini`/`gemini`, `--version`. Без аргументов — обычный launch flow: `ensureRuntime → ensurePreset → startHub → launchClaude → stopHub`.
- `src/runtime.js` — выбирает Node (system ≥ 20 или bundled через `node-installer.js`), `npm install`-ит `@anthropic-ai/claude-code` и `@musistudio/claude-code-router` в `~/.krasavacode/runtime/`. Хранит state в `~/.krasavacode/state.json`.
- `src/preset.js` — пишет `~/.claude-code-router/config.json` с маркером `_krasavacode: 'krasavacode/managed'`. Если у пользователя уже свой config без маркера — копирует в `.backup-<ts>` перед перезаписью.
- `src/hub.js` — спавнит `ccr start` на порту `3456` (singleton), сверху ставит `metrics-proxy` на свободном порту, возвращает `metrics.baseUrl` как `hub.baseUrl` — Claude Code ходит туда.
- `src/metrics-proxy.js` — HTTP-прокси `Claude → ccr`, считает каждый `POST /v1/messages` с 2xx как 1 запрос в `~/.krasavacode/usage.json` (хранит 30 дней), и подменяет `429` на русское сообщение.
- `src/launch.js` — спавнит `claude --bare` с `ANTHROPIC_BASE_URL=hub.baseUrl` и `ANTHROPIC_API_KEY=sk-krasavacode-local`. Перед спавном чистит env от настоящих Anthropic-кредов.
- `src/setup-gemini.js` — поднимает HTTP-сервер с inline HTML wizard на свободном порту, валидирует ключ через тестовый `gemini-2.5-flash:generateContent`, сохраняет в `~/.krasavacode/gemini.env` (chmod 600). Имеет CLI fallback.
- `src/upgrade.js` — ставит `omniroute` (только если запущен) и открывает его дашборд на `:20128` для подключения OAuth-провайдеров (Kiro/Qoder/LongCat).
- `src/node-installer.js` — лениво качает Node 22.11.0 с nodejs.org в `~/.krasavacode/runtime/node/` если системного нет.
- `scripts/smoke.js` — единственный тестовый скрипт: проводит full pipeline без интерактивного Claude и шлёт пробный запрос к `/v1/messages`.
- `install-mac.command` / `install-windows.bat` — самораспаковывающиеся скрипты для учеников (на стороне пользователя, не часть npm-пакета).
- `.github/workflows/build-binaries.yml` (на тег `v*`) — собирает Bun-бинарники для Mac arm64/x64, Win, Linux x64 в GH Release.
- `.github/workflows/publish-npm.yml` — `workflow_dispatch` (manual). Публикация в npm — руками через `npm publish`.

**Sync points:**
- Версия в `package.json` и в `bin/krasavacode.js` (`const VERSION = '...'`) — должны совпадать. Хардкод нужен потому что Bun `--compile` не имеет FS-доступа к `package.json` в собранном бинарнике.
- `CCR_PORT = 3456` экспортируется из `src/preset.js` и импортируется в `src/hub.js`. Других hardcoded-копий быть не должно.

## Running

Никаких env vars для основного запуска не нужно. Опциональные: `KRASAVACODE_DEBUG=1` (пробрасывает stdout ccr и логирует metrics-proxy), `KRASAVACODE_BARE=0` (отключает `--bare` флаг для отладки).

```bash
# Основной запуск
node bin/krasavacode.js                     # из этого репо
npx krasavacode                              # после `npm publish`

# Сабкоманды
node bin/krasavacode.js doctor               # диагностика
node bin/krasavacode.js setup-gemini         # браузерный wizard для Gemini
node bin/krasavacode.js upgrade              # OmniRoute дашборд

# Smoke-тест pipeline без интерактивного Claude Code
node scripts/smoke.js

# Сборка нативных бинарников (требует Bun)
npm run build:binaries                       # → dist/krasavacode-{platform}
```

No tests, linter, or build step. CI собирает бинарники только при пуше тега `v*`.

## Notes

- **`--bare` mode критичен.** `src/launch.js` всегда добавляет `--bare` к claude-args. Без него Claude Code v2.1+ читает credentials из macOS Keychain (`Claude Code-credentials`, `Claude Safe Storage`) и светит реальный Anthropic-аккаунт пользователя в welcome screen. `--bare` гарантирует «OAuth and keychain are never read». Побочки: пропускаются auto-memory, plugin sync, CLAUDE.md auto-discovery, LSP — для учеников норма, при отладке выключаемо через `KRASAVACODE_BARE=0`.
- **Auth-режим: API key, не token.** `--bare` принимает только `ANTHROPIC_API_KEY`, не `ANTHROPIC_AUTH_TOKEN`. `launch.js` явно стирает оба + `ANTHROPIC_VERTEX_PROJECT_ID` + `ANTHROPIC_BEDROCK_BASE_URL` из inherit-env, ставит только свой `ANTHROPIC_API_KEY=sk-krasavacode-local` (плейсхолдер; metrics-proxy его не валидирует).
- **CCR singleton на 3456.** `hub.js` сначала пробит `GET http://127.0.0.1:3456/`. Если что-то отвечает — считает что это уже наш ccr, возвращает `ownedByUs: false` и **не убивает** при exit. Если это какой-то другой сервис — будет undefined behavior.
- **metrics-proxy НЕ парсит SSE.** Считает по статус-коду upstream-ответа, не по событиям внутри стрима. Если стрим оборвался error-event'ом — счётчик всё равно инкрементируется. Известный минорный bug.
- **`api_key` в config.json — interpolation, не plain text.** `preset.js` пишет `"api_key": "$GEMINI_API_KEY"`. Сам ключ хранится в `~/.krasavacode/gemini.env` (chmod 600), читается `loadGeminiKey()` и инжектится в env при `spawn(ccr)` в `hub.js`.
- **Free-tier Gemini только flash.** `gemini-2.5-pro` имеет `limit: 0` на free плане Google. `preset.js` ставит `gemini-2.5-flash` во ВСЕ слоты Router (`default`/`background`/`think`/`longContext`). Не менять на pro без проверки квоты.
- **`--print` обходит интерактив.** Claude Code в `--print` режиме не показывает welcome screen, поэтому при тестировании в non-TTY среде welcome-проблема не воспроизводится — нужен интерактивный запуск.
- **Pollinations URL — classic API.** `text.pollinations.ai/openai/chat/completions`, модель `openai` = `gpt-oss-20b`. Pollinations выкатили новый `enter.pollinations.ai` — он несовместим (404 на classic пути).
- **Установщики не часть npm-пакета.** `install-mac.command` и `install-windows.bat` распространяются только через GitHub raw URL (`/raw/main/...`). Они качают бинарь из GH Release, не из npm.
