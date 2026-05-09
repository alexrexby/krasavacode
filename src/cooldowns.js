/**
 * Per-provider cooldown tracking.
 *
 * When a provider returns 429, metrics-proxy stamps a cooldown until X.
 * - per-minute rate limit (RPM): 60 sec cooldown
 * - per-day quota (RPD/TPD):     until 11:00 МСК next day (~daily reset)
 *
 * The custom router (~/.krasavacode/router.js) reads this file on every
 * request and skips providers whose cooldown is still in the future.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.krasavacode');
const COOLDOWN_FILE = join(ROOT, 'cooldowns.json');

export async function getCooldowns() {
  try { return JSON.parse(await readFile(COOLDOWN_FILE, 'utf8')); }
  catch { return {}; }
}

export async function setCooldown(providerId, until) {
  await mkdir(ROOT, { recursive: true });
  const cd = await getCooldowns();
  cd[providerId] = until.toISOString();
  cd._lastUpdated = new Date().toISOString();
  await writeFile(COOLDOWN_FILE, JSON.stringify(cd, null, 2));
}

export async function clearCooldown(providerId) {
  const cd = await getCooldowns();
  delete cd[providerId];
  await writeFile(COOLDOWN_FILE, JSON.stringify(cd, null, 2));
}

export async function isOnCooldown(providerId) {
  const cd = await getCooldowns();
  if (!cd[providerId]) return false;
  return new Date(cd[providerId]).getTime() > Date.now();
}

/** Compute when to lift cooldown based on the 429 reason. */
export function cooldownUntil(reason) {
  if (reason === 'per-minute') {
    return new Date(Date.now() + 60_000);
  }
  // per-day or unknown — until 11:00 MSK tomorrow (≈ midnight Pacific reset)
  const next = new Date();
  next.setUTCHours(8, 0, 0, 0); // 11:00 MSK == 08:00 UTC
  if (next.getTime() < Date.now()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
