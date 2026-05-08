#!/usr/bin/env node
import { ensureRuntime } from '../src/runtime.js';
import { startHub, stopHub } from '../src/hub.js';
import { ensurePreset } from '../src/preset.js';
import { launchClaude } from '../src/launch.js';
import { runUpgrade } from '../src/upgrade.js';
import { runDoctor } from '../src/doctor.js';

const cmd = process.argv[2];

async function main() {
  if (cmd === 'doctor') return runDoctor();
  if (cmd === 'upgrade') return runUpgrade();
  if (cmd === '--version' || cmd === '-v') {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
    console.log(`KRASAVACODE v${pkg.version}`);
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
