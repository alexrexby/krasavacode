import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { CCR_PORT } from './preset.js';
import { loadGeminiKey } from './setup-gemini.js';
import { startMetricsProxy } from './metrics-proxy.js';

const HOST = '127.0.0.1';
const PORT = CCR_PORT;

async function probe() {
  const url = `http://${HOST}:${PORT}/`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    // CCR returns any 2xx/3xx/4xx — any HTTP response means it's listening
    return res.status !== undefined;
  } catch { return false; }
}

async function isAlreadyRunning() {
  return await probe();
}

async function waitForHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(500);
  }
  return false;
}

export async function startHub(paths) {
  const baseUrl = `http://${HOST}:${PORT}`;

  // CCR is a singleton: one server per machine on port 3456. If something
  // is already there, hope it's a healthy CCR — don't start a second one.
  if (await isAlreadyRunning()) {
    return { process: null, port: PORT, baseUrl, ownedByUs: false };
  }

  process.stdout.write(`🚀 Поднимаю локальный gateway на порту ${PORT}… `);

  // Inject GEMINI_API_KEY into ccr env if user has configured Gemini.
  // ccr's config.json references it as $GEMINI_API_KEY (env-interpolation).
  const ccrEnv = { ...paths.env };
  const geminiKey = await loadGeminiKey();
  if (geminiKey) ccrEnv.GEMINI_API_KEY = geminiKey;

  const child = spawn(paths.ccrBin, ['start'], {
    stdio: process.env.KRASAVACODE_DEBUG ? 'inherit' : 'pipe',
    detached: false,
    env: ccrEnv,
  });

  let stderrTail = '';
  if (child.stderr) {
    child.stderr.on('data', d => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
  }
  if (child.stdout) {
    child.stdout.on('data', d => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
  }

  let exitedEarly = false;
  child.once('exit', code => {
    exitedEarly = true;
    if (code !== 0 && code !== null) {
      console.error(`\n❌ ccr упал с кодом ${code}.`);
    }
  });

  const ok = await waitForHealthy(30000);

  if (!ok) {
    if (!child.killed) child.kill('SIGTERM');
    if (stderrTail) console.error('\n--- ccr output ---\n' + stderrTail);
    throw new Error(`claude-code-router не поднялся за 30s на ${baseUrl}`);
  }

  console.log('OK');

  if (exitedEarly) {
    // Maybe CCR daemonised; check if endpoint is alive
    if (!(await probe())) {
      throw new Error('ccr процесс завершился, но порт не отвечает');
    }
  }

  // Front the ccr endpoint with our metrics-counting proxy. Claude Code
  // talks to the proxy; the proxy forwards to ccr; we count requests and
  // translate 429 errors into friendly Russian messages.
  const metrics = await startMetricsProxy(baseUrl);

  return {
    process: child,
    port: PORT,
    ccrBaseUrl: baseUrl,
    baseUrl: metrics.baseUrl, // <-- Claude Code будет ходить сюда
    metrics,
    ownedByUs: true,
  };
}

export async function stopHub(hub) {
  if (!hub) return;
  if (hub.metrics) await hub.metrics.stop().catch(() => {});
  if (!hub.ownedByUs) return; // we didn't start it; leave it running for the user
  if (!hub.process || hub.process.killed) return;

  hub.process.kill('SIGTERM');
  await Promise.race([
    new Promise(r => hub.process.once('exit', r)),
    sleep(5000),
  ]);
  if (!hub.process.killed) hub.process.kill('SIGKILL');
}
