/**
 * `krasavacode reset` — снимает все ключи провайдеров, cooldown'ы и
 * наш ccr-config. Не трогает runtime/ (бинарники Claude Code и ccr) —
 * это позволяет переустановить ключи без долгой повторной загрузки.
 *
 * Полезно когда:
 *   - старый ключ провайдера протух / отозван и хочется чистый старт
 *   - конфиг ccr побился
 *   - ученик хочет передать машину другому ученику без своих данных
 */

import { rm, access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = join(homedir(), '.krasavacode');
const CCR_DIR = join(homedir(), '.claude-code-router');

const TARGETS = [
  { path: join(ROOT, 'keys'), label: 'API-ключи всех провайдеров' },
  { path: join(ROOT, 'cooldowns.json'), label: 'история блокировок (cooldowns)' },
  { path: join(ROOT, 'usage.json'), label: 'статистика использования' },
  { path: join(ROOT, 'state.json'), label: 'настройки KRASAVACODE' },
  { path: join(CCR_DIR, 'config.json'), label: 'конфиг claude-code-router' },
  { path: join(ROOT, 'claude-config'), label: 'изолированные настройки Claude Code' },
  // Claude Code v2.1+ создаёт эти пути в обход ANTHROPIC_CONFIG_DIR.
  // Чистим тоже, иначе остаётся история сессий и projects-state.
  { path: join(homedir(), '.claude'), label: 'остатки Claude Code в ~/.claude/' },
  { path: join(homedir(), '.claude.json'), label: '~/.claude.json (project-state Claude Code)' },
];

const KEEP = [
  { path: join(ROOT, 'runtime'), reason: 'бинарники Claude Code и ccr — оставляем чтобы не качать заново' },
];

async function exists(p) { return access(p).then(() => true).catch(() => false); }

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

export async function runReset() {
  // `krasavacode reset --cooldowns` — узкая команда: только cooldowns.json,
  // без подтверждения. Полезно когда провайдер залип после одной 4xx-ошибки.
  if (process.argv.includes('--cooldowns')) {
    const cdPath = join(ROOT, 'cooldowns.json');
    if (await exists(cdPath)) {
      try {
        await rm(cdPath, { force: true });
        console.log('✓ Cooldowns сброшены. Запусти krasavacode заново.');
      } catch (e) {
        console.log(`✗ Не удалось удалить ${cdPath}: ${e.message}`);
      }
    } else {
      console.log('Cooldowns и так нет — провайдеры не блокированы.');
    }
    return;
  }

  console.log('');
  console.log('  KRASAVACODE — сброс всех настроек');
  console.log('');
  console.log('  Будут удалены:');
  for (const t of TARGETS) {
    if (await exists(t.path)) console.log(`    • ${t.label}`);
  }
  console.log('');
  console.log('  Останутся:');
  for (const k of KEEP) {
    if (await exists(k.path)) console.log(`    • ${k.reason}`);
  }
  console.log('  Папка ~/krasavacode-projects/ с твоими проектами не трогается.');
  console.log('');

  const answer = (await prompt('  Точно сбросить? Напиши да: ')).trim().toLowerCase();
  if (answer !== 'да' && answer !== 'yes' && answer !== 'y') {
    console.log('\n  Отмена. Ничего не удалено.');
    return;
  }

  let removed = 0;
  for (const t of TARGETS) {
    if (await exists(t.path)) {
      try {
        await rm(t.path, { recursive: true, force: true });
        console.log(`  ✓ удалено: ${t.label}`);
        removed++;
      } catch (e) {
        console.log(`  ✗ не удалось удалить ${t.label}: ${e.message}`);
      }
    }
  }

  console.log('');
  console.log(`  Готово. Удалено пунктов: ${removed}.`);
  console.log('  Чтобы заново подключить провайдеры — krasavacode setup');
  console.log('');
}
