import { spawn } from 'node:child_process';

const PLACEHOLDER_TOKEN = 'sk-krasavacode-local';

export async function launchClaude(paths, hub /*, detection */) {
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: hub.baseUrl,
    ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_TOKEN,
    ANTHROPIC_API_KEY: PLACEHOLDER_TOKEN,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    // Tell Claude Code which model to ask for. CCR will route any of these
    // to Pollinations via Router.default.
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  };

  const passthroughArgs = process.argv.slice(2).filter(a => !['doctor', 'upgrade'].includes(a));

  console.log('');
  console.log('━'.repeat(58));
  console.log('  KRASAVACODE — вайбкодинг через локальный hub');
  console.log('  Hub: ' + hub.baseUrl + '  (claude-code-router → Pollinations)');
  console.log('  Пиши задачу обычным языком, ИИ сделает.');
  console.log('━'.repeat(58));
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
