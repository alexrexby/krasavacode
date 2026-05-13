import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { configuredProviders, PROVIDERS } from './providers.js';
import { getCooldowns } from './cooldowns.js';
import { STUDENT_SYSTEM_PROMPT } from './system-prompt.js';

const PLACEHOLDER_TOKEN = 'sk-krasavacode-local';
const CLAUDE_CONFIG_DIR = join(homedir(), '.krasavacode', 'claude-config');
const PROJECTS_DIR = join(homedir(), 'krasavacode-projects');

/**
 * Pre-populate Claude Code's settings.json with answers to the onboarding
 * prompts so the student isn't asked:
 *   1. "Quick safety check: Is this a project you trust?" (workspace trust)
 *   2. "Detected a custom API key. Do you want to use it?" (custom-key dialog)
 *
 * These prompts are blockers for non-technical users — they don't know what
 * to answer. Since the bare mode forces our isolated CONFIG_DIR anyway,
 * pre-filling these acts as if the user already confirmed once.
 */
async function seedClaudeSettings() {
  await mkdir(CLAUDE_CONFIG_DIR, { recursive: true });
  const settings = {
    hasTrustDialogAccepted: true,
    hasCompletedOnboarding: true,
    skipAutoPermissionPrompt: true,
    customApiKeyResponses: {
      approved: [PLACEHOLDER_TOKEN],
      rejected: [],
    },
  };
  await writeFile(
    join(CLAUDE_CONFIG_DIR, 'settings.json'),
    JSON.stringify(settings, null, 2),
  );
}

/**
 * Sandbox: создаём отдельную папку для всех проектов ученика.
 * Claude Code запускается в ней с cwd, и --add-dir НЕ ставится на $HOME —
 * это значит claude может читать/писать только внутри этой папки и её
 * подкаталогов. Documents, Pictures, ключи и т.п. — недоступны.
 */
async function ensureProjectsDir() {
  await mkdir(PROJECTS_DIR, { recursive: true });
  // README в папке для самого ученика — открывает её в Finder и видит подсказку.
  const readme = join(PROJECTS_DIR, 'README.txt');
  try {
    await writeFile(readme, [
      'KRASAVACODE — твоя рабочая папка',
      '',
      'Здесь живут все проекты, которые ты делаешь через ВАЙБКОДИНГ.',
      'Каждый проект — отдельная подпапка. Например: tetris/, my-site/.',
      '',
      'Программа НЕ может выходить за пределы этой папки —',
      'твои Documents, Pictures и пароли в безопасности.',
      '',
      'Чтобы открыть проект в браузере — найди файл .html и дабл-клик.',
    ].join('\n'), { flag: 'wx' }); // wx = создать только если нет
  } catch {} // exists already
  return PROJECTS_DIR;
}

