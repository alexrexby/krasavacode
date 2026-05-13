#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
const VERSION = '0.5.27';

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

function writeCrashLog(err) {
  try {
    const dir = path.join(os.homedir(), '.krasavacode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'last-crash.log');
    const ts = new Date().toISOString();
    const body = [
      `=== KRASAVACODE crash @ ${ts} ===`,
      `version: ${VERSION}`,
      `platform: ${process.platform} ${process.arch}`,
      `node: ${process.version}`,
      `cwd: ${process.cwd()}`,
      `cmd: ${cmd || '(default)'}`,
      `message: ${err?.message || String(err)}`,
      err?.stack || '(no stack)',
      '',
    ].join('\n');
    fs.appendFileSync(file, body);
    return file;
  } catch {
    return null;
  }
}

async function pauseOnWindows() {
  // Без pause на Windows .bat закроет окно — юзер не увидит ошибку.
  // На POSIX скрипты обычно ждут возврат сами.
  if (process.platform !== 'win32') return;
  if (!process.stdin.isTTY) return;
  try {
    process.stderr.write('\nНажми Enter чтобы закрыть это окно...');
    await new Promise(resolve => {
      process.stdin.once('data', () => resolve());
      process.stdin.resume();
    });
  } catch { /* ignore */ }
}

main().catch(async err => {
  console.error('\n❌ KRASAVACODE упал:', err.message);
  console.error(err.stack);
  const logFile = writeCrashLog(err);
  if (logFile) console.error(`\nПолный лог: ${logFile}`);
  console.error('\nЗапусти `krasavacode doctor` или пришли этот лог наставнику.');
  await pauseOnWindows();
  process.exit(1);
});
