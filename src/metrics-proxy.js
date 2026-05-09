import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isGeminiConfigured } from './setup-gemini.js';

const ROOT = join(homedir(), '.krasavacode');
const USAGE_FILE = join(ROOT, 'usage.json');

// Google free tier (2026): https://ai.google.dev/gemini-api/docs/rate-limits
//   Gemini 2.5 Flash free: 10 RPM, 250k TPM, 250 RPD (request-per-day).
const FREE_QUOTA = {
  gemini: { perDay: 250, rpm: 10, label: 'Google Gemini 2.5 Flash (free tier)' },
  pollinations: { perDay: null, label: 'Pollinations (free)' },
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function readUsage() {
  try { return JSON.parse(await readFile(USAGE_FILE, 'utf8')); }
  catch { return {}; }
}

async function writeUsage(u) {
  await mkdir(ROOT, { recursive: true });
  await writeFile(USAGE_FILE, JSON.stringify(u, null, 2));
}

async function bump() {
  const u = await readUsage();
  const day = todayKey();
  u[day] = (u[day] || 0) + 1;
  u.lastRequestAt = new Date().toISOString();
  // keep only last 30 days
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
  return u[todayKey()] || 0;
}

export async function getQuotaInfo() {
  const provider = (await isGeminiConfigured()) ? 'gemini' : 'pollinations';
  const used = await getTodayUsage();
  const { perDay, label } = FREE_QUOTA[provider];
  return { provider, used, perDay, label, remaining: perDay ? Math.max(0, perDay - used) : null };
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

function formatGeminiQuotaReason(upstreamBody) {
  // Google's 429 body looks like:
  //   { "error": { "code": 429, "message": "...",
  //     "details": [{"@type": ".../QuotaFailure",
  //                  "violations": [{"quotaMetric":"...generate_content_free_tier_requests",
  //                                  "quotaId":"...PerDay..."}]}] }}
  try {
    const parsed = JSON.parse(upstreamBody);
    const violations = parsed.error?.details?.find(d => d['@type']?.includes('QuotaFailure'))?.violations || [];
    if (violations.length === 0) return null;

    const v = violations[0];
    const id = v.quotaId || v.quotaMetric || '';
    const isPerMinute = /PerMinute/i.test(id);
    const isPerDay = /PerDay/i.test(id);
    const isTokens = /Token|input_token|output_token/i.test(id);

    if (isPerMinute) return 'Слишком много запросов в минуту (лимит — 10 запросов/мин). Подожди 30–60 секунд и продолжай.';
    if (isPerDay && isTokens) return 'Закончился дневной лимит входных токенов Gemini (≈250k/день).';
    if (isPerDay) return 'Закончилась дневная квота запросов к Gemini (≈250 запросов/день для 2.5-flash).';
    return `Google Gemini ограничил запрос: ${id}`;
  } catch { return null; }
}

const FRIENDLY_429 = (provider, used, upstreamBody) => {
  if (provider === 'gemini') {
    const reason = formatGeminiQuotaReason(upstreamBody) ||
      `Google ограничил запрос (использовано ${used} запросов сегодня через нас).`;
    return {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message:
          `${reason}\n\n` +
          `Квоты обнуляются в полночь по тихоокеанскому времени (≈11:00 МСК).\n` +
          `На один твой вопрос Claude Code делает 3–10 запросов (читает файлы, использует инструменты),\n` +
          `поэтому реальный счёт у Google быстрее, чем в нашем счётчике.\n\n` +
          `Что делать:\n` +
          `  • Подожди минуту (если упёрлись в RPM) или до завтра (если в дневной)\n` +
          `  • Подключи второй Google-аккаунт: krasavacode setup-gemini\n` +
          `  • Временно вернись на Pollinations (без квот): удали ~/.krasavacode/gemini.env`,
      },
    };
  }
  return {
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message:
        `Pollinations на минуту перегружен. Подожди ~30 секунд и попробуй ещё раз.\n` +
        `Или подключи Gemini: krasavacode setup-gemini`,
    },
  };
};

/**
 * Proxy: Claude Code → metrics-proxy (this) → ccr → upstream.
 *
 * - Counts every successful POST /v1/messages as one request, written to ~/.krasavacode/usage.json
 * - Replaces 429 responses with a friendly Russian message
 * - Streams everything else through unmodified (so SSE works)
 */
export async function startMetricsProxy(upstreamBaseUrl) {
  const upstream = new URL(upstreamBaseUrl);
  const port = await getFreePort();

  const debug = process.env.KRASAVACODE_DEBUG === '1';
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    const isMessages = req.method === 'POST' && path === '/v1/messages';
    if (debug) console.error(`[metrics] ${req.method} ${req.url}`);

    const proxyReq = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    }, async (upRes) => {
      if (debug) console.error(`[metrics] ← ${upRes.statusCode} ${req.url}`);
      // Treat any 2xx on /v1/messages as one billable request — count immediately.
      if (isMessages && upRes.statusCode >= 200 && upRes.statusCode < 300) {
        bump().catch(e => debug && console.error('[metrics] bump fail', e));
      }

      // 429: replace body with a friendly Russian message that includes
      // a parsed reason from Google's QuotaFailure details.
      if (upRes.statusCode === 429 && !/text\/event-stream/.test(upRes.headers['content-type'] || '')) {
        const used = await getTodayUsage();
        const provider = (await isGeminiConfigured()) ? 'gemini' : 'pollinations';
        const chunks = [];
        upRes.on('data', d => chunks.push(d));
        upRes.on('end', () => {
          const upstreamBody = Buffer.concat(chunks).toString('utf8');
          if (debug) console.error('[metrics] 429 upstream body:', upstreamBody.slice(0, 500));
          const friendly = JSON.stringify(FRIENDLY_429(provider, used, upstreamBody));
          const headers = { ...upRes.headers, 'content-type': 'application/json' };
          delete headers['content-length'];
          delete headers['content-encoding'];
          res.writeHead(429, headers);
          res.end(friendly);
        });
        return;
      }

      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'upstream_error', message: err.message } }));
    });

    req.pipe(proxyReq);
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));

  const baseUrl = `http://127.0.0.1:${port}`;
  return { server, port, baseUrl, stop: () => new Promise(r => server.close(r)) };
}
