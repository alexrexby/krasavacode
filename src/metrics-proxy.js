import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { configuredProviders, PROVIDERS, PROVIDER_PRIORITY, getProviderModels } from './providers.js';
import { setCooldown, getCooldowns, cooldownUntil } from './cooldowns.js';
import { compressPayload } from './compression.js';
import { writeToSessionLog } from './session-log.js';

// Debug output destination:
//   KRASAVACODE_DEBUG=stderr → console.error (видно в терминале — ломает TUI Claude Code)
//   KRASAVACODE_DEBUG=1      → пишем только в session-log файл (по умолчанию)
//   no env / KRASAVACODE_DEBUG=0 → ничего
function dlog(msg) {
  const mode = process.env.KRASAVACODE_DEBUG;
  if (!mode || mode === '0') return;
  if (mode === 'stderr') {
    console.error(msg);
  } else {
    writeToSessionLog(msg);
  }
}

const ROOT = join(homedir(), '.krasavacode');
const USAGE_FILE = join(ROOT, 'usage.json');
const LAST_REQUEST_FILE = join(ROOT, 'last-request.json');

/**
 * Сохраняем тело первого /v1/messages запроса сессии в файл — это
 * ground-truth payload который Claude Code отправляет. Нужен для
 * диагностики случаев когда модель не вызывает tool_use (видимо
 * Claude Code шлёт что-то специфичное чего нет в моих синтетических
 * тестах). Алекс просит этот файл у ученика после неудачной сессии.
 *
 * Перезаписывается на КАЖДЫЙ первый запрос (т.е. первый user message
 * сессии) — не нужно копить историю, нужен один свежий пример.
 */
let _firstReqDumped = false;
async function dumpFirstRequest(bodyBuf) {
  if (_firstReqDumped) return;
  _firstReqDumped = true;
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8'));
    // Только если это первый user-message (нет ассистент-ответов ещё)
    const hasAssistant = (parsed.messages || []).some(m => m.role === 'assistant');
    if (hasAssistant) { _firstReqDumped = false; return; }
    await mkdir(ROOT, { recursive: true });
    await writeFile(LAST_REQUEST_FILE, JSON.stringify({
      capturedAt: new Date().toISOString(),
      note: 'Первый user-message сессии. Пришли этот файл наставнику если модель не создаёт файлы.',
      body: parsed,
    }, null, 2));
  } catch {} // не валим запрос если dump не получился
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

async function readUsage() {
  try { return JSON.parse(await readFile(USAGE_FILE, 'utf8')); }
  catch { return {}; }
}
async function writeUsage(u) {
  await mkdir(ROOT, { recursive: true });
  await writeFile(USAGE_FILE, JSON.stringify(u, null, 2));
}

async function bump(providerId) {
  const u = await readUsage();
  const day = todayKey();
  if (!u[day]) u[day] = {};
  if (typeof u[day] === 'number') u[day] = { _total: u[day] };
  u[day][providerId || '_unknown'] = (u[day][providerId || '_unknown'] || 0) + 1;
  u[day]._total = (u[day]._total || 0) + 1;
  u.lastRequestAt = new Date().toISOString();
  for (const k of Object.keys(u)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
      const age = (Date.now() - new Date(k).getTime()) / 86400000;
      if (age > 30) delete u[k];
    }
  }
  await writeUsage(u);
}

