import { spawn } from 'node:child_process';
import { mkdir, writeFile, chmod, readFile, access } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import http from 'node:http';
import net from 'node:net';

const ROOT = join(homedir(), '.krasavacode');
const ENV_FILE = join(ROOT, 'gemini.env');
const STATE_FILE = join(ROOT, 'state.json');

const CONSOLE_URL = 'https://aistudio.google.com/apikey';

function openBrowser(url) {
  const cmd = platform() === 'darwin' ? 'open'
    : platform() === 'win32' ? 'start'
    : 'xdg-open';
  const args = platform() === 'win32' ? ['', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', shell: platform() === 'win32' }).unref();
    return true;
  } catch { return false; }
}

function readState() { return readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => ({})); }
async function writeState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }

function isValidKeyFormat(key) {
  return /^AIza[A-Za-z0-9_-]{35}$/.test(key);
}

async function verifyKey(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Say only: ok' }] }],
        generationConfig: { maxOutputTokens: 20 },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { ok: false, error: 'Сеть не отвечает: ' + e.message, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    return { ok: false, error: msg, ms };
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  return { ok: true, text, ms };
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

async function persistKey(key) {
  await mkdir(ROOT, { recursive: true });
  await writeFile(ENV_FILE, `GEMINI_API_KEY=${key}\n`);
  try { await chmod(ENV_FILE, 0o600); } catch {}
  const state = await readState();
  state.geminiConfigured = true;
  state.geminiConfiguredAt = new Date().toISOString();
  await writeState(state);
}

const HTML = (port) => `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>KRASAVACODE — подключение Google Gemini</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: linear-gradient(180deg, #f7f7fb 0%, #ecedf3 100%);
    color: #1d1d1f; min-height: 100vh;
    display: flex; align-items: flex-start; justify-content: center;
  }
  .card {
    width: 100%; max-width: 640px;
    background: #fff; border-radius: 20px;
    box-shadow: 0 20px 60px rgba(0,0,0,.08), 0 4px 16px rgba(0,0,0,.04);
    padding: 36px;
  }
  h1 { font-size: 28px; margin: 0 0 6px; letter-spacing: -.5px; }
  .sub { color: #65656d; margin: 0 0 28px; }
  .step { display: flex; gap: 14px; margin: 18px 0; align-items: flex-start; }
  .num {
    flex: 0 0 32px; height: 32px; border-radius: 50%;
    background: #1d1d1f; color: #fff; font-weight: 600;
    display: flex; align-items: center; justify-content: center; font-size: 15px;
  }
  .num.done { background: #2ecc71; }
  .body { flex: 1; padding-top: 4px; }
  .body strong { display: block; font-weight: 600; margin-bottom: 4px; }
  .body p { margin: 0; color: #515158; font-size: 14.5px; line-height: 1.5; }
  .open-btn {
    display: inline-block; margin-top: 8px; padding: 10px 18px;
    background: #1a73e8; color: #fff; text-decoration: none;
    border-radius: 10px; font-weight: 500; font-size: 14px;
  }
  .open-btn:hover { background: #1666d3; }
  .field { margin-top: 26px; }
  label { display: block; font-weight: 600; margin-bottom: 8px; font-size: 15px; }
  input[type="text"] {
    width: 100%; padding: 14px 16px;
    border: 2px solid #e3e3eb; border-radius: 12px;
    font-size: 15px; font-family: 'SF Mono', Menlo, Consolas, monospace;
    transition: border-color .15s; outline: none;
  }
  input[type="text"]:focus { border-color: #1a73e8; }
  .submit {
    margin-top: 12px; width: 100%; padding: 14px;
    background: #1d1d1f; color: #fff;
    border: none; border-radius: 12px;
    font-size: 16px; font-weight: 600; cursor: pointer;
    transition: background .15s;
  }
  .submit:hover:not(:disabled) { background: #000; }
  .submit:disabled { background: #aaa; cursor: not-allowed; }
  .msg { margin-top: 14px; padding: 14px 16px; border-radius: 10px; font-size: 14px; }
  .msg.error { background: #fff1f0; color: #b00020; border: 1px solid #ffd1cc; }
  .msg.ok { background: #effaf3; color: #1a7f4d; border: 1px solid #b8e6c9; font-size: 15px; }
  .msg.ok strong { display: block; font-size: 17px; margin-bottom: 4px; }
  .footer { margin-top: 24px; font-size: 13px; color: #8b8b94; text-align: center; }
  .countdown { font-weight: 600; color: #1a7f4d; }
  @media (prefers-color-scheme: dark) {
    body { background: linear-gradient(180deg, #1a1a1f 0%, #0f0f12 100%); color: #f0f0f5; }
    .card { background: #232328; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
    .num { background: #f0f0f5; color: #1d1d1f; }
    .body p { color: #b8b8c0; }
    input[type="text"] { background: #2c2c33; border-color: #3a3a42; color: #f0f0f5; }
    input[type="text"]:focus { border-color: #4a90e2; }
    .submit { background: #f0f0f5; color: #1d1d1f; }
    .submit:hover:not(:disabled) { background: #fff; }
    .footer { color: #6a6a72; }
    .msg.error { background: #3a1f1f; color: #ff8a80; border-color: #5a2929; }
    .msg.ok { background: #1f3a2a; color: #8eddb0; border-color: #295a3c; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>Подключение Google Gemini</h1>
    <p class="sub">Бесплатно. 1500 запросов в день. Без банковской карты.</p>

    <div class="step">
      <div class="num">1</div>
      <div class="body">
        <strong>Открой Google AI Studio и войди через свой Gmail</strong>
        <p>Нажми кнопку ниже — откроется новая вкладка. Войди под тем же гуглом, что и обычно.</p>
        <a class="open-btn" href="${CONSOLE_URL}" target="_blank" rel="noopener">Открыть Google AI Studio →</a>
      </div>
    </div>

    <div class="step">
      <div class="num">2</div>
      <div class="body">
        <strong>Нажми «Create API key»</strong>
        <p>Большая синяя кнопка наверху страницы. Если попросят выбрать проект — оставь предложенный.</p>
      </div>
    </div>

    <div class="step">
      <div class="num">3</div>
      <div class="body">
        <strong>Скопируй полученный ключ</strong>
        <p>Длинная строка, которая начинается с «AIza». Нажми «Copy» рядом с ней.</p>
      </div>
    </div>

    <div class="field">
      <label for="key">Вставь ключ сюда (Cmd/Ctrl+V):</label>
      <input id="key" type="text" autocomplete="off" spellcheck="false" placeholder="AIzaSy…">
      <button id="submit" class="submit">Подключить и проверить</button>
      <div id="msg"></div>
    </div>

    <div class="footer">Это окно открыл сам KRASAVACODE на твоём компьютере. Никуда ничего не отправляется, кроме одного тестового запроса в Google.</div>
  </div>

<script>
const input = document.getElementById('key');
const btn = document.getElementById('submit');
const msg = document.getElementById('msg');
input.focus();

btn.addEventListener('click', submit);
input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

async function submit() {
  const key = input.value.trim();
  msg.className = '';
  msg.textContent = '';
  if (!key) { showError('Поле пустое — вставь ключ из шага 3.'); return; }
  if (!/^AIza[A-Za-z0-9_-]{35}$/.test(key)) {
    showError('Это не похоже на ключ Gemini. Должно быть AIza + 35 символов (всего 39). Скопируй ещё раз.');
    return;
  }
  btn.disabled = true; btn.textContent = 'Проверяю…';
  try {
    const r = await fetch('/api/verify', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ key }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      showError(data.error || 'Не получилось проверить. Попробуй ещё раз.');
      btn.disabled = false; btn.textContent = 'Подключить и проверить';
      return;
    }
    showSuccess(data);
  } catch (e) {
    showError('Сеть не отвечает: ' + e.message);
    btn.disabled = false; btn.textContent = 'Подключить и проверить';
  }
}

function showError(text) {
  msg.className = 'msg error';
  msg.textContent = text;
}

function showSuccess(data) {
  msg.className = 'msg ok';
  msg.innerHTML = '<strong>✅ Готово!</strong>Gemini ответил «' + escapeHtml(data.text || 'ok') + '» за ' + (data.ms/1000).toFixed(1) + ' сек. Теперь твой вайбкодинг — на Gemini 2.5 Flash. <span class="countdown">Окно закроется через <span id="cd">5</span>…</span>';
  btn.style.display = 'none';
  let n = 5;
  const cd = document.getElementById('cd');
  const timer = setInterval(() => {
    n--;
    if (cd) cd.textContent = n;
    if (n <= 0) {
      clearInterval(timer);
      fetch('/api/done', { method: 'POST' }).catch(() => {});
      window.close();
    }
  }, 1000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

window.addEventListener('beforeunload', () => {
  // best-effort cancel if user closes the tab without finishing
  navigator.sendBeacon && navigator.sendBeacon('/api/cancel');
});
</script>
</body>
</html>
`;

function readJsonBody(req, max = 8 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', d => {
      total += d.length;
      if (total > max) { req.destroy(); reject(new Error('body too large')); }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

async function browserOnboarding() {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;

  let resolveResult;
  const done = new Promise(r => { resolveResult = r; });

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML(port));
    }
    if (req.method === 'POST' && req.url === '/api/verify') {
      try {
        const body = await readJsonBody(req);
        const key = String(body.key || '').trim();
        if (!isValidKeyFormat(key)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Не похоже на ключ Gemini.' }));
        }
        const r = await verifyKey(key);
        if (!r.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: r.error }));
        }
        await persistKey(key);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text: r.text, ms: r.ms }));
        // Schedule shutdown after 6s — gives the page time to show the success state
        setTimeout(() => resolveResult({ launchAfter: true, configured: true }), 6000);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.method === 'POST' && (req.url === '/api/done' || req.url === '/api/cancel')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      // If cancel arrived before a successful verify, treat as cancellation.
      // If after — resolveResult was already called by /api/verify timeout.
      setTimeout(() => resolveResult({ launchAfter: false, configured: false }), 100);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, '127.0.0.1');

  const opened = openBrowser(url);
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║  KRASAVACODE — подключаем Google Gemini          ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  if (opened) {
    console.log(`  🌐 Открыл настройку в браузере: ${url}`);
  } else {
    console.log(`  Не получилось открыть браузер автоматически.`);
    console.log(`  Скопируй и открой эту ссылку вручную: ${url}`);
  }
  console.log('  Это окно (терминал) можно не трогать — оно закроется само.');
  console.log('');
  console.log('  Нажми Ctrl+C чтобы отменить и вернуться позже.');
  console.log('');

  let result;
  try {
    result = await Promise.race([
      done,
      new Promise((_, rej) => process.once('SIGINT', () => rej(new Error('cancelled'))) ),
    ]);
  } catch {
    result = { launchAfter: false, configured: false };
  }
  server.close();
  return result;
}

