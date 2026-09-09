// Fork-only acceptance evidence. Does not change the upstream recipe or gates.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const windows = process.platform === 'win32';
const xlingsHome = process.env.XLINGS_HOME;
const dshHome = process.env.DSH_HOME;
const runnerTemp = process.env.RUNNER_TEMP;
assert.ok(xlingsHome && dshHome && runnerTemp);
for (const target of [xlingsHome, dshHome]) {
  const relative = path.relative(runnerTemp, target);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
assert.ok(!fs.existsSync(dshHome), 'Acceptance needs a fresh temporary DSH_HOME');
const env = { ...process.env, PATH: [path.join(xlingsHome, 'subos', 'default', 'bin'),
  path.join(xlingsHome, 'bin'), process.env.PATH].join(path.delimiter) };
const binary = path.join(xlingsHome, 'bin', windows ? 'xlings.exe' : 'xlings');
const redact = value => String(value).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]');
function run(command, args, { quiet = false, timeout = 900_000 } = {}) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout,
    shell: windows && !path.isAbsolute(command), maxBuffer: 16 * 1024 * 1024 });
  const output = redact((result.stdout || '') + (result.stderr || ''));
  if (!quiet || result.status !== 0) process.stdout.write(output);
  assert.equal(result.status, 0, `${command} failed: ${result.error || result.status}`);
  return result.stdout;
}
let child;
async function stop() {
  if (!child) return;
  const pid = child.pid;
  if (windows) {
    const killed = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
    assert.equal(killed.status, 0, redact(killed.stderr || killed.stdout));
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (child.exitCode === null) await new Promise(resolve => {
    const timer = setTimeout(() => {
      if (!windows) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
      resolve();
    }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  child = null;
  console.log('Owned web process tree stopped.');
}
let installed = false;
try {
  run(binary, ['--version']);
  run(binary, ['update']);
  run(binary, ['config', '--add-xpkg', 'pkgs/d/dsh.lua']);
  run(binary, ['install', 'local:dsh@0.1.2-rc.1', '-y']);
  installed = true;
  assert.match(run('dsh', ['--version']), /0\.1\.2-rc\.1/);
  run('node', ['--version']);
  run('npm', ['--version']);
  run('pnpm', ['--version']);
  const payload = path.join(xlingsHome, 'data', 'xpkgs', 'local-x-dsh', '0.1.2-rc.1');
  const host = JSON.parse(fs.readFileSync(path.join(payload, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
  assert.equal(host.version, '0.1.2-rc.1');
  const nativePath = path.join(payload, 'node_modules', 'node-pty');
  createRequire(import.meta.url)(nativePath);
  console.log('Native node-pty load passed in the acceptance runner. The shim boot below uses the recipe-bound Node.');
  assert.match(run('dsh', ['--profile', 'web', '--dump-config'], { quiet: true }), /@deepseek-ai\/dsh-base/);
  fs.mkdirSync(dshHome, { recursive: true });
  const sentinel = path.join(dshHome, 'user-data-sentinel.txt');
  fs.writeFileSync(sentinel, 'preserve temporary user data\n');
  child = spawn('dsh', ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env, shell: windows, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const launch = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Web readiness timeout: ${redact(output)}`)), 60_000);
    const capture = chunk => {
      output = (output + chunk.toString()).slice(-100_000);
      const match = output.replace(/\u001b\[[0-9;]*m/g, '').match(/dsh web: (http:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(new URL(match[1])); }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Web exited ${code}: ${redact(output)}`)); });
  });
  assert.equal(launch.hostname, '127.0.0.1');
  const endpoint = new URL('/', launch);
  assert.equal((await fetch(endpoint, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })).status, 401);
  const exchange = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  assert.equal(exchange.status, 303);
  assert.equal(exchange.headers.get('location'), '/');
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  assert.ok(cookie);
  const page = await fetch(endpoint, { redirect: 'manual', headers: { cookie }, signal: AbortSignal.timeout(10_000) });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /__DSH_BOOT__/);
  console.log('Authenticated Web passed: 401 -> 303 signed cookie -> 200 HTML.');
  await stop();
  await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(1000) }));
  run(binary, ['remove', 'local:dsh@0.1.2-rc.1', '-y']);
  installed = false;
  assert.ok(!fs.existsSync(path.join(payload, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve temporary user data\n');
  console.log('Host payload removed; temporary user data preserved; web port closed.');
  console.log('No model task, Movein composition, or Blue/Minimal TUI acceptance is claimed.');
} finally {
  await stop();
  if (installed) run(binary, ['remove', 'local:dsh@0.1.2-rc.1', '-y']);
}
