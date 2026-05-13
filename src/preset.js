import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS, configuredProviders } from './providers.js';

const ROOT = join(homedir(), '.krasavacode');
const CCR_DIR = join(homedir(), '.claude-code-router');
const CCR_CONFIG = join(CCR_DIR, 'config.json');
const STATE_FILE = join(ROOT, 'state.json');

const KRASAVACODE_MARKER = 'krasavacode/managed';

async function readState() { try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return {}; } }
async function writeState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }
async function exists(p) { return access(p).then(() => true).catch(() => false); }

async function buildConfig() {
  const configured = await configuredProviders();
  const providers = configured.map(id => PROVIDERS[id].ccrProvider());

  // Если ничего не подключено — оставим первый из PROVIDER_PRIORITY с пустым
  // ключом. CCR всё равно стартанёт, а ученик пройдёт через wizard.
  const firstId = configured[0] || 'openrouter';
  const firstModel = configured[0]
    ? PROVIDERS[firstId].defaultModel
    : PROVIDERS.openrouter.defaultModel;
  const firstProv = firstId;

  const config = {
    HOST: '127.0.0.1',
    PORT: 3456,
    LOG: false,
    API_TIMEOUT_MS: 600000,
    Providers: providers,
    Router: {
      // Static fallback if custom-router returns null
      default:     `${firstProv},${firstModel}`,
      background:  `${firstProv},${firstModel}`,
      think:       `${firstProv},${firstModel}`,
      longContext: `${firstProv},${firstModel}`,
      longContextThreshold: 60000,
    },
    _krasavacode: KRASAVACODE_MARKER,
  };

  // No custom router: provider selection is done at the metrics-proxy layer,
  // which rewrites body.model = "provider,name" so ccr forwards directly.
  return config;
}

/**
 * Generates ~/.claude-code-router/config.json AND the custom router file
 * ~/.krasavacode/router.js. Backs up any pre-existing user config that
 * isn't ours.
 */
export async function ensurePreset() {
  await mkdir(ROOT, { recursive: true });
  await mkdir(CCR_DIR, { recursive: true });

  const state = await readState();
  const config = await buildConfig();

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
      console.log(`💾 Найден свой config.json у claude-code-router — резервная копия: ${backupPath}`);
    }
  }

  await writeFile(CCR_CONFIG, JSON.stringify(config, null, 2));
  return { configured: await configuredProviders() };
}

export const CCR_PORT = 3456;
