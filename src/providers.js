/**
 * Provider registry: единый источник правды для всех бесплатных провайдеров.
 *
 * Приоритет в chain (по убыванию щедрости free tier):
 *   1. cerebras    — 1M токенов/день, Llama 3.3 70B / Qwen3 235B
 *   2. groq        — 1000 RPD, Kimi K2 / DeepSeek-R1
 *   3. gemini      — 250 RPD, Gemini 2.5 Flash (фолбэк)
 *   4. pollinations — без квоты, gpt-oss-20b (последний резерв)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, access } from 'node:fs/promises';

const ROOT = join(homedir(), '.krasavacode');
export const KEYS_DIR = join(ROOT, 'keys');

// Keys live in ~/.krasavacode/keys/<provider>.env as: PROVIDER_API_KEY=...
const ENV_VAR_NAMES = {
  cerebras: 'CEREBRAS_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  polza: 'POLZA_API_KEY',
};

export const PROVIDERS = {
  cerebras: {
    id: 'cerebras',
    name: 'Cerebras',
    tagline: '14 400 запросов/день + 1M токенов/день, скорость 2600 ток/сек',
    consoleUrl: 'https://cloud.cerebras.ai/?utm_source=krasavacode',
    keyPattern: /^csk-[A-Za-z0-9]{20,}$/,
    keyExample: 'csk-…',
    keyHowto: [
      'Зарегистрируйся (Sign up) — бесплатно, без карты',
      'В дашборде нажми «API Keys» в левом меню',
      'Нажми «Create API Key» → введи любое название',
      'Скопируй ключ (начинается с csk-)',
    ],
    quota: '14 400 запросов/день + 1M токенов/день, 30 запросов/мин',
    bestModel: 'Qwen 3 235B',
    rpd: 14_400,
    tpd: 1_000_000,
    rpm: 30,
    contextLimit: 8_000,
    // Verify via /models — model-name agnostic and gives instant feedback.
    verify: async (key) => {
      try {
        const res = await fetch('https://api.cerebras.ai/v1/models', {
          headers: { 'authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: 'Ключ не принят. Проверь, что скопировал целиком и аккаунт активирован.' };
        }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        const n = data.data?.length || 0;
        return { ok: true, text: `доступно моделей: ${n}` };
      } catch (e) {
        return { ok: false, error: 'Сеть не отвечает: ' + e.message };
      }
    },
    ccrProvider: () => ({
      // Free tier: qwen-3-235b, gpt-oss-120b, llama3.1-8b. Llama 3.3 70B
      // больше не на free (deprecated/убран Cerebras в ~2025).
      name: 'cerebras',
      api_base_url: 'https://api.cerebras.ai/v1/chat/completions',
      api_key: '$CEREBRAS_API_KEY',
      models: ['qwen-3-235b-a22b-instruct-2507', 'gpt-oss-120b', 'llama3.1-8b'],
    }),
    defaultModel: 'qwen-3-235b-a22b-instruct-2507',
  },

  groq: {
    id: 'groq',
    name: 'Groq',
    tagline: '1000 запросов/день, GPT-OSS 120B + DeepSeek-R1',
    consoleUrl: 'https://console.groq.com/keys',
    keyPattern: /^gsk_[A-Za-z0-9]{40,}$/,
    keyExample: 'gsk_…',
    keyHowto: [
      'Войди через Google или GitHub — без карты',
      'Перейди в раздел «API Keys» (страница уже открыта)',
      'Нажми «Create API Key» → введи название',
      'Скопируй ключ (начинается с gsk_)',
    ],
    quota: '~1 000 запросов в день, 30 запросов/мин',
    bestModel: 'GPT-OSS 120B',
    rpd: 1000,
    tpd: null,
    rpm: 30,
    contextLimit: 128_000,
    verify: async (key) => {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: 'Ключ не принят. Проверь, что скопировал целиком.' };
        }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        const n = data.data?.length || 0;
        return { ok: true, text: `доступно моделей: ${n}` };
      } catch (e) {
        return { ok: false, error: 'Сеть не отвечает: ' + e.message };
      }
    },
    ccrProvider: () => ({
      // moonshotai/kimi-k2-instruct deprecated by Groq in 2025-09 →
      // kimi-k2-instruct-0905 deprecated 2026-03 → hosts pushes openai/gpt-oss-120b.
      name: 'groq',
      api_base_url: 'https://api.groq.com/openai/v1/chat/completions',
      api_key: '$GROQ_API_KEY',
      models: [
        'openai/gpt-oss-120b',
        'deepseek-r1-distill-llama-70b',
        'llama-3.3-70b-versatile',
      ],
    }),
    defaultModel: 'openai/gpt-oss-120b',
  },

  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    tagline: '50 запросов/день на 28 free-моделей (Kimi 2.5, DeepSeek V4, Qwen3-235B)',
    consoleUrl: 'https://openrouter.ai/keys',
    keyPattern: /^sk-or-v1-[a-f0-9]{64}$/,
    keyExample: 'sk-or-v1-…',
    keyHowto: [
      'Войди через Google или GitHub — без карты',
      'На странице ключей нажми «Create key» → введи название',
      'Скопируй ключ (начинается с sk-or-v1-)',
    ],
    quota: '~50 запросов/день в сумме на все free-модели, 20 запросов/мин',
    bestModel: 'Kimi K2.5 / DeepSeek V4 (через OpenRouter)',
    rpd: 50,
    tpd: null,
    rpm: 20,
    contextLimit: 200_000,
    verify: async (key) => {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: 'Ключ не принят. Проверь, что скопировал целиком.' };
        }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        const n = data.data?.length || 0;
        return { ok: true, text: `доступно моделей: ${n}` };
      } catch (e) {
        return { ok: false, error: 'Сеть не отвечает: ' + e.message };
      }
    },
    ccrProvider: () => ({
      name: 'openrouter',
      api_base_url: 'https://openrouter.ai/api/v1/chat/completions',
      api_key: '$OPENROUTER_API_KEY',
      // OpenRouter slug-имена меняются каждые 1-2 месяца. Ставим самые
      // долгоживущие — Llama давно стабильно, Qwen тоже без даты в slug.
      models: [
        'meta-llama/llama-3.3-70b-instruct:free',
        'qwen/qwen3-235b-a22b:free',
      ],
      transformer: { use: ['openrouter'] },
    }),
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
  },

  polza: {
    id: 'polza',
    name: 'Polza.ai (рубли)',
    tagline: 'Платный fallback для РФ — 100₽ депозита хватает на тысячи запросов',
    consoleUrl: 'https://polza.ai/dashboard',
    keyPattern: /^pl-[A-Za-z0-9_-]{20,}$|^sk-[A-Za-z0-9_-]{20,}$/,
    keyExample: 'pl-… или sk-…',
    keyHowto: [
      'Зарегистрируйся через email или Google (без VPN из РФ)',
      'Пополни баланс российской картой минимум на 100₽',
      'В дашборде → API Keys → Create',
      'Скопируй ключ',
    ],
    quota: 'Платный (100₽ ≈ 1000+ запросов на дешёвых моделях)',
    bestModel: 'DeepSeek V3 / Qwen Coder (≤2₽ за 1M токенов)',
    rpd: null,
    tpd: null,
    rpm: 60,
    contextLimit: 128_000,
    verify: async (key) => {
      try {
        const res = await fetch('https://polza.ai/api/v1/models', {
          headers: { 'authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: 'Ключ не принят. Проверь, что скопировал целиком и баланс пополнен.' };
        }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        const n = data.data?.length || 0;
        return { ok: true, text: `доступно моделей: ${n}` };
      } catch (e) {
        return { ok: false, error: 'Сеть не отвечает: ' + e.message };
      }
    },
    ccrProvider: () => ({
      name: 'polza',
      api_base_url: 'https://polza.ai/api/v1/chat/completions',
      api_key: '$POLZA_API_KEY',
      // Перечисляем дешёвые но мощные модели для кодинга
      models: [
        'deepseek/deepseek-chat',
        'qwen/qwen-2.5-coder-32b-instruct',
        'meta-llama/llama-3.3-70b-instruct',
        'openai/gpt-4o-mini',
      ],
    }),
    defaultModel: 'deepseek/deepseek-chat',
  },

  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    tagline: '1000 кредитов на старте, топовые coding-модели (Qwen Coder, Llama 70B)',
    consoleUrl: 'https://build.nvidia.com/settings/api-keys',
    keyPattern: /^nvapi-[A-Za-z0-9_-]{40,}$/,
    keyExample: 'nvapi-…',
    keyHowto: [
      'Войди через Google или зарегистрируйся как NVIDIA Developer (бесплатно)',
      'На странице ключей нажми «Generate Key»',
      'Можешь привязать к любому проекту (или создать новый)',
      'Скопируй ключ (начинается с nvapi-)',
    ],
    quota: '~1 000 кредитов на старте, можно запросить до 5 000 (через форму)',
    bestModel: 'Qwen 2.5 Coder 32B / Llama 3.3 70B',
    rpd: null,
    tpd: null,
    rpm: 40,
    contextLimit: 128_000,
    verify: async (key) => {
      try {
        const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
          headers: { 'authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: 'Ключ не принят. Проверь, что скопировал целиком.' };
        }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        const n = data.data?.length || 0;
        return { ok: true, text: `доступно моделей: ${n}` };
      } catch (e) {
        return { ok: false, error: 'Сеть не отвечает: ' + e.message };
      }
    },
    ccrProvider: () => ({
      name: 'nvidia',
      api_base_url: 'https://integrate.api.nvidia.com/v1/chat/completions',
      api_key: '$NVIDIA_API_KEY',
      models: [
        'qwen/qwen2.5-coder-32b-instruct',
        'meta/llama-3.3-70b-instruct',
        'deepseek-ai/deepseek-r1',
      ],
    }),
    defaultModel: 'qwen/qwen2.5-coder-32b-instruct',
  },

  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    tagline: '250–1500 запросов/день (Google рандомизирует), Gemini 2.5 Flash',
    consoleUrl: 'https://aistudio.google.com/apikey',
    keyPattern: /^AIza[A-Za-z0-9_-]{35}$/,
    keyExample: 'AIzaSy…',
    keyHowto: [
      'Войди через свой Google-аккаунт (Gmail/YouTube подойдут)',
      'Нажми «Create API key» наверху страницы',
      'Если попросит выбрать проект — оставь предложенный',
      'Скопируй ключ (начинается с AIza)',
    ],
    quota: '250–1500 запросов в день (зависит от аккаунта), 10 запросов/мин',
    bestModel: 'Gemini 2.5 Flash',
    rpd: 250, // лимит, который мы предполагаем для warning thresholds
    tpd: null,
    rpm: 10,
    contextLimit: 1_000_000,
    verify: async (key) => {
      // Gemini: ListModels проверяет валидность ключа без расхода квоты.
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          let detail = '';
          try { detail = (await res.json())?.error?.message || ''; } catch {}
          return { ok: false, error: detail || 'Ключ не принят. Проверь, что скопировал целиком из AI Studio.' };
        }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        const n = (data.models || []).length;
        return { ok: true, text: `доступно моделей: ${n}` };
      } catch (e) {
        return { ok: false, error: 'Сеть не отвечает: ' + e.message };
      }
    },
    ccrProvider: () => ({
      name: 'gemini',
      api_base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',
      api_key: '$GEMINI_API_KEY',
      models: ['gemini-2.5-flash', 'gemini-flash-latest'],
      transformer: { use: ['gemini'] },
    }),
    defaultModel: 'gemini-2.5-flash',
  },
};

// Цепочка провайдеров. Первый = дефолт, далее fallback при cooldown/ошибках.
// - groq, openrouter, gemini, nvidia — нормальные OpenAI-compatible free tier
// - cerebras в конце т.к. strict-mode 400 на Anthropic payload (cache_control,
//   content-array)
// - polza — платный российский (рубли через карту), работает когда все free
//   квоты исчерпаны. Включается только если ученик подключил его в setup.
export const PROVIDER_PRIORITY = ['groq', 'openrouter', 'gemini', 'nvidia', 'cerebras', 'polza'];

export function pollinationsProvider() {
  return {
    name: 'pollinations',
    api_base_url: 'https://text.pollinations.ai/openai/chat/completions',
    api_key: 'public',
    models: ['openai', 'openai-fast'],
  };
}

function envFile(providerId) {
  return join(KEYS_DIR, `${providerId}.env`);
}

async function exists(p) { return access(p).then(() => true).catch(() => false); }

export async function loadProviderKey(providerId) {
  // New layout: ~/.krasavacode/keys/<id>.env
  const newPath = envFile(providerId);
  // Legacy layout (gemini only): ~/.krasavacode/gemini.env
  const legacyPath = join(ROOT, `${providerId}.env`);

  for (const p of [newPath, legacyPath]) {
    try {
      const content = await readFile(p, 'utf8');
      const varName = ENV_VAR_NAMES[providerId];
      const m = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
      if (m) return m[1].trim();
    } catch {}
  }
  return null;
}

export async function isProviderConfigured(providerId) {
  return (await loadProviderKey(providerId)) != null;
}

/** Returns ids of all configured providers, in priority order. */
export async function configuredProviders() {
  const result = [];
  for (const id of PROVIDER_PRIORITY) {
    if (await isProviderConfigured(id)) result.push(id);
  }
  return result;
}

export function getProviderEnvVarName(providerId) {
  return ENV_VAR_NAMES[providerId];
}

export function providerEnvFile(providerId) {
  return envFile(providerId);
}
