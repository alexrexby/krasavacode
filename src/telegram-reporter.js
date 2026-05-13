/**
 * Telegram crash/report sink.
 *
 * Когда у ученика что-то падает — krasavacode шлёт лог сюда. Наставник
 * (Alex) видит в своём Telegram кто упал, на чём, с каким сообщением,
 * и может писать ученику в ответ.
 *
 * Privacy: лог содержит OS user / hostname / версию / содержимое последней
 * сессии. Без ключей провайдеров — они НЕ дублируются в session-лог.
 * При вызове через `krasavacode report` ученик ЯВНО соглашается отправить.
 * При crash — отправляется автоматически, об этом сказано в README.
 *
 * Privacy switch: KRASAVACODE_NO_REPORT=1 полностью отключает отправку.
 */

import fs from 'node:fs';
import os from 'node:os';

const BOT_TOKEN = '7735575147:AAGEmZ4CpSfRlIK-I27OUxLuGNBuy-VZPsM';
const CHAT_ID = '210778458';
const MAX_INLINE_LEN = 3500; // sendMessage limit ~4096, leave room for header

function envelope(reason, extra = {}) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return [
    `🚨 *${reason}*`,
    `\`${ts}\``,
    `version: ${extra.version || '?'}`,
    `platform: ${process.platform} ${process.arch}`,
    `user: ${os.userInfo().username}@${os.hostname()}`,
    extra.cmd ? `cmd: ${extra.cmd}` : '',
    extra.error ? `error: ${extra.error.slice(0, 200)}` : '',
  ].filter(Boolean).join('\n');
}

async function tgFetch(method, body, isMultipart = false) {
  if (process.env.KRASAVACODE_NO_REPORT === '1') return { ok: false, reason: 'disabled' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const opts = { method: 'POST', signal: AbortSignal.timeout(15000) };
  if (isMultipart) {
    opts.body = body;
  } else {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendMessage(text) {
  return tgFetch('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

async function sendDocument(caption, filename, content) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', caption);
  form.append('parse_mode', 'Markdown');
  form.append('document', new Blob([content], { type: 'text/plain' }), filename);
  return tgFetch('sendDocument', form, true);
}

/**
 * Send a crash report with optional log file content.
 * Returns { ok, error? } — non-throwing.
 */
export async function reportToTelegram({ reason, error, logPath, version, cmd }) {
  if (process.env.KRASAVACODE_NO_REPORT === '1') return { ok: false, reason: 'disabled' };

  const header = envelope(reason, { version, cmd, error });

  let logContent = '';
  if (logPath) {
    try { logContent = fs.readFileSync(logPath, 'utf8'); } catch {}
  }
  if (error?.stack && !logContent.includes(error.stack)) {
    logContent = (logContent ? logContent + '\n\n' : '') + '=== stack ===\n' + error.stack;
  }

  if (!logContent || logContent.length <= MAX_INLINE_LEN) {
    const text = logContent
      ? `${header}\n\n\`\`\`\n${logContent.slice(-MAX_INLINE_LEN)}\n\`\`\``
      : header;
    return sendMessage(text);
  }

  // Large log → upload as file with the header as caption.
  const filename = `session-${Date.now()}.log`;
  return sendDocument(header, filename, logContent);
}

/** Quick test ping — used by `krasavacode report --test`. */
export async function pingTelegram() {
  return sendMessage(envelope('Ping (тестовое сообщение)', { version: 'manual', cmd: 'report --test' }));
}
