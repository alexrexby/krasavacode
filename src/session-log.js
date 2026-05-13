/**
 * Session logging — пишет всё stderr (и наши console.log/error) в файл,
 * чтобы можно было после ошибки скопировать лог наставнику.
 *
 * Файлы: ~/.krasavacode/sessions/<YYYY-MM-DD_HH-MM-SS>.log
 * Symlink: ~/.krasavacode/sessions/latest.log → текущий
 * Старше 7 дней — удаляются автоматически.
 *
 * Включается всегда (overhead копеечный). KRASAVACODE_NO_LOG=1 отключает.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const ROOT = path.join(homedir(), '.krasavacode');
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const LATEST_SYMLINK = path.join(SESSIONS_DIR, 'latest.log');
const RETENTION_DAYS = 7;

let logStream = null;
let logPath = null;

function ts() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function purgeOldLogs() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600_000;
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.log') || f === 'latest.log') continue;
      const p = path.join(SESSIONS_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

export function startSessionLog(cmdLabel = '') {
  if (process.env.KRASAVACODE_NO_LOG === '1') return null;

  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    purgeOldLogs();

    logPath = path.join(SESSIONS_DIR, `${ts()}.log`);
    logStream = fs.createWriteStream(logPath, { flags: 'a' });

    try { fs.unlinkSync(LATEST_SYMLINK); } catch {}
    try { fs.symlinkSync(path.basename(logPath), LATEST_SYMLINK); } catch {
      // Windows без admin: symlink не работает — копируем при flush.
    }

    const header = [
      `=== KRASAVACODE session @ ${new Date().toISOString()} ===`,
      `platform: ${process.platform} ${process.arch}`,
      `node: ${process.version}`,
      `pid: ${process.pid}`,
      `cmd: ${cmdLabel || '(launch)'}`,
      `cwd: ${process.cwd()}`,
      '',
    ].join('\n');
    logStream.write(header);

    // Patch console.error / console.log / process.stderr.write to tee into log.
    // We don't touch stdout — that's the interactive claude session and we
    // don't want huge files. Just stderr (where all our DEBUG output goes).
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      try { logStream.write(chunk); } catch {}
      return origErr(chunk, ...rest);
    };

    // Capture uncaught exceptions
    process.on('uncaughtException', err => {
      try { logStream.write(`\n[uncaught] ${err.stack || err.message}\n`); } catch {}
    });
    process.on('unhandledRejection', err => {
      try { logStream.write(`\n[unhandled] ${err?.stack || err?.message || err}\n`); } catch {}
    });

    return logPath;
  } catch {
    return null;
  }
}

export function getLogPath() { return logPath; }

export function printLogHint() {
  if (!logPath) return;
  console.error(`📝 Сессия пишется в: ${logPath}`);
  console.error('   Если что-то сломается — скопируй этот файл наставнику.');
  console.error('');
}

/** Lists session logs, newest first. */
export function listLogs() {
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.log') && f !== 'latest.log')
      .map(f => ({ name: f, path: path.join(SESSIONS_DIR, f), mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/** Reads the last N lines of the latest log (or specified file). */
export function tailLog(filePath, lines = 200) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const all = content.split('\n');
    return all.slice(-lines).join('\n');
  } catch (e) {
    return `(не могу прочесть ${filePath}: ${e.message})`;
  }
}
