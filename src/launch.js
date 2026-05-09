import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { configuredProviders, PROVIDERS } from './providers.js';
import { getCooldowns } from './cooldowns.js';

const PLACEHOLDER_TOKEN = 'sk-krasavacode-local';
const CLAUDE_CONFIG_DIR = join(homedir(), '.krasavacode', 'claude-config');

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

export async function launchClaude(paths, hub /*, detection */) {
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
    .filter(a => !['doctor', 'upgrade', 'setup', 'setup-gemini', 'gemini'].includes(a));
  if (useBare && !passthroughArgs.includes('--bare')) passthroughArgs.unshift('--bare');
  // Tell Claude Code that $HOME is a trusted directory — bypasses the
  // "trust this folder" dialog regardless of which directory the student
  // is in. settings.json seeds this too, but --add-dir is per-session safety.
  if (!passthroughArgs.some(a => a === '--add-dir')) {
    passthroughArgs.push('--add-dir', homedir());
  }

  const W = 64;
  const line = (txt) => {
    const pad = Math.max(0, W - 2 - [...txt].length);
    return '┃ ' + txt + ' '.repeat(pad) + '┃';
  };
  console.log('');
  console.log('┏' + '━'.repeat(W - 1) + '┓');
  console.log(line('  K R A S A V A C O D E'));
  console.log(line('  Бесплатный вайбкодинг через локальный hub'));
  console.log('┣' + '━'.repeat(W - 1) + '┫');
  if (configured.length === 0) {
    console.log(line('  Pollinations (gpt-oss-20b) — простая модель'));
    console.log(line('  Чтобы поднять качество: krasavacode setup'));
  } else {
    console.log(line('  Активная цепочка фолбэков:'));
    let i = 1;
    for (const id of configured) {
      const p = PROVIDERS[id];
      const cd = cooldowns[id];
      const onCooldown = cd && new Date(cd).getTime() > Date.now();
      const tag = onCooldown ? '⏳ на cooldown' : '✓ готов';
      console.log(line(`    ${i++}. ${p.name} — ${tag}`));
    }
    console.log(line(`    ${i}. Pollinations (последний резерв)`));
    console.log(line('  При 429 — автоматически прыгает на следующий'));
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
