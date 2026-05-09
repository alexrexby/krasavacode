import { spawn } from 'node:child_process';
import { isGeminiConfigured } from './setup-gemini.js';

const PLACEHOLDER_TOKEN = 'sk-krasavacode-local';

export async function launchClaude(paths, hub /*, detection */) {
  const geminiOn = await isGeminiConfigured();

  // Drop any pre-existing ANTHROPIC_API_KEY (from the user's shell or a real
  // Anthropic login) so it doesn't conflict with our auth-token, and so that
  // Claude Code's welcome screen doesn't show the user's real Anthropic org.
  const cleanEnv = { ...process.env };
  delete cleanEnv.ANTHROPIC_API_KEY;
  delete cleanEnv.ANTHROPIC_VERTEX_PROJECT_ID;
  delete cleanEnv.ANTHROPIC_BEDROCK_BASE_URL;

  const env = {
    ...cleanEnv,
    ANTHROPIC_BASE_URL: hub.baseUrl,
    ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_TOKEN,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    // Tell Claude Code which model to ask for. CCR will route any of these
    // to Pollinations / Gemini via Router.default.
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  };

  const passthroughArgs = process.argv.slice(2).filter(a => !['doctor', 'upgrade'].includes(a));

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
  if (geminiOn) {
    console.log(line('  ✓ Модель: Google Gemini 2.5 Flash'));
    console.log(line('    (1500 запросов в день, бесплатно)'));
  } else {
    console.log(line('  · Модель: gpt-oss-20b через Pollinations'));
    console.log(line('    (бесплатно, без логина)'));
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
