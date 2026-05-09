#!/usr/bin/env node
import { ensureRuntime } from '../src/runtime.js';
import { startHub, stopHub } from '../src/hub.js';
import { ensurePreset } from '../src/preset.js';
import { launchClaude } from '../src/launch.js';
import { runUpgrade } from '../src/upgrade.js';
import { runDoctor } from '../src/doctor.js';
import { runSetup } from '../src/setup.js';
import { runReset } from '../src/reset.js';
import { configuredProviders } from '../src/providers.js';

// Hardcoded so it works inside Bun --compile (no FS access to package.json)
const VERSION = '0.5.12';

const cmd = process.argv[2];

async function main() {
  if (cmd === 'doctor') return runDoctor();
  if (cmd === 'upgrade') return runUpgrade();
  if (cmd === 'reset') return runReset();
  if (cmd === '--version' || cmd === '-v') {
    console.log(`KRASAVACODE v${VERSION}`);
    return;
  }

  const isExplicitSetup = cmd === 'setup' || cmd === 'setup-gemini' || cmd === 'gemini';

  // First-run auto-setup: if no providers are connected, force the wizard
  // before going to the chat. The user shouldn't have to know about
  // "krasavacode setup" — they just clicked the desktop icon.
  let firstPrompt = null;
  if (isExplicitSetup || (!cmd && (await configuredProviders()).length === 0)) {
    if (!isExplicitSetup) {
      console.log('');
      console.log('  👋 Первый запуск — давай подключим бесплатные ИИ за минуту.');
      console.log('     Сейчас откроется окно в браузере с вкладками для подключения.');
      console.log('');
    }
    const result = await runSetup();
    if (!result?.launchAfter) return;
    firstPrompt = result?.firstPrompt || null;
    // fall through to normal launch flow below
  }

  const paths = await ensureRuntime();
  await ensurePreset();
  const hub = await startHub(paths);

  process.on('SIGINT', () => stopHub(hub).then(() => process.exit(0)));
  process.on('SIGTERM', () => stopHub(hub).then(() => process.exit(0)));

  await launchClaude(paths, hub, { firstPrompt });

  await stopHub(hub);
}

main().catch(err => {
  console.error('\n❌ KRASAVACODE упал:', err.message);
  if (process.env.KRASAVACODE_DEBUG) console.error(err.stack);
  console.error('\nЗапусти `krasavacode doctor` для диагностики.');
  process.exit(1);
});
