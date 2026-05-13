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
import { startSessionLog, listLogs, tailLog, printLogHint } from '../src/session-log.js';

// Hardcoded so it works inside Bun --compile (no FS access to package.json)
const VERSION = '0.5.32';

const cmd = process.argv[2];

// Session log: всегда включён (overhead ~0). Дублирует stderr в файл.
// Нужен чтобы при ошибке у ученика наставник мог посмотреть полный контекст.
const SESSION_LOG_PATH = startSessionLog(cmd || '(launch)');

// Force debug mode by default — мы хотим видеть весь metrics-proxy retry-flow
// и cooldown-логику в session-логе. Performance impact нулевой.
if (!process.env.KRASAVACODE_DEBUG && !process.env.KRASAVACODE_NO_DEBUG) {
  process.env.KRASAVACODE_DEBUG = '1';
}

function runLogs() {
  const sub = process.argv[3];
  const logs = listLogs();
  if (sub === '--list' || sub === 'list') {
    if (logs.length === 0) { console.log('Логов пока нет.'); return; }
    console.log(`Логи сессий (${logs.length}, новые сверху):`);
    for (const l of logs.slice(0, 20)) {
      const ago = Math.round((Date.now() - l.mtime) / 60000);
      console.log(`  ${l.path}  (${ago} мин назад)`);
    }
    return;
  }
  if (sub === '--tail' || sub === 'tail') {
    const n = parseInt(process.argv[4]) || 200;
    if (logs.length === 0) { console.log('Логов нет.'); return; }
    console.log(tailLog(logs[0].path, n));
    return;
  }
  // Default: print path of the most recent log so the student can copy it.
  if (logs.length === 0) { console.log('Логов пока нет. Запусти krasavacode и попробуй ещё раз.'); return; }
  const latest = logs[0];
  console.log('');
  console.log('  Последний лог сессии:');
  console.log(`  ${latest.path}`);
  console.log('');
  console.log('  Чтобы прочесть:');
  console.log(`    krasavacode logs --tail 200    # последние 200 строк`);
  console.log(`    krasavacode logs --list        # все логи`);
  console.log('');
  console.log('  Чтобы отправить наставнику — открой файл и скопируй текст.');
}

async function main() {
  if (cmd === 'doctor') return runDoctor();
  if (cmd === 'upgrade') return runUpgrade();
  if (cmd === 'reset') return runReset();
  if (cmd === 'logs') return runLogs();
  if (cmd === '--version' || cmd === '-v') {
    console.log(`KRASAVACODE v${VERSION}`);
    return;
  }

  if (SESSION_LOG_PATH) printLogHint();

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
