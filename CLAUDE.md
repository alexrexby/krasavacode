# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ESM Node.js wrapper, который заворачивает оригинальный `@anthropic-ai/claude-code` в локальный gateway-chain. Ученик подключает один или несколько бесплатных AI-провайдеров через браузерный wizard, и при 429 от одного провайдера chain автоматически переключается на следующий — провайдер выбирается на стороне нашего metrics-proxy путём подмены `body.model` на формат `"<provider>,<model>"` перед форвардом в `claude-code-router`.

Точки входа:
- `bin/krasavacode.js` — единственный CLI entrypoint. Сабкоманды: `doctor`, `upgrade`, `setup` (alias: `setup-gemini`, `gemini`), `--version`. Без аргументов — обычный launch flow: `ensureRuntime → ensurePreset → startHub → launchClaude → stopHub`.
- `src/runtime.js` — выбирает Node (system ≥ 20 или bundled через `node-installer.js`), `npm install`-ит `@anthropic-ai/claude-code` и `@musistudio/claude-code-router` в `~/.krasavacode/runtime/`. State в `~/.krasavacode/state.json`.
- `src/providers.js` — реестр трёх free-провайдеров: Cerebras / Groq / Gemini. Для каждого: console URL, regex для ключа, тестовый verify-запрос, ccr-конфиг блок. `PROVIDER_PRIORITY` определяет порядок fallback. Pollinations добавляется отдельно как последний резерв.
- `src/setup.js` — браузерный wizard на свободном порту с тремя табами. Поддерживает любую комбинацию провайдеров. Сохраняет ключи в `~/.krasavacode/keys/<provider>.env` (chmod 600). Имеет CLI fallback.
- `src/preset.js` — пишет `~/.claude-code-router/config.json` с маркером `_krasavacode: 'krasavacode/managed'`. Все настроенные провайдеры + Pollinations попадают в `Providers`. Если у пользователя уже свой config без маркера — копирует в `.backup-<ts>`.
- `src/cooldowns.js` — `~/.krasavacode/cooldowns.json`: per-provider timestamps. `cooldownUntil('per-minute')` = +60s, `cooldownUntil('per-day')` = до 11:00 МСК следующего дня. Pollinations всегда получает per-minute независимо от reason.
- `src/hub.js` — спавнит `ccr start` на порту `3456` (singleton), сверху ставит `metrics-proxy` на свободном порту, возвращает `metrics.baseUrl` как `hub.baseUrl`. Inject'ит env-переменные ключей провайдеров (`CEREBRAS_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`) в spawn ccr — config.json ссылается на них через interpolation.
- `src/metrics-proxy.js` — HTTP-прокси `Claude → ccr`. **Ядро multi-provider chain.** На каждый `POST /v1/messages`: выбирает провайдера через `chooseProvider()` (skip cooldown'ы), подменяет `body.model = "provider,name"`, форвардит в ccr. При 429 — парсит причину, ставит cooldown, ретраит с другим провайдером (до 4 попыток). При 2xx — `bump(providerId)` в `~/.krasavacode/usage.json`.
- `src/launch.js` — спавнит `claude --bare` с `ANTHROPIC_BASE_URL=hub.baseUrl` и `ANTHROPIC_API_KEY=sk-krasavacode-local`. Перед спавном чистит env от настоящих Anthropic-кредов. Баннер показывает chain настроенных провайдеров и их cooldown-статус.
- `src/upgrade.js` — ставит `omniroute` (только если запущен) и открывает его дашборд на `:20128` для подключения OAuth-провайдеров (Kiro/Qoder/LongCat).
- `src/node-installer.js` — лениво качает Node 22.11.0 с nodejs.org в `~/.krasavacode/runtime/node/` если системного нет.
- `scripts/smoke.js` — проводит full pipeline без интерактивного Claude и шлёт пробный запрос.
- `install-mac.command` / `install-windows.bat` — самораспаковывающиеся скрипты для учеников (на стороне пользователя, не часть npm-пакета).
- `.github/workflows/build-binaries.yml` (на тег `v*`) — собирает Bun-бинарники для Mac arm64/x64, Win, Linux x64 в GH Release.
- `.github/workflows/publish-npm.yml` — `workflow_dispatch` (manual). Публикация в npm — руками через `npm publish`.

**Sync points:**
- Версия в `package.json` и в `bin/krasavacode.js` (`const VERSION = '...'`) — должны совпадать. Хардкод нужен потому что Bun `--compile` не имеет FS-доступа к `package.json` в собранном бинарнике.
- `CCR_PORT = 3456` экспортируется из `src/preset.js` и импортируется в `src/hub.js`. Других hardcoded-копий быть не должно.
- `PROVIDER_PRIORITY` в `providers.js` — единственный источник истины для порядка fallback. И `chooseProvider()` в `metrics-proxy.js`, и баннер в `launch.js`, и реестр в `setup.js` его уважают.

## Running

`KRASAVACODE_DEBUG=1` — пробрасывает stdout ccr и логирует metrics-proxy retry-flow. `KRASAVACODE_BARE=0` — отключает `--bare` флаг для отладки. `KRASAVACODE_NO_BROWSER=1` — заставляет setup использовать CLI-fallback.

```bash
node bin/krasavacode.js                     # из этого репо
npx krasavacode                              # после `npm publish`

node bin/krasavacode.js doctor               # диагностика + статус провайдеров
node bin/krasavacode.js setup                # браузерный wizard (Cerebras/Groq/Gemini)
node bin/krasavacode.js upgrade              # OmniRoute дашборд (OAuth-провайдеры)

node scripts/smoke.js                        # smoke без интерактивного Claude

npm run build:binaries                       # требует Bun, → dist/krasavacode-{platform}
```

No tests, linter, or build step. CI собирает бинарники только при пуше тега `v*`.

## Notes

- **`--bare` mode критичен.** `src/launch.js` всегда добавляет `--bare` к claude-args. Без него Claude Code v2.1+ читает credentials из macOS Keychain (`Claude Code-credentials`, `Claude Safe Storage`) и светит реальный Anthropic-аккаунт пользователя в welcome screen. Побочки: пропускаются auto-memory, plugin sync, CLAUDE.md auto-discovery, LSP — для учеников норма.
- **Auth-режим: API key, не token.** `--bare` принимает только `ANTHROPIC_API_KEY`. `launch.js` явно стирает `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_VERTEX_PROJECT_ID`/`ANTHROPIC_BEDROCK_BASE_URL` из inherit-env, ставит только свой `ANTHROPIC_API_KEY=sk-krasavacode-local` (плейсхолдер; metrics-proxy его не валидирует).
- **CCR singleton на 3456.** `hub.js` сначала пробит `GET http://127.0.0.1:3456/`. Если что-то отвечает — считает что это уже наш ccr, возвращает `ownedByUs: false` и **не убивает** при exit.
- **Provider selection — body.model rewriting, не ccr custom router.** Ранее пробовали `CUSTOM_ROUTER_PATH` в config — он не подцеплялся ccr v2.0.0. Текущая стратегия: `metrics-proxy` парсит JSON request body, переписывает `model: "claude-sonnet-4-5"` на `model: "<providerId>,<modelName>"`, и ccr форвардит без роутинга (документированное поведение CCR при `provider,model` формате).
- **Pollinations cooldown — всегда 60 секунд.** В отличие от Cerebras/Groq/Gemini у Pollinations нет per-day квоты, только burst-throttling. `metrics-proxy` форсит `effectiveReason = 'per-minute'` для Pollinations независимо от того что вернул API.
- **`api_key` в config.json — interpolation, не plain text.** `preset.js` пишет `"api_key": "$GEMINI_API_KEY"` etc. Сами ключи хранятся в `~/.krasavacode/keys/<id>.env` (chmod 600), читаются `loadProviderKey()` и инжектятся в env при `spawn(ccr)` в `hub.js`.
- **Free-tier квоты (на май 2026):** Gemini 2.5 Flash — 250 RPD / 10 RPM / 250k TPM. Groq Kimi K2 — 1000 RPD / 30 RPM. Cerebras Qwen3 235B — 1M токенов/день / 30 RPM, **8K контекст-лимит на free**. Один user-message в Claude Code = 3-10 API-запросов из-за tool-use.
- **Legacy migration:** `loadProviderKey('gemini')` сначала читает `~/.krasavacode/keys/gemini.env`, потом fallback `~/.krasavacode/gemini.env` (старый layout v0.3.x). Для Cerebras/Groq legacy-пути нет — они новые.
- **`--print` обходит интерактив.** Claude Code в `--print` режиме не показывает welcome screen, поэтому при тестировании в non-TTY среде welcome-проблема не воспроизводится.
- **Pollinations URL — classic API.** `text.pollinations.ai/openai/chat/completions`, модель `openai` = `gpt-oss-20b`. Pollinations выкатили новый `enter.pollinations.ai` — он несовместим (404 на classic пути).
- **Установщики не часть npm-пакета.** `install-mac.command` и `install-windows.bat` распространяются только через GitHub raw URL (`/raw/main/...`).
