// Test-only process supervisor: SIGUSR2 stops and respawns the real host with retained storage.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-web-')));
let child: ChildProcess;
let stopping = false;
let restarting = false;
function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'scripts/web-fixture.ts'], {
    env: { ...process.env, CHITTR_FIXTURE_BASE: base },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    if (stopping) {
      rmSync(base, { recursive: true, force: true });
      process.exit(0);
    }
    if (restarting) {
      restarting = false;
      start();
    } else process.exit(code ?? 1);
  });
}
mkdirSync('.local', { recursive: true });
writeFileSync('.local/web-fixture-runner.json', JSON.stringify({ pid: process.pid }));
process.on('SIGUSR2', () => {
  if (!restarting && !stopping) {
    restarting = true;
    child.kill('SIGTERM');
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    stopping = true;
    child.kill('SIGTERM');
  });
start();
