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
 * Сохраняем тело КАЖДОГО запроса с реальными tools (т.е. пользовательской
 * задачи, не служебной title-генерации). Перезаписываем — пусть Алекс
 * всегда видит последний живой ground-truth payload, не первый.
 *
 * Используется для диагностики случаев когда модель ведёт себя странно
 * (циклы LS, не вызывает Write, висит). После проблемной сессии ученик
 * присылает этот файл.
 */
async function dumpLatestRequest(bodyBuf) {
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8'));
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    const hasOutputConfig = parsed.output_config != null;
    if (!hasTools || hasOutputConfig) return;
    await mkdir(ROOT, { recursive: true });
    await writeFile(LAST_REQUEST_FILE, JSON.stringify({
      capturedAt: new Date().toISOString(),
      note: 'Последний запрос с tools от Claude Code. Перезаписывается на каждый. Пришли наставнику если модель ведёт себя странно.',
      messagesCount: (parsed.messages || []).length,
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
 * Loop-guard: модели зацикливаются на исследовании структуры папки —
 * LS → LS → LS с разными аргументами всё глубже, никогда не пишут Write.
 * Подсчёт идентичных сигнатур (старая версия) не ловит — каждый LS уникален
 * по path. Новая стратегия:
 *
 *   1. ИДЕНТИЧНЫЕ повторы: 3+ одинаковых tool_use (name+input) подряд → стоп.
 *   2. Тот же НАЗВАНИЕ: один и тот же tool name 4+ раз в последних 6 turn'ах
 *      (даже с разными аргументами — это «исследовательский цикл»).
 *
 * Защищает от LS-каскадов, повторных Bash «pwd/ls», бесконечных Read.
 */
const LOOP_IDENTICAL_THRESHOLD = 3;     // 3 одинаковых tool_use подряд
const LOOP_SAMENAME_THRESHOLD = 4;      // 4+ вызовов одного name
const LOOP_SAMENAME_WINDOW = 6;         // в окне последних N turn'ов

function detectLoop(parsedBody) {
  const messages = parsedBody?.messages;
  if (!Array.isArray(messages)) return null;
  // Собираем по каждому assistant turn'у список tool_use blocks
  const turns = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const toolUses = blocks.filter(b => b?.type === 'tool_use');
    if (toolUses.length === 0) continue;
    const sig = toolUses.map(tu => {
      let inputStr = '';
      try { inputStr = JSON.stringify(tu.input || {}); } catch {}
      return `${tu.name}:${inputStr.slice(0, 500)}`;
    }).join('|');
    const names = toolUses.map(tu => tu.name);
    turns.push({ sig, names });
  }

  // (1) идентичные подряд
  if (turns.length >= LOOP_IDENTICAL_THRESHOLD) {
    const lastN = turns.slice(-LOOP_IDENTICAL_THRESHOLD);
    if (lastN.every(t => t.sig === lastN[0].sig)) {
      return lastN[0].sig.split(':')[0] || 'инструмент';
    }
  }

  // (2) тот же name в окне — детектим LS-каскады
  if (turns.length >= LOOP_SAMENAME_THRESHOLD) {
    const window = turns.slice(-LOOP_SAMENAME_WINDOW);
    const counter = new Map();
    for (const t of window) {
      for (const n of t.names) counter.set(n, (counter.get(n) || 0) + 1);
    }
    for (const [name, count] of counter) {
      if (count >= LOOP_SAMENAME_THRESHOLD) return name;
    }
  }

  return null;
}

/**
 * Claude Code v2.1.140 шлёт служебный title-generation запрос ДО основного:
 *   - model: claude-haiku-4-5-...
 *   - system: «Generate a concise, sentence-case title (3-7 words)...»
 *   - tools: []
 *   - output_config.format.type: json_schema with {title: string}
 *
 * Polza (и провайдеры через ccr) НЕ поддерживают Anthropic `output_config`.
 * Конверсия в OpenAI `response_format: json_schema` тоже не помогает — модели
 * игнорируют schema и галлюцинируют, отвечая на user-message буквально
 * (вместо title возвращают калькулятор и т.п.). Этот мусорный «title»
 * показывается в Claude Code TUI как первое assistant сообщение —
 * ученик видит «🔧 Сейчас создам index.html…» без всякого tool_use.
 *
 * Решение: перехватываем title-запрос в нашем proxy и сразу отдаём
 * валидный JSON-стрим. В апстрим не идём — экономим токены, время и
 * не путаем основной flow.
 */
function isTitleGenerationRequest(parsed) {
  if (!parsed) return false;
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) return false;
  // output_config с json_schema — сильный сигнал
  if (parsed.output_config?.format?.type === 'json_schema') {
    const props = parsed.output_config.format.schema?.properties;
    if (props?.title) return true;
  }
  // Fallback: ищем фразу в system prompt
  const sys = parsed.system;
  const sysText = Array.isArray(sys)
    ? sys.map(s => s?.text || '').join(' ')
    : (typeof sys === 'string' ? sys : '');
  return /Generate a concise.*title|sentence-case title/i.test(sysText);
}

function buildFakeTitleStream() {
  const title = 'Coding session';
  const messageId = `msg_title_stub_${Date.now()}`;
  // Anthropic SSE event sequence для текстового ответа.
  // Claude Code v2.1.140 парсит content_block_delta events и собирает текст.
  // Текст — JSON с полем title, как ожидает Claude Code от schema.
  const text = JSON.stringify({ title });
  const events = [
    { event: 'message_start', data: {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant',
        model: 'krasavacode-title-stub',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }},
    { event: 'content_block_start', data: {
      type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' },
    }},
    { event: 'content_block_delta', data: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text },
    }},
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 }},
    { event: 'message_delta', data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }},
    { event: 'message_stop', data: { type: 'message_stop' }},
  ];
  return events.map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
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
// не понимает (cache_control, content-arrays, reasoning, thinking,
// output_config). Polza 400-ит или галлюцинирует на таких. Очищаем.
function cleanForOpenAICompat(parsed) {
  delete parsed.reasoning;
  delete parsed.thinking;
  delete parsed.metadata;

  // output_config — Anthropic-style structured output (JSON schema). Polza
  // ожидает OpenAI-формат `response_format: {type: 'json_schema', json_schema: ...}`.
  // Конвертируем если есть, иначе модель получает инструкции «Return JSON
  // with title field» без контекста структуры и отвечает свободным текстом —
  // у ученика это выглядит как «модель пишет преамбулу без tool_use».
  if (parsed.output_config?.format?.type === 'json_schema' && parsed.output_config.format.schema) {
    parsed.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'output',
        strict: true,
        schema: parsed.output_config.format.schema,
      },
    };
  }
  delete parsed.output_config;

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
// бесконечно. Сам стрим после headers — со stream-idle timeout (см. ниже).
const UPSTREAM_RESPONSE_HEADERS_TIMEOUT_MS = 5 * 60 * 1000;

