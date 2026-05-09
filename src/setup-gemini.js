import { spawn } from 'node:child_process';
import { mkdir, writeFile, chmod, readFile, access } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = join(homedir(), '.krasavacode');
const ENV_FILE = join(ROOT, 'gemini.env');
const STATE_FILE = join(ROOT, 'state.json');

const CONSOLE_URL = 'https://aistudio.google.com/apikey';

function openBrowser(url) {
  const cmd = platform() === 'darwin' ? 'open'
    : platform() === 'win32' ? 'start'
    : 'xdg-open';
  const args = platform() === 'win32' ? ['', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore', shell: platform() === 'win32' }).unref();
}

function readState() {
  return readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => ({}));
}
async function writeState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function isValidKeyFormat(key) {
  // Google API keys look like AIza followed by 35 chars [A-Za-z0-9_-]
  return /^AIza[A-Za-z0-9_-]{35}$/.test(key);
}

/** Sanity-check the key with a tiny Gemini API call. */
async function verifyKey(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Say only the word: ok' }] }],
      generationConfig: { maxOutputTokens: 20 },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    return { ok: false, error: msg, ms };
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return { ok: true, text: text.trim(), ms };
}

function header(text) {
  const line = '━'.repeat(58);
  console.log('');
  console.log(line);
  console.log('  ' + text);
  console.log(line);
  console.log('');
}

export async function runSetupGemini() {
  await mkdir(ROOT, { recursive: true });

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║  KRASAVACODE — апгрейд на Gemini 2.5 Flash       ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Сейчас вайбкодинг работает на простой модели.');
  console.log('  Подключив бесплатный Google Gemini, получишь:');
  console.log('    ✓ Качество в разы выше');
  console.log('    ✓ 1500 запросов в день бесплатно');
  console.log('    ✓ Без банковской карты');
  console.log('');
  console.log('  Это займёт 60 секунд.');

  header('Открываю в браузере: ' + CONSOLE_URL);
  openBrowser(CONSOLE_URL);

  console.log('  ШАГ 1. Войди через Google.');
  console.log('         (если у тебя Gmail, YouTube или Android — это он)');
  console.log('');
  console.log('  ШАГ 2. Нажми кнопку «Create API key» наверху страницы.');
  console.log('         Если попросят выбрать проект — оставь предложенный.');
  console.log('');
  console.log('  ШАГ 3. Появится длинная строка-ключ. Нажми «Copy».');
  console.log('         Ключ начинается с «AIza».');
  console.log('');
  console.log('  ШАГ 4. Вернись сюда в это окно и вставь ключ ниже.');
  console.log('         Mac: ⌘+V    Windows/Linux: Ctrl+V    или правая кнопка → Paste');
  console.log('');

  let key;
  for (let attempt = 0; attempt < 3; attempt++) {
    key = (await prompt('  Вставь ключ Gemini сюда: ')).trim();
    if (!key) {
      console.log('  ⚠️  Пусто. Скопируй ключ и попробуй ещё раз.\n');
      continue;
    }
    if (!isValidKeyFormat(key)) {
      console.log('  ⚠️  Не похоже на ключ Gemini.');
      console.log('      Должно быть AIza + 35 символов (всего 39).');
      console.log('      Скопируй ещё раз внимательно.\n');
      continue;
    }
    break;
  }
  if (!isValidKeyFormat(key)) {
    console.log('\n  ❌ Не удалось получить ключ. Запусти `krasavacode setup-gemini` ещё раз.');
    return;
  }

  console.log('\n  ⏳ Проверяю ключ через тестовый запрос…');
  const result = await verifyKey(key);
  if (!result.ok) {
    console.log(`  ❌ Ключ не работает: ${result.error}`);
    console.log('     Проверь, что скопировал целиком, без пробелов.');
    console.log('     Иногда Google требует подождать ~30 секунд после создания ключа.');
    console.log('     Запусти `krasavacode setup-gemini` ещё раз.');
    return;
  }
  console.log(`  ✅ Работает! Gemini ответил «${result.text}» за ${(result.ms / 1000).toFixed(1)} сек.`);

  // Save the key in a private env file (chmod 600)
  const envContent = `GEMINI_API_KEY=${key}\n`;
  await writeFile(ENV_FILE, envContent);
  try { await chmod(ENV_FILE, 0o600); } catch {}

  // Mark in state.json so future `krasavacode` runs know to use Gemini
  const state = await readState();
  state.geminiConfigured = true;
  state.geminiConfiguredAt = new Date().toISOString();
  await writeState(state);

  console.log('');
  console.log('  💾 Ключ сохранён в ' + ENV_FILE);
  console.log('     (он остаётся только у тебя на компьютере, никуда не отправляется)');
  console.log('');
  console.log('  ✅ Готово! Теперь твой вайбкодинг — на Gemini 2.5 Flash.');
  console.log('');

  const launch = (await prompt('  Запустить вайбкодинг прямо сейчас? [Enter — да, n — позже]: ')).trim().toLowerCase();
  if (launch === '' || launch === 'y' || launch === 'yes' || launch === 'д' || launch === 'да') {
    return { launchAfter: true };
  }
  console.log('\n  ОК. Когда захочешь — запусти `krasavacode`.');
  return { launchAfter: false };
}

/** Read GEMINI_API_KEY from gemini.env. Returns null if not configured. */
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
