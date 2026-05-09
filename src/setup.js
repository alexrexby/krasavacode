import { spawn } from 'node:child_process';
import { mkdir, writeFile, chmod, readFile, access } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import http from 'node:http';
import net from 'node:net';
import {
  PROVIDERS,
  PROVIDER_PRIORITY,
  KEYS_DIR,
  loadProviderKey,
  isProviderConfigured,
  configuredProviders,
  getProviderEnvVarName,
  providerEnvFile,
} from './providers.js';

const ROOT = join(homedir(), '.krasavacode');
const STATE_FILE = join(ROOT, 'state.json');

function openBrowser(url) {
  if (platform() === 'darwin') {
    try { spawn('open', [url], { detached: true, stdio: 'ignore' }).unref(); return true; }
    catch { return false; }
  }
  if (platform() === 'win32') {
    try { spawn('start', ['', url], { detached: true, stdio: 'ignore', shell: true }).unref(); return true; }
    catch { return false; }
  }
  // Linux / WSL — try multiple openers in priority order.
  // wslview: WSL native opener (uses Windows browser)
  // xdg-open: standard Linux desktop
  // sensible-browser: Debian/Ubuntu fallback
  // gio: GNOME-native
  for (const opener of ['wslview', 'xdg-open', 'sensible-browser', 'gio']) {
    try {
      const args = opener === 'gio' ? ['open', url] : [url];
      const p = spawn(opener, args, { detached: true, stdio: 'ignore' });
      p.on('error', () => {}); // swallow ENOENT
      p.unref();
      return true;
    } catch {}
  }
  return false;
}

function isHeadlessLinux() {
  if (platform() !== 'linux') return false;
  // WSL2 always has WSL_DISTRO_NAME and routes to Windows browser
  if (process.env.WSL_DISTRO_NAME) return false;
  // Real Linux without graphical session
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

async function readState() { try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return {}; } }
async function writeState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }

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

async function persistKey(providerId, key) {
  await mkdir(KEYS_DIR, { recursive: true });
  const file = providerEnvFile(providerId);
  const varName = getProviderEnvVarName(providerId);
  await writeFile(file, `${varName}=${key}\n`);
  try { await chmod(file, 0o600); } catch {}
  const state = await readState();
  state.lastSetupAt = new Date().toISOString();
  state.lastConfiguredProvider = providerId;
  await writeState(state);
}

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

// Pre-written prompts for first projects. Each is engineered so Claude Code
// outputs something visible quickly and explains how to open it.
const FIRST_PROJECTS = [
  {
    id: 'tetris',
    emoji: '🎮',
    title: 'Игра Тетрис',
    desc: 'Классика в браузере, всё в одном HTML-файле',
    duration: '5 минут',
    prompt:
      'Сделай в подпапке tetris/ файл index.html — рабочую игру Тетрис. ' +
      'Один файл, без зависимостей. Используй Canvas API. ' +
      'Управление стрелками: ←→ двигать, ↑ повернуть, ↓ ускорить, пробел — мгновенно вниз. ' +
      'После того как файл готов, скажи мне одной строкой: "Открой файл tetris/index.html в браузере (двойной клик)".',
  },
  {
    id: 'card',
    emoji: '🌐',
    title: 'Сайт-визитка',
    desc: 'Страничка обо мне с фото и контактами',
    duration: '5 минут',
    prompt:
      'Сделай в подпапке card/ простую персональную сайт-визитку (один index.html со встроенным CSS). ' +
      'Сначала спроси меня: 1) имя, 2) одно увлечение, 3) одну ссылку (Telegram/Instagram/etc). ' +
      'Не задавай больше вопросов — после моих ответов сразу делай страницу. ' +
      'Современный дизайн, тёмная тема, центрирование. ' +
      'Готовое — скажи: "Открой файл card/index.html в браузере".',
  },
  {
    id: 'pomodoro',
    emoji: '⏰',
    title: 'Pomodoro-таймер',
    desc: 'Помощник для учёбы — 25 минут работы, 5 отдыха',
    duration: '5 минут',
    prompt:
      'Сделай в подпапке pomodoro/ файл index.html — Pomodoro-таймер. ' +
      'Один файл с встроенным CSS и JavaScript. ' +
      'Большой таймер по центру, кнопки «Старт/Пауза/Сброс», переключение режима 25-минутной работы и 5-минутного отдыха. ' +
      'Звуковой сигнал при окончании. ' +
      'Готовое — скажи: "Открой файл pomodoro/index.html в браузере".',
  },
  {
    id: 'custom',
    emoji: '✨',
    title: 'Свой проект',
    desc: 'У меня уже есть идея, начну с чистого листа',
    duration: 'когда захочешь',
    prompt: null, // null означает «без авто-промпта»
  },
];