// Stream-idle timeout: если стрим начался но не шлёт events 90 секунд —
// рвём. Защищает от случаев когда Polza/ccr начали стримить, а потом
// зависли посреди (ученик видит «Sautéed 8m» без прогресса).
const STREAM_IDLE_TIMEOUT_MS = 90 * 1000;

function pipeWithIdleTimeout(src, dst) {
  let timer = null;
  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      dlog(`[metrics] stream idle ${STREAM_IDLE_TIMEOUT_MS / 1000}s — rвём`);
      src.destroy(new Error('stream idle timeout'));
      try { dst.end(); } catch {}
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  reset();
  src.on('data', () => { reset(); });
  const stop = () => { if (timer) clearTimeout(timer); };
  src.on('end', stop);
  src.on('close', stop);
  src.on('error', stop);
  src.pipe(dst);
}

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
          pipeWithIdleTimeout(upRes, res);
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'upstream_error', message: e.message } }));
        }
        return;
      }

      // Title-generation stub: Claude Code шлёт служебный запрос «придумай
      // title» перед основной задачей. Polza отвечает на него мусором (часто
      // — самим калькулятором), Claude Code показывает это как первое
      // assistant-сообщение. Отдаём валидный фейк, не идём в апстрим.
      try {
        const parsed = JSON.parse(originalBody.toString('utf8'));
        if (isTitleGenerationRequest(parsed)) {
          dlog('[metrics] TITLE STUB: перехвачен title-generation запрос');
          if (parsed.stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            res.end(buildFakeTitleStream());
          } else {
            // Non-stream fallback
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: `msg_title_stub_${Date.now()}`,
              type: 'message', role: 'assistant',
              model: 'krasavacode-title-stub',
              content: [{ type: 'text', text: JSON.stringify({ title: 'Coding session' }) }],
              stop_reason: 'end_turn', stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 5 },
            }));
          }
          return;
        }

        // Loop-guard: до выбора провайдера парсим тело и смотрим не повторяет
        // ли модель один и тот же tool_use 3+ раз подряд. Если да — обрываем
        // цикл, не идём в апстрим. Spares the user from 1h+ burn loops.
        const loopTool = detectLoop(parsed);
        if (loopTool) {
          dlog(`[metrics] LOOP GUARD: ${loopTool} повторился ${LOOP_THRESHOLD}+ раз — обрываю`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(loopStopResponse(loopTool)));
          return;
        }
      } catch {} // если тело не парсится — идём дальше, апстрим разберётся

      // Diagnostic: дамп ground-truth payload каждого запроса с tools —
      // нужен для разбора когда модель ведёт себя странно.
      dumpLatestRequest(originalBody).catch(() => {});

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
          pipeWithIdleTimeout(upRes, res);
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