export async function launchClaude(paths, hub, opts = {}) {
  const { firstPrompt } = opts;
  const configured = await configuredProviders();
  const cooldowns = await getCooldowns();

  // After a successful browser-setup the user is in their browser, not the
  // Terminal window where claude is about to run. Bring Terminal to front so
  // they don't miss that the chat has already started.
  if (platform() === 'darwin') {
    spawn('osascript', ['-e', 'tell application "Terminal" to activate'],
      { stdio: 'ignore', detached: true }).unref();
  }

  // Isolate Claude Code's config/credentials from any real Anthropic login
  // the student may have on this machine (~/.claude/). This is the *only*
  // way to suppress the "Welcome back, NAME · publerplatforma@gmail.com's
  // Organization · API Usage Billing" header on the welcome screen.
  await seedClaudeSettings();

  // Sandbox: claude works inside ~/krasavacode-projects/ (cwd) — can't reach
  // Documents/Pictures/keys/etc by default. User can opt out with KRASAVACODE_NO_SANDBOX=1.
  const useSandbox = process.env.KRASAVACODE_NO_SANDBOX !== '1';
  const cwd = useSandbox ? await ensureProjectsDir() : process.cwd();

  // Drop any pre-existing Anthropic creds from the shell/Keychain so the
  // welcome screen doesn't greet the student with the real Anthropic owner's
  // name and "API Usage Billing".
  const cleanEnv = { ...process.env };
  delete cleanEnv.ANTHROPIC_API_KEY;
  delete cleanEnv.ANTHROPIC_AUTH_TOKEN;
  delete cleanEnv.ANTHROPIC_VERTEX_PROJECT_ID;
  delete cleanEnv.ANTHROPIC_BEDROCK_BASE_URL;

  const env = {
    ...cleanEnv,
    ANTHROPIC_BASE_URL: hub.baseUrl,
    // --bare mode requires ANTHROPIC_API_KEY (OAuth token is ignored).
    // Our proxy doesn't actually validate this — any non-empty value works.
    ANTHROPIC_API_KEY: PLACEHOLDER_TOKEN,
    // Isolate config/credentials: own dir, separate from ~/.claude/
    ANTHROPIC_CONFIG_DIR: CLAUDE_CONFIG_DIR,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    // Tell Claude Code which model to ask for. We use the `sonnet` alias —
    // it always resolves to whichever Sonnet is current in this Claude Code
    // version (claude-sonnet-4.5 → 4.6 → 4.7…). Hard-coding a numeric
    // version breaks when Anthropic deprecates it.
    // CCR sees this as the request "model" but our metrics-proxy rewrites
    // body.model to "<provider>,<provider-model>" before forwarding.
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'sonnet',
  };

  // --bare mode: skips Keychain reads, plugin sync, auto-memory, attribution,
  // CLAUDE.md auto-discovery — i.e. everything that would leak the user's
  // real Anthropic identity into the welcome screen.
  // Set KRASAVACODE_BARE=0 to disable for debugging.
  const useBare = process.env.KRASAVACODE_BARE !== '0';
  const passthroughArgs = process.argv.slice(2)
    .filter(a => !['doctor', 'upgrade', 'setup', 'setup-gemini', 'gemini', 'reset'].includes(a));
  if (useBare && !passthroughArgs.includes('--bare')) passthroughArgs.unshift('--bare');
  // Tell Claude Code that $HOME is a trusted directory — bypasses the
  // "trust this folder" dialog regardless of which directory the student
  // is in. settings.json seeds this too, but --add-dir is per-session safety.
  // We deliberately do NOT add $HOME to --add-dir — that would defeat the
  // sandbox. Claude Code's default tool-access scope is its cwd, which is
  // ~/krasavacode-projects/.
  // Append our "teacher of vibecoding" system prompt unless user explicitly
  // overrode it with their own --append-system-prompt or --system-prompt.
  const hasOwnSystemPrompt = passthroughArgs.some(a =>
    a === '--system-prompt' || a === '--append-system-prompt' || a === '--system-prompt-file'
  );
  if (!hasOwnSystemPrompt && process.env.KRASAVACODE_NO_TEACHER !== '1') {
    passthroughArgs.push('--append-system-prompt', STUDENT_SYSTEM_PROMPT);
  }
  // First-project onboarding: pass the picked prompt as the positional
  // argument to claude. Claude Code starts an interactive session AND
  // immediately processes this first prompt.
  if (firstPrompt) {
    passthroughArgs.push(firstPrompt);
  }

  const W = 64;
  const line = (txt) => {
    const pad = Math.max(0, W - 2 - [...txt].length);
    return '┃ ' + txt + ' '.repeat(pad) + '┃';
  };
  console.log('');
  console.log('┏' + '━'.repeat(W - 1) + '┓');
  console.log(line('  ✍️  ПИШИ СВОЮ ЗАДАЧУ ЗДЕСЬ — В ЭТО ОКНО'));
  console.log(line(''));
  console.log(line('  Не в браузере! Браузер можно закрыть.'));
  console.log(line('  Сейчас откроется чат с AI — будет строка'));
  console.log(line('  ввода прямо тут. Пиши обычным языком.'));
  console.log(line(''));
  console.log(line('  Пример: «Сделай игру тетрис на html»'));
  console.log('┣' + '━'.repeat(W - 1) + '┫');
  if (configured.length === 0) {
    console.log(line('  Pollinations (gpt-oss-20b) — простая модель'));
    console.log(line('  Чтобы поднять качество: krasavacode setup'));
  } else {
    console.log(line('  Подключённые провайдеры (fallback chain):'));
    let i = 1;
    for (const id of configured) {
      const p = PROVIDERS[id];
      const cd = cooldowns[id];
      const onCooldown = cd && new Date(cd).getTime() > Date.now();
      const tag = onCooldown ? '⏳ на cooldown' : '✓ готов';
      console.log(line(`    ${i++}. ${p.name} — ${tag}`));
    }
    console.log(line(`    ${i}. Pollinations (последний резерв)`));
  }
  console.log('┗' + '━'.repeat(W - 1) + '┛');
  console.log('');

  // Merge env from runtime (PATH with bundled Node when applicable) with our overrides
  const finalEnv = { ...(paths.env || process.env), ...env };

  return new Promise((resolve, reject) => {
    const child = spawn(paths.claudeBin, passthroughArgs, {
      env: finalEnv,
      stdio: 'inherit',
      cwd,
    });

    child.on('error', reject);
    child.on('exit', async () => {
      // On Windows the parent .bat will close the cmd window immediately after
      // claude exits — the student loses their work output and any error msg.
      // Hold the window open until they press a key.
      if (platform() === 'win32' && process.stdin.isTTY) {
        console.log('');
        console.log('═'.repeat(60));
        console.log('  Сессия завершена. Чтобы начать заново — дабл-клик');
        console.log('  по значку VIBECODE на Рабочем столе.');
        console.log('═'.repeat(60));
        process.stderr.write('\nНажми Enter чтобы закрыть это окно...');
        await new Promise(res => {
          process.stdin.once('data', () => res());
          process.stdin.resume();
        }).catch(() => {});
      }
      resolve();
    });
  });
}
