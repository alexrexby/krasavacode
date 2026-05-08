import { spawn } from 'node:child_process';
import { mkdir, access, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { ensureBundledNode, systemNodeMajor } from './node-installer.js';

const ROOT = join(homedir(), '.krasavacode');
const RUNTIME = join(ROOT, 'runtime');
const STATE_FILE = join(ROOT, 'state.json');

const REQUIRED_PACKAGES = [
  '@anthropic-ai/claude-code@latest',
  '@musistudio/claude-code-router@latest',
];

function exists(path) {
  return access(path).then(() => true).catch(() => false);
}

async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

async function writeState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function spawnCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
    let stdout = '', stderr = '';
    if (opts.silent) {
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
    }
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
    });
  });
}

/**
 * Decide which Node/npm to use:
 *   1. System Node ≥ 20 — use system npm (no download).
 *   2. Otherwise — install bundled Node into ~/.krasavacode/runtime/node/ and use it.
 */
async function pickNode() {
  const major = await systemNodeMajor();
  if (major !== null && major >= 20) {
    return { source: 'system', node: 'node', npm: 'npm', binDir: null };
  }
  const bundled = await ensureBundledNode();
  return { source: 'bundled', node: bundled.node, npm: bundled.npm, binDir: bundled.binDir };
}

async function installPackages(npmCmd, env) {
  console.log('📦 Устанавливаю компоненты (один раз)…');
  await mkdir(RUNTIME, { recursive: true });

  const pkgPath = join(RUNTIME, 'package.json');
  if (!(await exists(pkgPath))) {
    await writeFile(pkgPath, JSON.stringify({
      name: 'krasavacode-runtime',
      private: true,
      version: '0.0.0',
      dependencies: {},
    }, null, 2));
  }

  await spawnCmd(npmCmd, [
    'install',
    '--prefix', RUNTIME,
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    ...REQUIRED_PACKAGES,
  ], { env });
}

function binPath(name) {
  const ext = platform() === 'win32' ? '.cmd' : '';
  return join(RUNTIME, 'node_modules', '.bin', name + ext);
}

export async function ensureRuntime() {
  await mkdir(ROOT, { recursive: true });

  const node = await pickNode();

  // Build env that all child processes (npm install, ccr, claude) inherit.
  // For bundled mode, bundled Node must come first in PATH so that
  // shebangs `#!/usr/bin/env node` resolve to our Node.
  const env = { ...process.env };
  if (node.source === 'bundled' && node.binDir) {
    const sep = platform() === 'win32' ? ';' : ':';
    env.PATH = `${node.binDir}${sep}${process.env.PATH || ''}`;
  }

  const state = await readState();
  const ccrBin = binPath('ccr');
  const claudeBin = binPath('claude');

  const haveCcr = await exists(ccrBin);
  const haveClaude = await exists(claudeBin);

  if (!haveCcr || !haveClaude || !state.installedAt) {
    await installPackages(node.npm, env);
    state.installedAt = new Date().toISOString();
    state.nodeSource = node.source;
    await writeState(state);
    console.log('✅ Готово.\n');
  }

  return {
    root: ROOT,
    runtime: RUNTIME,
    ccrBin,
    claudeBin,
    nodeBin: node.node,
    nodeSource: node.source,
    pathPrefix: node.binDir,
    env,
    state,
    saveState: writeState,
  };
}
