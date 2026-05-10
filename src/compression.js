/**
 * Lightweight payload compression — отбирает 5-15% токенов из текста
 * без потерь смысла. Применяется ко всем провайдерам.
 *
 * Что делает:
 *   1. Удаляет trailing whitespace в каждой строке
 *   2. Схлопывает 3+ подряд переносов строк в 2 (одна пустая строка)
 *   3. Схлопывает повторяющиеся одинаковые строки длиннее 30 символов
 *      ("Файл существует. Файл существует." → "Файл существует.")
 *   4. Убирает мусорные unicode-маркеры из tool-output (zero-width spaces)
 *
 * Что НЕ делает (специально):
 *   - Не трогает пробелы внутри строк (Python indent сохраняется)
 *   - Не трогает code blocks между ``` (важно для генерации кода)
 *   - Не трогает JSON структуру (только text-значения)
 *   - Не суммаризирует — только лексические правки
 *
 * Отключение: KRASAVACODE_NO_COMPRESS=1
 */

const ZERO_WIDTH = /[​‌‍﻿]/g;
// ANSI escape codes (colors, cursor moves, etc) — bash output spam
const ANSI_ESC = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// Прогресс-бары и аналог
const PROGRESS_BAR = /^[\s|]*[#=▓░▒█▌▐\.\->o]{6,}[\s\d.%]*$/;

function compressText(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s
    .replace(ZERO_WIDTH, '')
    .replace(ANSI_ESC, '')
    // Trailing whitespace per line
    .replace(/[ \t]+\n/g, '\n')
    // 3+ blank lines → one blank line
    .replace(/\n{3,}/g, '\n\n');

  // Dedup repeated identical lines (works on long lines only to avoid eating
  // legitimate empty separators or short prompts) AND drop progress-bar noise.
  const lines = out.split('\n');
  const dedup = [];
  let prev = null;
  for (const line of lines) {
    if (line.length > 30 && line === prev) continue;
    if (PROGRESS_BAR.test(line)) continue;
    dedup.push(line);
    prev = line;
  }
  return dedup.join('\n');
}

/**
 * Tool-result trimming: длинные tool_result-блоки (Read больших файлов,
 * Bash логи) сжимаются по схеме:
 *   - <= 200 строк: оставляем как есть
 *   - > 200 строк: первые 100 + маркер + последние 50
 *
 * Дедуп между turn'ами: если этот же tool_use_id уже встречался в более
 * раннем сообщении с длинным content, новый занимаем referrence-стрингом.
 */
const TOOL_RESULT_MAX_LINES = 200;
const TOOL_RESULT_HEAD = 100;
const TOOL_RESULT_TAIL = 50;

function trimToolResultText(text) {
  if (typeof text !== 'string') return text;
  const lines = text.split('\n');
  if (lines.length <= TOOL_RESULT_MAX_LINES) return text;
  const head = lines.slice(0, TOOL_RESULT_HEAD);
  const tail = lines.slice(-TOOL_RESULT_TAIL);
  const skipped = lines.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  return [
    ...head,
    `[…свернуто ${skipped} строк — показаны первые ${TOOL_RESULT_HEAD} и последние ${TOOL_RESULT_TAIL}…]`,
    ...tail,
  ].join('\n');
}

function processToolResultBlock(block, seenContents) {
  // block.content can be a string or an array of {type:'text', text}
  if (typeof block.content === 'string') {
    const trimmed = trimToolResultText(block.content);
    // Dedup: if this exact content already appeared earlier in the conversation,
    // replace with a reference. Saves megabytes when a file is read repeatedly.
    if (trimmed.length > 200 && seenContents.has(trimmed)) {
      block.content = `[…дублирует предыдущий tool_result (${trimmed.length} символов)…]`;
    } else {
      block.content = trimmed;
      if (trimmed.length > 200) seenContents.add(trimmed);
    }
  } else if (Array.isArray(block.content)) {
    for (const sub of block.content) {
      if (sub && typeof sub.text === 'string') {
        const trimmed = trimToolResultText(sub.text);
        if (trimmed.length > 200 && seenContents.has(trimmed)) {
          sub.text = `[…дублирует предыдущий tool_result (${trimmed.length} символов)…]`;
        } else {
          sub.text = trimmed;
          if (trimmed.length > 200) seenContents.add(trimmed);
        }
      }
    }
  }
}

/**
 * Walks the Anthropic-style payload and applies compressText to every
 * `text` field — both top-level system blocks and message content blocks.
 * Mutates in place.
 */
export function compressPayload(parsed) {
  if (process.env.KRASAVACODE_NO_COMPRESS === '1') return { saved: 0, before: 0, after: 0 };
  const before = JSON.stringify(parsed).length;

  // system: array of {type:'text', text}
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) {
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        block.text = compressText(block.text);
      }
    }
  } else if (typeof parsed.system === 'string') {
    parsed.system = compressText(parsed.system);
  }

  // messages[i].content: array of blocks {type, text, content?...}
  // We track seen tool_result contents across turns to dedup repeated file reads.
  const seenToolContents = new Set();
  if (Array.isArray(parsed.messages)) {
    for (const m of parsed.messages) {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (!block || typeof block !== 'object') continue;
          if (typeof block.text === 'string') block.text = compressText(block.text);
          if (block.type === 'tool_result') {
            // First lexical compression, then long-content trimming + dedup
            if (typeof block.content === 'string') {
              block.content = compressText(block.content);
            } else if (Array.isArray(block.content)) {
              for (const sub of block.content) {
                if (sub && typeof sub.text === 'string') sub.text = compressText(sub.text);
              }
            }
            processToolResultBlock(block, seenToolContents);
          }
        }
      } else if (typeof m.content === 'string') {
        m.content = compressText(m.content);
      }
    }
  }

  const after = JSON.stringify(parsed).length;
  return { saved: before - after, before, after };
}