/* ────── CLI fallback (kept for non-GUI environments) ────── */

function prompt(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
}

async function cliOnboarding() {
  console.log('\n  Браузерный режим недоступен — запускаю текстовый.\n');
  console.log(`  Открой в браузере: ${CONSOLE_URL}`);
  console.log('  Войди через Google → «Create API key» → скопируй ключ.\n');

  let key;
  for (let i = 0; i < 3; i++) {
    key = (await prompt('  Вставь ключ Gemini сюда: ')).trim();
    if (isValidKeyFormat(key)) break;
    console.log('  ⚠️  Не похоже на ключ Gemini. Попробуй ещё раз.\n');
  }
  if (!isValidKeyFormat(key)) {
    console.log('\n  ❌ Не удалось получить ключ. Запусти команду ещё раз позже.');
    return { launchAfter: false, configured: false };
  }
  console.log('\n  ⏳ Проверяю…');
  const r = await verifyKey(key);
  if (!r.ok) {
    console.log(`  ❌ ${r.error}\n  Запусти команду ещё раз.`);
    return { launchAfter: false, configured: false };
  }
  await persistKey(key);
  console.log(`  ✅ Готово! Gemini ответил за ${(r.ms/1000).toFixed(1)} сек.\n`);
  const launch = (await prompt('  Запустить вайбкодинг сейчас? [Enter — да, n — позже]: ')).trim().toLowerCase();
  return { launchAfter: launch === '' || launch === 'y' || launch === 'yes' || launch === 'д' || launch === 'да', configured: true };
}

export async function runSetupGemini() {
  const useBrowser = process.env.KRASAVACODE_NO_BROWSER !== '1' && process.stdout.isTTY !== false;
  if (useBrowser) {
    try { return await browserOnboarding(); }
    catch (e) {
      console.error('  Браузерный мастер упал:', e.message);
      return cliOnboarding();
    }
  }
  return cliOnboarding();
}

export async function loadGeminiKey() {
  try {
    const content = await readFile(ENV_FILE, 'utf8');
    const m = content.match(/^GEMINI_API_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

export async function isGeminiConfigured() {
  return access(ENV_FILE).then(() => true).catch(() => false);
}
