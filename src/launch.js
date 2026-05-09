import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isGeminiConfigured } from './setup-gemini.js';
import { getQuotaInfo } from './metrics-proxy.js';

const PLACEHOLDER_TOKEN = 'sk-krasavacode-local';
const CLAUDE_CONFIG_DIR = join(homedir(), '.krasavacode', 'claude-config');

export async function launchClaude(paths, hub /*, detection */) {
  const geminiOn = await isGeminiConfigured();
  // Isolate Claude Code's config/credentials from any real Anthropic login
  // the student may have on this machine (~/.claude/). This is the *only*
  // way to suppress the "Welcome back, NAME · publerplatforma@gmail.com's
  // Organization · API Usage Billing" header on the welcome screen.
  await mkdir(CLAUDE_CONFIG_DIR, { recursive: true });

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
    // Tell Claude Code which model to ask for. CCR will route any of these
    // to Pollinations / Gemini via Router.default.
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  };

  // --bare mode: skips Keychain reads, plugin sync, auto-memory, attribution,
  // CLAUDE.md auto-discovery — i.e. everything that would leak the user's
  // real Anthropic identity into the welcome screen.
  // Set KRASAVACODE_BARE=0 to disable for debugging.
  const useBare = process.env.KRASAVACODE_BARE !== '0';
  const passthroughArgs = process.argv.slice(2)
    .filter(a => !['doctor', 'upgrade', 'setup-gemini', 'gemini'].includes(a));
  if (useBare && !passthroughArgs.includes('--bare')) passthroughArgs.unshift('--bare');

  const W = 64;
  const line = (txt) => {
    const pad = Math.max(0, W - 2 - [...txt].length);
    return '┃ ' + txt + ' '.repeat(pad) + '┃';
  };
  const quota = await getQuotaInfo();
  console.log('');
  console.log('┏' + '━'.repeat(W - 1) + '┓');
  console.log(line('  K R A S A V A C O D E'));
  console.log(line('  Бесплатный вайбкодинг через локальный hub'));
  console.log('┣' + '━'.repeat(W - 1) + '┫');
  if (geminiOn) {
    console.log(line('  ✓ Модель: Google Gemini 2.5 Flash'));
    const left = quota.perDay - quota.used;
    if (left > 100) {
      console.log(line(`    Сегодня осталось: ${left} из ${quota.perDay} запросов`));
    } else if (left > 0) {
      console.log(line(`  ⚠️  Осталось ${left} из ${quota.perDay} — обнулится завтра`));
    } else {
      console.log(line(`  ❌ Лимит на сегодня исчерпан (${quota.used} из ${quota.perDay})`));
      console.log(line(`     Обнулится в ~21:00 МСК`));
    }
  } else {
    console.log(line('  · Модель: gpt-oss-20b через Pollinations'));
    console.log(line('    (бесплатно, без логина)'));
    console.log(line(`    Сегодня сделал ${quota.used} запросов`));
    console.log(line('  💡 Лучше модель: krasavacode setup-gemini'));
  }
  console.log('┗' + '━'.repeat(W - 1) + '┛');
  console.log('');
  console.log('  Дальше открывается Claude Code от Anthropic — это');
  console.log('  его экран приветствия, не наш. Просто пиши задачу.');
  console.log('');

  // Merge env from runtime (PATH with bundled Node when applicable) with our overrides
  const finalEnv = { ...(paths.env || process.env), ...env };

  return new Promise((resolve, reject) => {
    const child = spawn(paths.claudeBin, passthroughArgs, {
      env: finalEnv,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', () => resolve());
  });
}
