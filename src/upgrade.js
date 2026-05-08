import { spawn } from 'node:child_process';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.krasavacode');
const RUNTIME = join(ROOT, 'runtime');

function binPath(name) {
  const ext = platform() === 'win32' ? '.cmd' : '';
  return join(RUNTIME, 'node_modules', '.bin', name + ext);
}

function exists(p) { return access(p).then(() => true).catch(() => false); }

function spawnP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: 'inherit', ...opts });
    c.on('error', reject);
    c.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

function openBrowser(url) {
  const cmd = platform() === 'darwin' ? 'open'
    : platform() === 'win32' ? 'start'
    : 'xdg-open';
  const args = platform() === 'win32' ? ['', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore', shell: platform() === 'win32' }).unref();
}

export async function runUpgrade() {
  console.log('🔧 KRASAVACODE upgrade');
  console.log('   Pollinations покрывает первые шаги, но для серьёзных проектов');
  console.log('   стоит подключить более мощные модели бесплатно через OmniRoute:');
  console.log('   • Kiro AI — Claude Sonnet/Haiku через AWS Builder ID');
  console.log('   • Qoder — Kimi K2 / Qwen3-Coder / DeepSeek-R1');
  console.log('   • Qwen Code — 4 модели Alibaba');
  console.log('   • LongCat — 50M токенов в день\n');

  const omniBin = binPath('omniroute');
  if (!(await exists(omniBin))) {
    console.log('📦 Ставлю omniroute (один раз)…');
    await mkdir(RUNTIME, { recursive: true });
    const pkgPath = join(RUNTIME, 'package.json');
    if (!(await exists(pkgPath))) {
      await writeFile(pkgPath, JSON.stringify({ name: 'krasavacode-runtime', private: true, version: '0.0.0' }, null, 2));
    }
    await spawnP('npm', ['install', '--prefix', RUNTIME, '--no-audit', '--no-fund', 'omniroute@latest']);
    console.log('✅ Готово.\n');
  }

  console.log('🌐 Открываю дашборд OmniRoute в браузере: http://localhost:20128');
  console.log('   В дашборде: Providers → Add → выбирай Kiro / Qoder / Pollinations.');
  console.log('   После настройки нажми Ctrl+C тут, потом обычная команда `krasavacode`.\n');

  setTimeout(() => openBrowser('http://localhost:20128'), 3000);

  process.on('SIGINT', () => process.exit(0));

  await spawnP(omniBin, ['--no-open'], {
    env: { ...process.env, REQUIRE_API_KEY: 'false', DATA_DIR: ROOT },
  });
}