export async function getTodayUsage() {
  const u = await readUsage();
  const today = u[todayKey()];
  if (!today) return 0;
  if (typeof today === 'number') return today;
  return today._total || 0;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Pick the first available (provider, model) pair not on cooldown and not already tried.
 * `tried` is a Map<providerId, Set<modelName>> tracking what we attempted this request.
 *
 * For each provider in priority order (skipping cooldowns), tries models in order
 * (default first). Если все модели данного провайдера попробованы — переходит
 * к следующему провайдеру.
 */
async function chooseProviderAndModel(tried) {
  const cd = await getCooldowns();
  const configured = await configuredProviders();
  const now = Date.now();
  const onCooldown = (id) => cd[id] && new Date(cd[id]).getTime() > now;

  for (const id of configured) {
    if (onCooldown(id)) continue;
    const triedSet = tried.get(id) || new Set();
    for (const m of getProviderModels(id)) {
      if (!triedSet.has(m)) return { id, model: m };
    }
  }
  return null;
}

// Detect 400 responses caused by the chosen model not supporting tool use.
// These are model-level, not provider-level — we retry the SAME provider with
// the next model rather than cooling it down. Patterns seen in the wild:
//   Polza:      "No endpoints found that support tool use"
//   OpenRouter: "does not support tool use" / "doesn't support function call"
const TOOL_INCOMPAT_RE = /no endpoints found that support tool use|does(?:n't| not) support (?:tool|function)|tool (?:use|calls?) (?:is )?not supported/i;

function isToolIncompatibility(body) {
  return TOOL_INCOMPAT_RE.test(body || '');
}

function parseQuotaReason(upstreamBody) {
  try {
    const parsed = JSON.parse(upstreamBody);
    const violations = parsed.error?.details?.find(d => d['@type']?.includes('QuotaFailure'))?.violations;
    if (violations?.length) {
      const id = violations[0].quotaId || violations[0].quotaMetric || '';
      if (/PerMinute/i.test(id)) return 'per-minute';
      return 'per-day';
    }
    const msg = String(parsed.error?.message || '').toLowerCase();
    if (msg.includes('per minute') || msg.includes('per-minute') || msg.includes('rpm')) return 'per-minute';
    if (msg.includes('per day') || msg.includes('per-day') || msg.includes('rpd') || msg.includes('quota')) return 'per-day';
  } catch {}
  return null;
}

const FRIENDLY_429 = () => ({
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message:
      `Все настроенные AI-провайдеры исчерпаны или временно перегружены.\n\n` +
      `Что делать:\n` +
      `  • Подожди 1–2 минуты (если упёрлись в RPM) и попробуй опять\n` +
      `  • Подключи ещё провайдер: krasavacode setup\n` +
      `  • Дневные лимиты обновляются в ~11:00 МСК`,
  },
});

/**
 * Loop-guard: некоторые модели (GLM 4.7 Flash, DeepSeek V4 Flash) в agentic
 * loop'е могут зависнуть, повторяя один и тот же tool_use 10+ раз подряд.
 * Сжигают токены, висят 30+ минут, ученик не понимает что делать.
 *
 * Если в текущем запросе ПОСЛЕДНИЕ N assistant turn'ов имеют одинаковый
 * tool_use (name + input) — обрываем цикл, возвращая fake Claude-style
 * ответ с stop_reason='end_turn' и инструкцией ученику.
 */
const LOOP_THRESHOLD = 3; // три повтора подряд → стоп

function detectLoop(parsedBody) {
  const messages = parsedBody?.messages;
  if (!Array.isArray(messages)) return null;
  const sigs = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const toolUses = blocks.filter(b => b?.type === 'tool_use');
    if (toolUses.length === 0) continue;
    // Сигнатура turn'а — упорядоченный список (name, hash(input))
    const sig = toolUses.map(tu => {
      let inputStr = '';
      try { inputStr = JSON.stringify(tu.input || {}); } catch {}
      return `${tu.name}:${inputStr.slice(0, 500)}`;
    }).join('|');
    sigs.push(sig);
  }
  if (sigs.length < LOOP_THRESHOLD) return null;
  const lastN = sigs.slice(-LOOP_THRESHOLD);
  if (lastN.every(s => s === lastN[0])) {
    // Достаём первое имя tool'а для понятного сообщения
    const firstTool = lastN[0].split(':')[0] || 'инструмент';
    return firstTool;
  }
  return null;
}

