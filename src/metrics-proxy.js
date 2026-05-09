import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isGeminiConfigured } from './setup-gemini.js';

const ROOT = join(homedir(), '.krasavacode');
const USAGE_FILE = join(ROOT, 'usage.json');

const FREE_QUOTA = {
  gemini: { perDay: 1500, label: 'Google Gemini 2.5 Flash (free tier)' },
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

const FRIENDLY_429 = (provider, used) => ({
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message:
      provider === 'gemini'
        ? `Закончились бесплатные запросы Google Gemini на сегодня (использовано ${used} из 1500).\n\n` +
          `Квота обнулится в ~10:00 PT (~21:00 МСК).\n\n` +
          `Что делать сейчас:\n` +
          `  • Подожди до завтра, и продолжи\n` +
          `  • Или подключи второй Google-аккаунт через krasavacode setup-gemini\n` +
          `  • Или временно вернись на Pollinations: удали ~/.krasavacode/gemini.env`
        : `Pollinations на минуту перегружен. Подожди ~30 секунд и нажми Enter ещё раз.\n` +
          `Или подключи Gemini для стабильности: krasavacode setup-gemini`,
  },
});

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

      // 429: try to replace body with a friendly message (non-streaming).
      // If body is streaming/SSE we still let it through — Claude Code shows it.
      if (upRes.statusCode === 429 && !/text\/event-stream/.test(upRes.headers['content-type'] || '')) {
        const used = await getTodayUsage();
        const provider = (await isGeminiConfigured()) ? 'gemini' : 'pollinations';
        const body = JSON.stringify(FRIENDLY_429(provider, used));
        const headers = { ...upRes.headers, 'content-type': 'application/json' };
        delete headers['content-length'];
        delete headers['content-encoding'];
        res.writeHead(429, headers);
        upRes.resume(); // drain the original
        res.end(body);
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