function html() {
  // ── HTML страницы ───────────────────────────────────────────────
  // Три таба: Cerebras / Groq / Gemini. Inline CSS, dark/light theme.
  const cards = PROVIDER_PRIORITY.map(id => {
    const p = PROVIDERS[id];
    const steps = p.keyHowto.map((s, i) => `<li>${s}</li>`).join('');
    return `
    <section class="tab-content" data-tab="${id}" hidden>
      <div class="hero">
        <h2>${p.name}</h2>
        <p class="tagline">${p.tagline}</p>
        <ul class="quota">
          <li><b>Квота:</b> ${p.quota}</li>
          <li><b>Лучшая модель:</b> ${p.bestModel}</li>
          <li><b>Контекст:</b> ${p.contextLimit.toLocaleString('ru')} токенов</li>
        </ul>
      </div>
      <ol class="steps">${steps}</ol>
      <div class="open-row">
        <a class="open-btn" href="${p.consoleUrl}" target="_blank" rel="noopener">Открыть страницу регистрации →</a>
      </div>
      <div class="field">
        <label>Вставь ключ ${p.name}:</label>
        <input data-provider="${id}" type="text" autocomplete="off" spellcheck="false" placeholder="${p.keyExample}">
        <button data-action="verify" data-provider="${id}" class="submit">Подключить и проверить</button>
        <div class="msg" data-provider-msg="${id}"></div>
      </div>
    </section>`;
  }).join('\n');

  const tabs = PROVIDER_PRIORITY.map((id, i) => {
    const p = PROVIDERS[id];
    return `<button class="tab" data-tab-button="${id}"${i === 0 ? ' aria-current="true"' : ''}>${p.name} <span class="tab-status" data-provider-status="${id}"></span></button>`;
  }).join('');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>KRASAVACODE — подключение AI-провайдеров</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         background: linear-gradient(180deg,#f7f7fb 0%,#ecedf3 100%); color:#1d1d1f; min-height:100vh;
         display:flex; align-items:flex-start; justify-content:center; }
  .card { width:100%; max-width:680px; background:#fff; border-radius:20px;
          box-shadow:0 20px 60px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.04); padding:36px; }
  h1 { font-size:28px; margin:0 0 6px; letter-spacing:-.5px; }
  .sub { color:#65656d; margin:0 0 24px; }
  .tabs { display:flex; gap:6px; border-bottom:2px solid #e3e3eb; margin-bottom:24px; flex-wrap:wrap; }
  .tab { background:none; border:none; padding:12px 16px; cursor:pointer; font-size:15px; font-weight:500;
         color:#65656d; border-bottom:2px solid transparent; margin-bottom:-2px; transition:all .15s; }
  .tab[aria-current="true"] { color:#1d1d1f; border-bottom-color:#1d1d1f; }
  .tab-status { font-size:13px; }
  .tab-status.ok::before { content:" ✅"; }
  .tab-status.fail::before { content:" ⚠️"; }
  .hero h2 { font-size:22px; margin:0 0 4px; }
  .tagline { color:#65656d; margin:0 0 16px; font-size:15px; }
  .quota { list-style:none; padding:0; margin:0 0 20px; background:#f5f5f9; border-radius:12px; padding:14px 18px; }
  .quota li { padding:3px 0; font-size:14px; color:#3a3a44; }
  .quota li b { color:#1d1d1f; }
  .steps { padding-left:20px; margin:0 0 16px; color:#3a3a44; font-size:14.5px; line-height:1.7; }
  .open-row { margin-bottom:24px; }
  .open-btn { display:inline-block; padding:10px 18px; background:#1a73e8; color:#fff; text-decoration:none;
              border-radius:10px; font-weight:500; font-size:14px; }
  .open-btn:hover { background:#1666d3; }
  .field label { display:block; font-weight:600; margin-bottom:8px; font-size:14px; color:#3a3a44; }
  input[type="text"] { width:100%; padding:14px 16px; border:2px solid #e3e3eb; border-radius:12px;
                       font-size:15px; font-family:'SF Mono',Menlo,Consolas,monospace; outline:none; }
  input[type="text"]:focus { border-color:#1a73e8; }
  .submit { margin-top:12px; width:100%; padding:14px; background:#1d1d1f; color:#fff; border:none;
            border-radius:12px; font-size:16px; font-weight:600; cursor:pointer; }
  .submit:hover:not(:disabled) { background:#000; }
  .submit:disabled { background:#aaa; cursor:not-allowed; }
  .msg { margin-top:14px; padding:14px 16px; border-radius:10px; font-size:14px; }
  .msg.error { background:#fff1f0; color:#b00020; border:1px solid #ffd1cc; }
  .msg.ok { background:#effaf3; color:#1a7f4d; border:1px solid #b8e6c9; }
  .msg.ok strong { display:block; font-size:16px; margin-bottom:4px; }
  .footer { margin-top:24px; font-size:13px; color:#8b8b94; text-align:center; }
  .footer .done-btn { display:inline-block; margin-top:8px; padding:10px 22px; background:#1a7f4d; color:#fff;
                      text-decoration:none; border-radius:10px; font-weight:600; }
  @media (prefers-color-scheme:dark) {
    body { background:linear-gradient(180deg,#1a1a1f 0%,#0f0f12 100%); color:#f0f0f5; }
    .card { background:#232328; box-shadow:0 20px 60px rgba(0,0,0,.4); }
    .tabs { border-bottom-color:#3a3a42; }
    .tab { color:#8b8b94; }
    .tab[aria-current="true"] { color:#f0f0f5; border-bottom-color:#f0f0f5; }
    .tagline, .footer { color:#8b8b94; }
    .quota { background:#2c2c33; }
    .quota li { color:#b8b8c0; }
    .quota li b { color:#f0f0f5; }
    .steps { color:#b8b8c0; }
    input[type="text"] { background:#2c2c33; border-color:#3a3a42; color:#f0f0f5; }
    .submit { background:#f0f0f5; color:#1d1d1f; }
    .submit:hover:not(:disabled) { background:#fff; }
    .msg.error { background:#3a1f1f; color:#ff8a80; border-color:#5a2929; }
    .msg.ok { background:#1f3a2a; color:#8eddb0; border-color:#295a3c; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>Подключаем AI-провайдеры</h1>
    <p class="sub">Любые из этих трёх дают бесплатный вайбкодинг. Чем больше подключишь — тем устойчивее (если один упрётся в лимит, переключится на следующий).</p>

    <div class="tabs" role="tablist">${tabs}</div>
    ${cards}

    <div class="footer">
      <p>Ключи хранятся только у тебя в <code>~/.krasavacode/keys/</code> с chmod 600. Ничего не отправляется кроме одного тестового запроса в каждый сервис.</p>
      <p style="margin-top:18px;"><a href="#" class="done-btn" data-action="done">Готово, запустить вайбкодинг</a></p>
    </div>
  </div>

<script>
window.__FIRST_PROJECTS = ${JSON.stringify(FIRST_PROJECTS.map(({ id, emoji, title, desc, duration }) => ({ id, emoji, title, desc, duration })))};
const tabs = document.querySelectorAll('[data-tab-button]');
const contents = document.querySelectorAll('[data-tab]');

function showTab(id) {
  tabs.forEach(t => {
    if (t.dataset.tabButton === id) t.setAttribute('aria-current', 'true');
    else t.removeAttribute('aria-current');
  });
  contents.forEach(c => c.hidden = c.dataset.tab !== id);
}
tabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tabButton)));
showTab('${PROVIDER_PRIORITY[0]}');

async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    const data = await r.json();
    document.querySelectorAll('[data-provider-status]').forEach(s => {
      const id = s.dataset.providerStatus;
      s.classList.remove('ok','fail');
      if (data.configured.includes(id)) s.classList.add('ok');
    });
  } catch {}
}
refreshStatus();

document.querySelectorAll('[data-action="verify"]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const id = btn.dataset.provider;
    const input = document.querySelector('input[data-provider="' + id + '"]');
    const msg = document.querySelector('[data-provider-msg="' + id + '"]');
    const key = (input.value || '').trim();
    msg.className = 'msg';
    msg.textContent = '';
    if (!key) { msg.className = 'msg error'; msg.textContent = 'Поле пустое — вставь ключ.'; return; }
    btn.disabled = true; btn.textContent = 'Проверяю…';
    try {
      const r = await fetch('/api/verify', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({ provider: id, key }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        msg.className = 'msg error';
        msg.textContent = data.error || 'Не получилось.';
        btn.disabled = false; btn.textContent = 'Подключить и проверить';
        return;
      }
      msg.className = 'msg ok';
      msg.innerHTML = '<strong>✅ Подключено!</strong>Ответил «' + escapeHtml(data.text || 'ok') + '». Можно подключить ещё провайдер во вкладках выше или нажать «Готово».';
      btn.textContent = 'Подключено ✓';
      input.disabled = true;
      refreshStatus();
    } catch (e) {
      msg.className = 'msg error'; msg.textContent = 'Сеть не отвечает: ' + e.message;
      btn.disabled = false; btn.textContent = 'Подключить и проверить';
    }
  });
});

document.querySelector('[data-action="done"]').addEventListener('click', async (e) => {
  e.preventDefault();
  // Show project picker instead of closing right away.
  showProjectPicker();
});

function showProjectPicker() {
  const projects = window.__FIRST_PROJECTS || [];
  const cards = projects.map(p => \`
    <button class="project-card" data-project-id="\${p.id}">
      <div class="project-emoji">\${p.emoji}</div>
      <div class="project-title">\${p.title}</div>
      <div class="project-desc">\${p.desc}</div>
      <div class="project-duration">⏱ \${p.duration}</div>
    </button>
  \`).join('');
  document.body.innerHTML = \`
    <style>
      .picker-wrap { max-width:780px; margin:0 auto; padding:32px 16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; }
      h1.picker-h { font-size:32px; margin:0 0 8px; letter-spacing:-.5px; }
      p.picker-sub { color:#65656d; margin:0 0 28px; font-size:16px; }
      .project-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; }
      .project-card { display:flex; flex-direction:column; padding:20px; border:2px solid #e3e3eb; border-radius:16px; background:#fff; cursor:pointer; transition:all .15s; text-align:left; font:inherit; }
      .project-card:hover { border-color:#1a73e8; transform:translateY(-2px); box-shadow:0 8px 24px rgba(26,115,232,.15); }
      .project-emoji { font-size:36px; margin-bottom:8px; }
      .project-title { font-size:17px; font-weight:600; margin-bottom:4px; color:#1d1d1f; }
      .project-desc { font-size:13px; color:#65656d; line-height:1.4; flex:1; }
      .project-duration { margin-top:10px; font-size:12px; color:#8b8b94; }
      @media (prefers-color-scheme:dark) {
        body { background:#1a1a1f; color:#f0f0f5; }
        .picker-sub { color:#8b8b94; }
        .project-card { background:#232328; border-color:#3a3a42; color:#f0f0f5; }
        .project-card:hover { border-color:#4a90e2; }
        .project-title { color:#f0f0f5; }
        .project-desc { color:#b8b8c0; }
      }
    </style>
    <div class="picker-wrap">
      <h1 class="picker-h">🎉 Подключено!</h1>
      <p class="picker-sub">Выбери первый проект — KRASAVACODE начнёт делать его сам, а ты посмотришь и подключишься.</p>
      <div class="project-grid">\${cards}</div>
    </div>
  \`;
  document.querySelectorAll('[data-project-id]').forEach(btn => {
    btn.addEventListener('click', () => pickProject(btn.dataset.projectId));
  });
}

async function pickProject(id) {
  await fetch('/api/done', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({ projectId: id }),
  });
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui;text-align:center;padding:24px;"><div><div style="font-size:64px;margin-bottom:16px;">✅</div><h1 style="font-size:28px;margin:0 0 12px;">Поехали!</h1><p style="font-size:18px;color:#65656d;margin:0 0 8px;max-width:520px;">Возвращайся в окно <b>Терминала</b> — KRASAVACODE уже работает над твоим проектом.</p><p style="font-size:14px;color:#8b8b94;">Mac: <kbd>⌘+Tab</kbd> &nbsp;·&nbsp; Windows: <kbd>Alt+Tab</kbd></p><p style="font-size:13px;color:#8b8b94;margin-top:32px;">Эту вкладку можно закрыть.</p></div></div>';
  setTimeout(() => { try { window.close(); } catch {} }, 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

window.addEventListener('beforeunload', () => {
  navigator.sendBeacon && navigator.sendBeacon('/api/cancel');
});
</script>
</body>
</html>`;
}

async function browserOnboarding() {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;

  let resolveResult;
  const done = new Promise(r => { resolveResult = r; });

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html());
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      const cfg = await configuredProviders();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ configured: cfg }));
    }
    if (req.method === 'POST' && req.url === '/api/verify') {
      try {
        const body = await readJsonBody(req);
        const provider = String(body.provider || '');
        const key = String(body.key || '').trim();
        const def = PROVIDERS[provider];
        if (!def) throw new Error('Unknown provider: ' + provider);
        if (!def.keyPattern.test(key)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Не похоже на ключ ${def.name}. Ожидается: ${def.keyExample}` }));
        }
        const r = await def.verify(key);
        if (!r.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: r.error }));
        }
        await persistKey(provider, key);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, text: r.text }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    if (req.method === 'POST' && (req.url === '/api/done' || req.url === '/api/cancel')) {
      let projectId = null;
      if (req.url === '/api/done') {
        try {
          const body = await readJsonBody(req).catch(() => ({}));
          projectId = body?.projectId || null;
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      const ok = req.url === '/api/done';
      setTimeout(async () => {
        const cfg = await configuredProviders();
        const project = FIRST_PROJECTS.find(p => p.id === projectId);
        resolveResult({
          launchAfter: ok,
          configured: cfg,
          firstPrompt: project?.prompt || null,
        });
      }, 100);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, '127.0.0.1');

  const opened = openBrowser(url);
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║  KRASAVACODE — подключаем AI-провайдеров          ║');
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');
  if (opened) console.log(`  🌐 Открыл настройку в браузере: ${url}`);
  else console.log(`  Скопируй и открой: ${url}`);
  console.log('  Можно подключить один или несколько (для надёжности).');
  console.log('');
  console.log('  Ctrl+C — отменить.');
  console.log('');

  let result;
  try {
    result = await Promise.race([
      done,
      new Promise((_, rej) => process.once('SIGINT', () => rej(new Error('cancelled'))) ),
    ]);
  } catch {
    result = { launchAfter: false, configured: await configuredProviders() };
  }
  server.close();
  return result;
}

/* ─── CLI fallback (non-GUI envs) ─── */

function prompt(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
}

async function cliOnboarding() {
  console.log('\n  Браузерный режим недоступен — запускаю текстовый.\n');
  console.log('  Доступные провайдеры:');
  for (const id of PROVIDER_PRIORITY) {
    const p = PROVIDERS[id];
    const have = await isProviderConfigured(id) ? '✓' : ' ';
    console.log(`    [${have}] ${p.name} — ${p.tagline}`);
  }
  console.log('');
  const which = (await prompt('  Какой настроить? (cerebras / groq / gemini): ')).trim().toLowerCase();
  const def = PROVIDERS[which];
  if (!def) { console.log('  Неизвестный провайдер.'); return { launchAfter: false }; }

  console.log(`\n  Открой: ${def.consoleUrl}`);
  for (const s of def.keyHowto) console.log(`    • ${s}`);

  let key;
  for (let i = 0; i < 3; i++) {
    key = (await prompt(`\n  Вставь ключ ${def.name}: `)).trim();
    if (def.keyPattern.test(key)) break;
    console.log(`  ⚠️  Не похоже на ключ. Ожидается: ${def.keyExample}\n`);
  }
  if (!def.keyPattern.test(key)) return { launchAfter: false };

  console.log('  ⏳ Проверяю…');
  const r = await def.verify(key);
  if (!r.ok) { console.log(`  ❌ ${r.error}`); return { launchAfter: false }; }
  await persistKey(which, key);
  console.log('  ✅ Подключено.\n');

  const launch = (await prompt('  Запустить вайбкодинг сейчас? [Enter — да, n — позже]: ')).trim().toLowerCase();
  return { launchAfter: ['', 'y', 'yes', 'д', 'да'].includes(launch) };
}

export async function runSetup() {
  const headless = isHeadlessLinux();
  if (headless) {
    console.log('  (Linux без GUI — открываю текстовый мастер)');
  }
  const useBrowser = !headless
    && process.env.KRASAVACODE_NO_BROWSER !== '1'
    && process.stdout.isTTY !== false;
  if (useBrowser) {
    try { return await browserOnboarding(); }
    catch (e) {
      console.error('  Браузерный мастер упал:', e.message);
      return cliOnboarding();
    }
  }
  return cliOnboarding();
}

// Backward-compat alias for old subcommand
export { runSetup as runSetupGemini };