function loopStopResponse(toolName) {
  return {
    id: `msg_loop_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: 'krasavacode-loop-guard',
    content: [{
      type: 'text',
      text:
        `⚠️ Модель зациклилась — повторяет ${toolName} раз за разом.\n\n` +
        `Что делать:\n` +
        `  1. Нажми Ctrl+C чтобы остановить.\n` +
        `  2. Перезапусти: krasavacode\n` +
        `  3. Сформулируй задачу более конкретно. Например:\n` +
        `     вместо «сделай калькулятор»\n` +
        `     попробуй «создай один файл index.html с формой:\n` +
        `     поле для площади, кнопка "посчитать", вывод стоимости»\n\n` +
        `Чем конкретнее задача — тем меньше модель путается.`,
    }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/**
 * Strict OpenAI-compat providers (Polza) reject Anthropic-style payloads:
 *   - content as array of text blocks → must be plain string
 *   - cache_control on any block → unknown property
 *   - reasoning / thinking fields → unknown property
 *
 * Collapse arrays-of-text-blocks into joined strings.
 */
function flattenTextBlocks(value) {
  if (typeof value === 'string') return value;
  if (!value) return '';
  if (Array.isArray(value)) {
    return value
      .filter(b => b && (b.type === 'text' || typeof b.text === 'string'))
      .map(b => b.text || '')
      .join('\n\n');
  }
  if (typeof value === 'object' && typeof value.text === 'string') return value.text;
  return '';
}

// Anthropic payload содержит расширения которых OpenAI-compat API
// не понимает (cache_control, content-arrays, reasoning, thinking).
// Polza 400-ит на таких. Очищаем перед форвардом.
function cleanForOpenAICompat(parsed) {
  delete parsed.reasoning;
  delete parsed.thinking;
  delete parsed.metadata;

  if (parsed.system !== undefined) {
    parsed.system = flattenTextBlocks(parsed.system);
  }
  if (Array.isArray(parsed.messages)) {
    for (const m of parsed.messages) {
      if (Array.isArray(m.content) || (m.content && typeof m.content === 'object')) {
        m.content = flattenTextBlocks(m.content);
      }
    }
  }
}

// Только Polza получает clean — у OpenRouter есть свой transformer в ccr
// который сам конвертирует Anthropic ↔ OpenAI, ему не нужно.
const OPENAI_COMPAT_PROVIDERS = new Set(['polza']);

function rewriteBodyWithProvider(originalBody, providerId, modelName) {
  try {
    const parsed = JSON.parse(originalBody);
    parsed.model = `${providerId},${modelName}`;
    if (OPENAI_COMPAT_PROVIDERS.has(providerId)) cleanForOpenAICompat(parsed);
    const stats = compressPayload(parsed);
    const pct = stats.before > 0 ? ((stats.saved / stats.before) * 100).toFixed(1) : '0.0';
    dlog(`[compress] ${providerId}: -${stats.saved}b (${pct}%) — ${stats.before}→${stats.after}`);
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return originalBody;
  }
}

// Хард-таймаут на response-headers: если апстрим не начал отвечать за
// 5 минут — рвём соединение, чтобы ученик не сидел над «Accomplishing… 8m»
// бесконечно. Сам стрим после headers — без таймаута (длинные ответы ок).
const UPSTREAM_RESPONSE_HEADERS_TIMEOUT_MS = 5 * 60 * 1000;

function forward(upstream, method, path, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path,
      method,
      headers: {
        ...headers,
        host: `${upstream.hostname}:${upstream.port}`,
        'content-length': bodyBuffer ? bodyBuffer.length : 0,
      },
    }, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`upstream did not respond within ${UPSTREAM_RESPONSE_HEADERS_TIMEOUT_MS / 1000}s`));
    }, UPSTREAM_RESPONSE_HEADERS_TIMEOUT_MS);
    if (bodyBuffer && bodyBuffer.length) req.write(bodyBuffer);
    req.end();
  });
}

export async function startMetricsProxy(upstreamBaseUrl) {
  const upstream = new URL(upstreamBaseUrl);
  const port = await getFreePort();

  const server = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0];
    const isMessages = req.method === 'POST' && path === '/v1/messages';
    const isModelList = req.method === 'GET' && path === '/v1/models';
    dlog(`[metrics] ${req.method} ${req.url}`);

    // Claude Code v2.1+ asks GET /v1/models BEFORE sending any request,
    // and refuses models that aren't in the response. Our upstream (ccr → provider)
    // returns provider-specific slugs — no Claude models. Fake the list ourselves.
    if (isModelList) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        data: [
          { id: 'claude-sonnet-4-7', type: 'model', display_name: 'Claude Sonnet 4.7' },
          { id: 'claude-sonnet-4-6', type: 'model', display_name: 'Claude Sonnet 4.6' },
          { id: 'claude-sonnet-4-5', type: 'model', display_name: 'Claude Sonnet 4.5' },
          { id: 'claude-opus-4-7', type: 'model', display_name: 'Claude Opus 4.7' },
          { id: 'claude-haiku-4-5', type: 'model', display_name: 'Claude Haiku 4.5' },
        ],
        has_more: false,
      }));
    }

    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      const originalBody = Buffer.concat(chunks);

      if (!isMessages) {
        try {
          const upRes = await forward(upstream, req.method, req.url, req.headers, originalBody);
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'upstream_error', message: e.message } }));
        }
        return;
      }

      // Loop-guard: до выбора провайдера парсим тело и смотрим не повторяет
      // ли модель один и тот же tool_use 3+ раз подряд. Если да — обрываем
      // цикл, не идём в апстрим. Spares the user from 1h+ burn loops.
      try {
        const parsed = JSON.parse(originalBody.toString('utf8'));
        const loopTool = detectLoop(parsed);
        if (loopTool) {
          dlog(`[metrics] LOOP GUARD: ${loopTool} повторился ${LOOP_THRESHOLD}+ раз — обрываю`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(loopStopResponse(loopTool)));
          return;
        }
      } catch {} // если тело не парсится — идём дальше, апстрим разберётся

      // Diagnostic: дамп ground-truth payload первого запроса сессии — нужен
      // когда модель не вызывает tool_use и непонятно почему.
      dumpFirstRequest(originalBody).catch(() => {});

      // /v1/messages: provider+model selection with retry-on-failure.
      // tried: Map<providerId, Set<modelName>> — модели уже попробованные в
      // рамках этого запроса (не путать с per-provider cooldown).
      const tried = new Map();
      const markTried = (id, model) => {
        if (!tried.has(id)) tried.set(id, new Set());
        tried.get(id).add(model);
      };
      // Каждый провайдер × модель = одна попытка. Плюс небольшой запас.
      const totalSlots = (await configuredProviders())
        .reduce((acc, id) => acc + getProviderModels(id).length, 0);
      const maxAttempts = Math.max(totalSlots + 1, 3);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let choice = await chooseProviderAndModel(tried);
        // All providers on cooldown (and нет неопробованных моделей)? Ждём до 30s
        // пока самый ранний cooldown не отпустит.
        if (!choice) {
          dlog('[metrics] all on cooldown — wait up to 30s');
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            choice = await chooseProviderAndModel(tried);
            if (choice) break;
          }
        }
        if (!choice) {
          dlog('[metrics] no available (provider,model) pairs after 30s wait');
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(FRIENDLY_429()));
          return;
        }

        const rewrittenBody = rewriteBodyWithProvider(originalBody, choice.id, choice.model);
        dlog(`[metrics] attempt ${attempt}: routing to ${choice.id},${choice.model}`);

        let upRes;
        try {
          upRes = await forward(upstream, req.method, req.url, req.headers, rewrittenBody);
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'upstream_error', message: e.message } }));
          return;
        }

        dlog(`[metrics] attempt ${attempt}/${maxAttempts} → ${upRes.statusCode} (${choice.id},${choice.model})`);

        // 4xx provider failures → mark cooldown and retry next provider.
        // We retry on:
        //   400 — payload incompatible (cache_control etc) ИЛИ model без tool use
        //   401 — invalid/expired key
        //   403 — billing block / disabled
        //   404 — model name not on this provider (e.g. OpenRouter renamed)
        //   429 — rate limit / quota
        //   5xx — provider transient errors
        // Other non-2xx → pass through to client.
        const code = upRes.statusCode;
        const isRetryable = code === 400 || code === 401 || code === 403
          || code === 404 || code === 429 || (code >= 500 && code < 600);
        if (!isRetryable) {
          if (upRes.statusCode >= 200 && upRes.statusCode < 300) {
            bump(choice.id).catch(() => {});
          }
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
          return;
        }

        const errChunks = [];
        upRes.on('data', d => errChunks.push(d));
        await new Promise(r => upRes.on('end', r));
        const upBody = Buffer.concat(errChunks).toString('utf8');
        dlog(`[metrics] ${upRes.statusCode} from ${choice.id}: ${upBody.slice(0, 200)}`);

        // Помечаем (provider,model) как опробованные — в этом запросе мы к ним
        // больше не вернёмся, даже если cooldown не ставим.
        markTried(choice.id, choice.model);

        // 400 + tool-incompatibility = проблема КОНКРЕТНОЙ модели, не провайдера.
        // Не cooldown'им провайдер, просто пробуем следующую модель из его списка.
        if (code === 404 || (code === 400 && isToolIncompatibility(upBody))) {
          dlog(`[metrics] model-level error (${code}) on ${choice.id},${choice.model} — try next model on same provider`);
          continue;
        }

        let effectiveReason;
        if (code === 401 || code === 403) {
          // Invalid/expired/blocked key — provider is dead until user re-runs setup.
          effectiveReason = 'per-day';
        } else if (code === 400) {
          // 400 без tool-incompat-сигнала = payload mismatch. cleanForOpenAICompat
          // снимает большинство таких; hour-cooldown достаточно.
          effectiveReason = 'per-hour';
        } else if (code >= 500) {
          effectiveReason = 'per-minute';
        } else {
          effectiveReason = parseQuotaReason(upBody);
        }
        await setCooldown(choice.id, cooldownUntil(effectiveReason));
      }

      // Exhausted attempts
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(FRIENDLY_429()));
    });

    req.on('error', () => {});
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise(r => server.close(r)),
  };
}

export async function getQuotaInfo() {
  return {
    used: await getTodayUsage(),
    configured: await configuredProviders(),
    cooldowns: await getCooldowns(),
  };
}
