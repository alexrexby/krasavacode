#!/usr/bin/env node
import { ensureRuntime } from '../src/runtime.js';
import { startHub, stopHub } from '../src/hub.js';
import { ensurePreset } from '../src/preset.js';

const t0 = Date.now();

const paths = await ensureRuntime();
console.log(`⏱  ensureRuntime: ${(Date.now() - t0) / 1000}s`);

const t1 = Date.now();
await ensurePreset();
console.log(`⏱  ensurePreset (config.json written): ${(Date.now() - t1) / 1000}s`);

const t2 = Date.now();
const hub = await startHub(paths);
console.log(`⏱  startHub: ${(Date.now() - t2) / 1000}s — ${hub.baseUrl}`);

console.log('\n=== /v1/messages probe (claude-sonnet-4-5 → Pollinations) ===');
try {
  const r = await fetch(`${hub.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'sk-krasavacode-local',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    }),
    signal: AbortSignal.timeout(40000),
  });
  console.log(`status: ${r.status}`);
  const txt = await r.text();
  console.log(txt.slice(0, 1500));
} catch (e) { console.log('error:', e.message); }

console.log(`\n⏱  total: ${(Date.now() - t0) / 1000}s`);

await stopHub(hub);
process.exit(0);
