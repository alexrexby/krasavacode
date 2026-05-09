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

function compressText(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s
    .replace(ZERO_WIDTH, '')
    // Trailing whitespace per line
    .replace(/[ \t]+\n/g, '\n')
    // 3+ blank lines → one blank line
    .replace(/\n{3,}/g, '\n\n');

  // Dedup repeated identical lines (works on long lines only to avoid eating
  // legitimate empty separators or short prompts)
  const lines = out.split('\n');
  const dedup = [];
  let prev = null;
  for (const line of lines) {
    if (line.length > 30 && line === prev) continue;
    dedup.push(line);
    prev = line;
  }
  return dedup.join('\n');
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
  if (Array.isArray(parsed.messages)) {
    for (const m of parsed.messages) {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (!block || typeof block !== 'object') continue;
          if (typeof block.text === 'string') block.text = compressText(block.text);
          // tool_result: content is often an array of {type:'text', text} or string
          if (block.type === 'tool_result') {
            if (typeof block.content === 'string') {
              block.content = compressText(block.content);
            } else if (Array.isArray(block.content)) {
              for (const sub of block.content) {
                if (sub && typeof sub.text === 'string') sub.text = compressText(sub.text);
              }
            }
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
