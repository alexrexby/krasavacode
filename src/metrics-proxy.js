import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { configuredProviders, PROVIDERS, PROVIDER_PRIORITY } from './providers.js';
import { setCooldown, getCooldowns, cooldownUntil } from './cooldowns.js';

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
    if (!onCooldown(id)) return { id, model: PROVIDERS[id].defaultModel };
  }
  // All custom providers exhausted — fall back to Pollinations
  if (!onCooldown('pollinations')) return { id: 'pollinations', model: 'openai' };
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

function rewriteBodyWithProvider(originalBody, providerId, modelName) {
  // claude-code-router treats body.model in form "provider,modelName" as a
  // direct route, bypassing Router config. We use that to fully control
  // provider selection from the proxy layer.
  try {
    const parsed = JSON.parse(originalBody);
    parsed.model = `${providerId},${modelName}`;
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
    if (debug) console.error(`[metrics] ${req.method} ${req.url}`);

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

      // /v1/messages: provider selection with retry-on-429
      for (let attempt = 1; attempt <= 4; attempt++) {
        const choice = await chooseProvider();
        if (!choice) {
          if (debug) console.error('[metrics] all providers on cooldown');
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(FRIENDLY_429()));
          return;
        }

        const rewrittenBody = rewriteBodyWithProvider(originalBody, choice.id, choice.model);
        if (debug) console.error(`[metrics] attempt ${attempt}: routing to ${choice.id},${choice.model}`);

        let upRes;
        try {
          upRes = await forward(upstream, req.method, req.url, req.headers, rewrittenBody);
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'upstream_error', message: e.message } }));
          return;
        }

        if (debug) console.error(`[metrics] attempt ${attempt} → ${upRes.statusCode}`);

        if (upRes.statusCode !== 429) {
          if (upRes.statusCode >= 200 && upRes.statusCode < 300) {
            bump(choice.id).catch(() => {});
          }
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
          return;
        }

        // 429 — buffer body, set cooldown for THIS provider, retry with next
        const errChunks = [];
        upRes.on('data', d => errChunks.push(d));
        await new Promise(r => upRes.on('end', r));
        const upBody = Buffer.concat(errChunks).toString('utf8');
        if (debug) console.error(`[metrics] 429 from ${choice.id}: ${upBody.slice(0, 200)}`);

        const reason = parseQuotaReason(upBody);
        // Pollinations has no daily quota — only short burst-throttling.
        // Treat its 429 as a 60s cooldown so we don't block it until tomorrow.
        const effectiveReason = choice.id === 'pollinations' ? 'per-minute' : reason;
        await setCooldown(choice.id, cooldownUntil(effectiveReason));
        // loop continues — next iteration picks a different provider
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
