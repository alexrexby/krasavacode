#!/usr/bin/env node
import { ensureRuntime } from '../src/runtime.js';
import { startHub, stopHub } from '../src/hub.js';
import { ensurePreset } from '../src/preset.js';
import { launchClaude } from '../src/launch.js';
import { runUpgrade } from '../src/upgrade.js';
import { runDoctor } from '../src/doctor.js';
import { runSetup } from '../src/setup.js';

// Hardcoded so it works inside Bun --compile (no FS access to package.json)
const VERSION = '0.4.1';

const cmd = process.argv[2];

async function main() {
  if (cmd === 'doctor') return runDoctor();
  if (cmd === 'upgrade') return runUpgrade();
  if (cmd === 'setup' || cmd === 'setup-gemini' || cmd === 'gemini') {
    const result = await runSetup();
    if (!result?.launchAfter) return;
    // fall through to normal launch flow below
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(`KRASAVACODE v${VERSION}`);
    return;
  }

  const paths = await ensureRuntime();
  await ensurePreset();
  const hub = await startHub(paths);

  process.on('SIGINT', () => stopHub(hub).then(() => process.exit(0)));
  process.on('SIGTERM', () => stopHub(hub).then(() => process.exit(0)));

  await launchClaude(paths, hub);

  await stopHub(hub);
}

main().catch(err => {
  console.error('\n❌ KRASAVACODE упал:', err.message);
  if (process.env.KRASAVACODE_DEBUG) console.error(err.stack);
  console.error('\nЗапусти `krasavacode doctor` для диагностики.');
  process.exit(1);
});
