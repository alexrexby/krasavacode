import { spawn } from 'node:child_process';
import { mkdir, writeFile, access, chmod } from 'node:fs/promises';
import { homedir, platform, arch, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const NODE_VERSION = '22.11.0'; // pinned LTS — bumped only when we test it
const ROOT = join(homedir(), '.krasavacode');
const NODE_DIR = join(ROOT, 'runtime', 'node');

function exists(p) { return access(p).then(() => true).catch(() => false); }

function spawnP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: 'pipe', ...opts });
    let stderr = '';
    c.stderr?.on('data', d => stderr += d);
    c.on('error', reject);
    c.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr}`)));
  });
}

/**
 * Returns descriptors for the Node distribution we should fetch.
 *   { url, archive, binDir, ext }
 */
function pickDistribution() {
  const p = platform();
  const a = arch();

  let nodePlatform, nodeArch, ext;
  if (p === 'darwin') {
    nodePlatform = 'darwin';
    nodeArch = a === 'arm64' ? 'arm64' : 'x64';
    ext = 'tar.gz';
  } else if (p === 'linux') {
    nodePlatform = 'linux';
    nodeArch = a === 'arm64' ? 'arm64' : 'x64';
    ext = 'tar.xz';
  } else if (p === 'win32') {
    nodePlatform = 'win';
    nodeArch = 'x64';
    ext = 'zip';
  } else {
    throw new Error(`Неподдерживаемая платформа: ${p}/${a}`);
  }

  const archive = `node-v${NODE_VERSION}-${nodePlatform}-${nodeArch}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archive}.${ext}`;
  return { url, archive, ext };
}

function bundledPaths() {
  const p = platform();
  if (p === 'win32') {
    return {
      node: join(NODE_DIR, 'node.exe'),
      npm: join(NODE_DIR, 'npm.cmd'),
      binDir: NODE_DIR,
    };
  }
  return {
    node: join(NODE_DIR, 'bin', 'node'),
    npm: join(NODE_DIR, 'bin', 'npm'),
    binDir: join(NODE_DIR, 'bin'),
  };
}

async function downloadFile(url, dest) {
  process.stdout.write(`📥 Тяну Node.js v${NODE_VERSION} (≈30 МБ, один раз)… `);
  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} от ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(`OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

async function extractArchive(archivePath, ext, destDir) {
  process.stdout.write('📂 Распаковываю… ');
  await mkdir(destDir, { recursive: true });

  if (ext === 'zip') {
    // Windows 10+ has tar.exe with zip support; fall back to PowerShell.
    try {
      await spawnP('tar', ['-xf', archivePath, '-C', destDir]);
    } catch {
      await spawnP('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`]);
    }
  } else if (ext === 'tar.gz') {
    await spawnP('tar', ['-xzf', archivePath, '-C', destDir]);
  } else if (ext === 'tar.xz') {
    // System tar usually has xz support; if not, this throws and we surface it.
    await spawnP('tar', ['-xJf', archivePath, '-C', destDir]);
  }
  console.log('OK');
}

/**
 * The archive extracts to a directory like `node-v22.11.0-darwin-arm64/`.
 * We want everything in NODE_DIR directly. Move contents up.
 */
async function flatten(parentDir, archiveName) {
  const { rename, readdir, rm } = await import('node:fs/promises');
  const inner = join(parentDir, archiveName);
  if (!(await exists(inner))) return; // already flat
  const entries = await readdir(inner);
  for (const e of entries) {
    await rename(join(inner, e), join(parentDir, e));
  }
  await rm(inner, { recursive: true, force: true });
}

/**
 * Install bundled Node into ~/.krasavacode/runtime/node/ if not already.
 * Returns absolute paths to node and npm binaries.
 */
export async function ensureBundledNode() {
  const paths = bundledPaths();

  if (await exists(paths.node)) return paths;

  const { url, archive, ext } = pickDistribution();
  const archivePath = join(tmpdir(), `${archive}.${ext}`);

  await downloadFile(url, archivePath);
  await extractArchive(archivePath, ext, NODE_DIR);
  await flatten(NODE_DIR, archive);

  // Make sure binaries are executable on POSIX
  if (platform() !== 'win32') {
    try {
      await chmod(paths.node, 0o755);
      await chmod(paths.npm, 0o755);
    } catch {}
  }

  return paths;
}

/**
 * Ask system Node for its version. Returns major version (number) or null.
 */
export async function systemNodeMajor() {
  return new Promise(resolve => {
    const c = spawn('node', ['--version'], { stdio: 'pipe' });
    let out = '';
    c.stdout.on('data', d => out += d);
    c.on('error', () => resolve(null));
    c.on('exit', code => {
      if (code !== 0) return resolve(null);
      const m = out.trim().match(/^v(\d+)/);
      resolve(m ? Number(m[1]) : null);
    });
  });
}
