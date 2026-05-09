import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { CCR_PORT } from './preset.js';
import { configuredProviders, loadProviderKey, getProviderEnvVarName } from './providers.js';
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

  // If a previous ccr is still running on 3456, it holds a stale config
  // (e.g. old PROVIDER_PRIORITY order) and won't pick up our updated
  // ~/.claude-code-router/config.json. Kill it so we can spawn fresh.
  if (await isAlreadyRunning()) {
    process.stdout.write('🔄 Перезапускаю старый gateway… ');
    try {
      const { spawn: _spawn } = await import('node:child_process');
      // pkill matches the ccr cli script name in argv
      _spawn('pkill', ['-9', '-f', 'claude-code-router/dist/cli.js'], { stdio: 'ignore' });
      _spawn('pkill', ['-9', '-f', 'ccr start'], { stdio: 'ignore' });
    } catch {}
    // Wait for port to actually free up
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      if (!(await isAlreadyRunning())) break;
    }
    console.log('OK');
  }

  process.stdout.write(`🚀 Поднимаю локальный gateway на порту ${PORT}… `);

  // Inject every configured provider's API key as env var so that ccr's
  // config.json can reference them via interpolation ($CEREBRAS_API_KEY etc).
  const ccrEnv = { ...paths.env };
  for (const id of await configuredProviders()) {
    const key = await loadProviderKey(id);
    if (key) ccrEnv[getProviderEnvVarName(id)] = key;
  }

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
