import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CCR_DIR = join(homedir(), '.claude-code-router');
const CCR_CONFIG = join(CCR_DIR, 'config.json');
const STATE_FILE = join(homedir(), '.krasavacode', 'state.json');

const KRASAVACODE_MARKER = 'krasavacode/managed';

const FREE_CONFIG = {
  HOST: '127.0.0.1',
  PORT: 3456,
  LOG: false,
  API_TIMEOUT_MS: 600000,
  Providers: [
    {
      name: 'pollinations',
      api_base_url: 'https://text.pollinations.ai/openai/chat/completions',
      api_key: 'public',
      models: ['openai', 'openai-fast', 'gpt-oss-20b'],
    },
  ],
  Router: {
    default: 'pollinations,openai',
    background: 'pollinations,openai-fast',
    think: 'pollinations,openai',
    longContext: 'pollinations,openai',
    longContextThreshold: 60000,
  },
  // Marker so future runs know this config is ours and we may overwrite it.
  // If a user has manually edited config (no marker), we leave it alone.
  _krasavacode: KRASAVACODE_MARKER,
};

async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
async function writeState(s) {
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

async function exists(p) {
  return access(p).then(() => true).catch(() => false);
}

/**
 * Writes a default claude-code-router config pointing at Pollinations
 * (free, no-API-key). Backs up any existing user config before overwriting.
 *
 * Returns { mode: 'anthropic-direct' } so launch.js stays generic.
 */
export async function ensurePreset(/* hub unused in CCR mode */) {
  await mkdir(CCR_DIR, { recursive: true });
  const state = await readState();

  if (await exists(CCR_CONFIG)) {
    let existing;
    try { existing = JSON.parse(await readFile(CCR_CONFIG, 'utf8')); }
    catch { existing = null; }

    const isOurs = existing?._krasavacode === KRASAVACODE_MARKER;

    if (!isOurs && !state.userConfigBackedUp) {
      const backupPath = `${CCR_CONFIG}.backup-${Date.now()}`;
      await copyFile(CCR_CONFIG, backupPath);
      state.userConfigBackedUp = backupPath;
      await writeState(state);
      console.log(`💾 Найден свой config.json у claude-code-router — сохранил резервную копию: ${backupPath}`);
    }

    if (isOurs) {
      // Already managed by us; rewrite each time so updates roll out.
      await writeFile(CCR_CONFIG, JSON.stringify(FREE_CONFIG, null, 2));
      return { mode: 'anthropic-direct' };
    }
  }

  await writeFile(CCR_CONFIG, JSON.stringify(FREE_CONFIG, null, 2));
  return { mode: 'anthropic-direct' };
}

export const CCR_PORT = FREE_CONFIG.PORT;
