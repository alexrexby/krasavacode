import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { configuredProviders, PROVIDERS, PROVIDER_PRIORITY } from './providers.js';
import { setCooldown, getCooldowns, cooldownUntil } from './cooldowns.js';
import { compressPayload } from './compression.js';

const ROOT = join(homedir(), '.krasavacode');
const USAGE_FILE = join(ROOT, 'usage.json');

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

/** Pick the first available provider not on cooldown, in priority order. */
async function chooseProvider() {
  const cd = await getCooldowns();
  const configured = await configuredProviders();
  const now = Date.now();
  const onCooldown = (id) => cd[id] && new Date(cd[id]).getTime() > now;

  for (const id of configured) {
    if (onCooldown(id)) continue;
    return { id, model: PROVIDERS[id].defaultModel };
  }
  return null;
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

function rewriteBodyWithProvider(originalBody, providerId, modelName, debug = false) {
  try {
    const parsed = JSON.parse(originalBody);
    parsed.model = `${providerId},${modelName}`;
    if (OPENAI_COMPAT_PROVIDERS.has(providerId)) cleanForOpenAICompat(parsed);
    const stats = compressPayload(parsed);
    if (debug) {
      const pct = stats.before > 0 ? ((stats.saved / stats.before) * 100).toFixed(1) : '0.0';
      console.error(`[compress] ${providerId}: -${stats.saved}b (${pct}%) — ${stats.before}→${stats.after}`);
    }
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return originalBody;
  }
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
    }, (res) => resolve(res));
    req.on('error', reject);
    if (bodyBuffer && bodyBuffer.length) req.write(bodyBuffer);
    req.end();
  });
}

export async function startMetricsProxy(upstreamBaseUrl) {
  const upstream = new URL(upstreamBaseUrl);
  const port = await getFreePort();
  const debug = process.env.KRASAVACODE_DEBUG === '1';

  const server = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0];
    const isMessages = req.method === 'POST' && path === '/v1/messages';
    const isModelList = req.method === 'GET' && path === '/v1/models';
    if (debug) console.error(`[metrics] ${req.method} ${req.url}`);

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

      // /v1/messages: provider selection with retry-on-failure.
      const numConfigured = (await configuredProviders()).length;
      const maxAttempts = Math.max(numConfigured + 1, 3);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let choice = await chooseProvider();
        // All on cooldown? Wait up to 30s for the soonest one to free up.
        if (!choice) {
          if (debug) console.error('[metrics] all on cooldown — wait up to 30s');
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            choice = await chooseProvider();
            if (choice) break;
          }
        }
        if (!choice) {
          if (debug) console.error('[metrics] all providers on cooldown after 30s wait');
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(FRIENDLY_429()));
          return;
        }

        const rewrittenBody = rewriteBodyWithProvider(originalBody, choice.id, choice.model, debug);
        if (debug) console.error(`[metrics] attempt ${attempt}: routing to ${choice.id},${choice.model}`);

        let upRes;
        try {
          upRes = await forward(upstream, req.method, req.url, req.headers, rewrittenBody);
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'upstream_error', message: e.message } }));
          return;
        }

        if (debug) console.error(`[metrics] attempt ${attempt}/${maxAttempts} → ${upRes.statusCode} (${choice.id})`);

        // 4xx provider failures → mark cooldown and retry next provider.
        // We retry on:
        //   400 — payload incompatible (cache_control etc)
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
        if (debug) console.error(`[metrics] ${upRes.statusCode} from ${choice.id}: ${upBody.slice(0, 200)}`);

        let effectiveReason;
        if (code === 401 || code === 403) {
          // Invalid/expired/blocked key — provider is dead until user re-runs setup.
          effectiveReason = 'per-day';
        } else if (code === 400) {
          // 400 = payload incompatibility. cleanForOpenAICompat снимает
          // большинство таких случаев, hour-cooldown достаточно.
          effectiveReason = 'per-hour';
        } else if (code === 404) {
          // 404 = "model not found on this provider". Model rename (часто на OpenRouter).
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
