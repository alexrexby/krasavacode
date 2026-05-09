import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isGeminiConfigured } from './setup-gemini.js';

const CCR_DIR = join(homedir(), '.claude-code-router');
const CCR_CONFIG = join(CCR_DIR, 'config.json');
const STATE_FILE = join(homedir(), '.krasavacode', 'state.json');

const KRASAVACODE_MARKER = 'krasavacode/managed';

function pollinationsProvider() {
  return {
    name: 'pollinations',
    api_base_url: 'https://text.pollinations.ai/openai/chat/completions',
    api_key: 'public',
    models: ['openai', 'openai-fast', 'gpt-oss-20b'],
  };
}

function geminiProvider() {
  return {
    name: 'gemini',
    api_base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',
    api_key: '$GEMINI_API_KEY',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest'],
    transformer: { use: ['gemini'] },
  };
}

function buildConfig({ withGemini }) {
  const Providers = withGemini
    ? [geminiProvider(), pollinationsProvider()]
    : [pollinationsProvider()];

  const Router = withGemini
    ? {
        default: 'gemini,gemini-2.5-flash',
        background: 'gemini,gemini-2.5-flash',
        think: 'gemini,gemini-2.5-pro',
        longContext: 'gemini,gemini-2.5-pro',
        longContextThreshold: 60000,
      }
    : {
        default: 'pollinations,openai',
        background: 'pollinations,openai-fast',
        think: 'pollinations,openai',
        longContext: 'pollinations,openai',
        longContextThreshold: 60000,
      };

  return {
    HOST: '127.0.0.1',
    PORT: 3456,
    LOG: false,
    API_TIMEOUT_MS: 600000,
    Providers,
    Router,
    _krasavacode: KRASAVACODE_MARKER,
  };
}

async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
async function writeState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }
async function exists(p) { return access(p).then(() => true).catch(() => false); }

/**
 * Generates ~/.claude-code-router/config.json:
 *   - If user has run setup-gemini → Gemini first, Pollinations as fallback Provider
 *   - Else → Pollinations only
 *
 * Returns { withGemini: boolean }.
 */
export async function ensurePreset() {
  await mkdir(CCR_DIR, { recursive: true });
  const state = await readState();
  const withGemini = await isGeminiConfigured();
  const config = buildConfig({ withGemini });

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
  }

  await writeFile(CCR_CONFIG, JSON.stringify(config, null, 2));
  return { withGemini };
}

export const CCR_PORT = 3456;
