/**
 * Provider registry: единый источник правды для всех провайдеров.
 *
 * v0.5.37: оставлены только два — реалистичные для нашей аудитории (РФ/BY).
 *   1. openrouter — free tier 50 RPD на десятки моделей (с VPN из РФ)
 *   2. polza      — платный российский, рубли через карту РФ, без VPN
 *
 * Cerebras, Groq, Gemini, NVIDIA удалены — все блокируют РФ/BY.
 * Pollinations удалён — слабая модель плохо вызывает tool_use, в результате
 *   ученик получает текст вместо файлов проекта.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, access } from 'node:fs/promises';

const ROOT = join(homedir(), '.krasavacode');
export const KEYS_DIR = join(ROOT, 'keys');

// Keys live in ~/.krasavacode/keys/<provider>.env as: PROVIDER_API_KEY=...
const ENV_VAR_NAMES = {
  openrouter: 'OPENROUTER_API_KEY',
  polza: 'POLZA_API_KEY',
};

export const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    tagline: '50 запросов/день на 28 free-моделей (Kimi 2.5, DeepSeek V4, Qwen3-235B)',
    geoNote: 'Из РФ/Беларуси нужен VPN — OpenRouter может блокировать по IP',
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
          return { ok: false, error: 'Ключ не принят. Проверь, что скопировал целиком. Если ты в РФ — возможно нужен VPN.' };
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
    tagline: 'Платный российский — 100₽ депозита хватает на тысячи запросов',
    worksInRu: true, // Polza — российский провайдер
    geoNote: '✓ Российский сервис, оплата картой РФ, без VPN',
    consoleUrl: 'https://polza.ai/?referral=ghUJMigzbh',
    // Polza часто меняет формат ключей (pza_*, pl-*, sk-*, иногда без префикса).
    // Не блокируем по regex — пускаем на verify, который скажет точно.
    // Требуем только: не пустая строка длиной ≥ 16 без пробелов.
    keyPattern: /^[A-Za-z0-9._-]{16,}$/,
    keyExample: 'pza_… или pl-…',
    keyHowto: [
      'Зарегистрируйся через email или Google (без VPN из РФ)',
      'Пополни баланс российской картой минимум на 100₽',
      'В дашборде → API Keys → Create',
      'Скопируй ключ',
    ],
    quota: 'Платный (100₽ ≈ 1000+ запросов на дешёвых моделях)',
    bestModel: 'GLM 4.7 Flash (стабильный tool use, 200k ctx)',
    rpd: null,
    tpd: null,
    rpm: 60,
    contextLimit: 128_000,
    verify: async (key) => {
      // /api/v1/models — публичный endpoint (200 даже без ключа), не годится
      // для проверки валидности. /api/v1/balance — auth-required, маленький
      // ответ, и заодно показывает остаток на счёте ученику.
      try {
        const res = await fetch('https://polza.ai/api/v1/balance', {
          headers: { 'authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(20000),
        });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: 'Ключ не принят. Скопируй целиком и убедись, что баланс пополнен.' };
        }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        // Try to read balance to display, but don't fail if format unexpected
        let display = 'ключ принят';
        try {
          const data = await res.json();
          // Polza /balance returns: {amount, reservedAmount, spentAmount, updatedAt}
          const bal = data.amount ?? data.balance ?? data.data?.balance;
          if (bal != null) {
            const num = Number(bal);
            display = Number.isFinite(num) ? `баланс: ${num.toFixed(2)}₽` : `баланс: ${bal}`;
          }
        } catch {}
        return { ok: true, text: display };
      } catch (e) {
        return { ok: false, error: 'Сеть не отвечает: ' + e.message };
      }
    },
    ccrProvider: () => ({
      name: 'polza',
      api_base_url: 'https://polza.ai/api/v1/chat/completions',
      api_key: '$POLZA_API_KEY',
      // Цены (input prompt) проверены через API каталог Polza май 2026.
      // ВАЖНО: Claude Code требует tool use на КАЖДОМ запросе. Reasoning-only
      // модели (DeepSeek R1 distill и т.п.) сюда добавлять НЕЛЬЗЯ — Polza
      // ответит 400 "No endpoints found that support tool use".
      //
      //   z-ai/glm-4.7-flash                      6.34₽/1M  ctx=200k  ✓ tools  (default)
      //   deepseek/deepseek-v4-flash             12.85₽/1M  ctx=1M    ✓ tools  (fallback)
      //   qwen/qwen3.5-flash-02-23                5.88₽/1M  ctx=1M    ✓ tools  (cheap fallback)
      //
      // GLM 4.7 Flash дефолтом: проверено 2026-05-13 живым shootout'ом — это
      // единственная модель из доступных на Polza, которая:
      //   (а) выдаёт обязательную преамбулу 🔧 перед tool_use,
      //   (б) корректно ЗАВЕРШАЕТ turn блоком «▶ Как посмотреть результат»
      //       после tool_result (Qwen/V4 Flash зацикливаются на следующих
      //       Write'ах вместо stop'а — Claude Code висит),
      //   (в) не галлюцинирует tool-server ошибки типа «Dependencies not
      //       installed for server bash» / «Pausing - waiting for bash server»
      //       (DeepSeek V4 Flash на Polza воспроизводимо генерит это в текст).
      // DeepSeek V4 Pro исключён: возвращает большие JSON-ответы с
      // незакрытыми строками (parse error на клиенте).
      // qwen/qwen-2.5-coder-32b-instruct исключён: на Polza endpoint этой
      // модели не поддерживает tool use (400 «No endpoints found that
      // support tool use»).
      models: [
        'z-ai/glm-4.7-flash',
        'deepseek/deepseek-v4-flash',
        'qwen/qwen3.5-flash-02-23',
      ],
    }),
    defaultModel: 'z-ai/glm-4.7-flash',
  },
};

// Цепочка провайдеров. Первый = дефолт, далее fallback при cooldown/ошибках.
// OpenRouter сначала (бесплатный), Polza second (платный backup).
export const PROVIDER_PRIORITY = ['openrouter', 'polza'];

function envFile(providerId) {
  return join(KEYS_DIR, `${providerId}.env`);
}

async function exists(p) { return access(p).then(() => true).catch(() => false); }

export async function loadProviderKey(providerId) {
  const filePath = envFile(providerId);
  try {
    const content = await readFile(filePath, 'utf8');
    const varName = ENV_VAR_NAMES[providerId];
    const m = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    if (m) return m[1].trim();
  } catch {}
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

/** All routable models for a provider, default first. */
export function getProviderModels(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return [];
  const cfg = p.ccrProvider();
  const list = cfg.models?.length ? [...cfg.models] : [p.defaultModel];
  const dflt = p.defaultModel;
  return [dflt, ...list.filter(m => m !== dflt)];
}

export function providerEnvFile(providerId) {
  return envFile(providerId);
}
