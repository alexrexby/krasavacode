import { spawn } from 'node:child_process';
import { homedir, platform, arch, totalmem } from 'node:os';
import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import net from 'node:net';

const ROOT = join(homedir(), '.krasavacode');

function spawnCmd(cmd, args) {
  return new Promise(resolve => {
    const c = spawn(cmd, args, { stdio: 'pipe' });
    let out = '';
    c.stdout.on('data', d => out += d);
    c.stderr.on('data', d => out += d);
    c.on('error', () => resolve({ ok: false, out: 'not found' }));
    c.on('exit', code => resolve({ ok: code === 0, out: out.trim() }));
  });
}

async function checkPort(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function checkNetwork(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok || (res.status >= 200 && res.status < 500);
  } catch { return false; }
}

const check = (label, ok, detail) =>
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);

export async function runDoctor() {
  console.log('🩺 KRASAVACODE doctor\n');

  console.log('Система:');
  console.log(`  ${platform()}/${arch()}  RAM ${(totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`);
  console.log(`  Node ${process.version}\n`);

  console.log('Бинарники:');
  const npm = await spawnCmd('npm', ['--version']);
  check('npm', npm.ok, npm.out);

  const ext = platform() === 'win32' ? '.cmd' : '';
  const claudeBin = join(ROOT, 'runtime', 'node_modules', '.bin', 'claude' + ext);
  const ccrBin = join(ROOT, 'runtime', 'node_modules', '.bin', 'ccr' + ext);
  const haveClaude = await access(claudeBin).then(() => true).catch(() => false);
  const haveCcr = await access(ccrBin).then(() => true).catch(() => false);
  check('claude (runtime)', haveClaude, haveClaude ? claudeBin : 'не установлен — будет поставлен при `krasavacode`');
  check('ccr / claude-code-router (runtime)', haveCcr, haveCcr ? ccrBin : 'не установлен — будет поставлен при `krasavacode`');

  console.log('\nСеть:');
  check('npm registry', await checkNetwork('https://registry.npmjs.org/'));
  check('Pollinations', await checkNetwork('https://text.pollinations.ai/openai/chat/completions'));

  console.log('\nПорты:');
  check('3456 (claude-code-router)', await checkPort(3456), 'свободен или используется ccr');
  check('20128 (omniroute upgrade)', await checkPort(20128));

  console.log('\nState:');
  try {
    const state = JSON.parse(await readFile(join(ROOT, 'state.json'), 'utf8'));
    console.log(JSON.stringify(state, null, 2).split('\n').map(l => '  ' + l).join('\n'));
  } catch {
    console.log('  пусто (запусти `krasavacode` хотя бы раз)');
  }

  console.log('');
}
