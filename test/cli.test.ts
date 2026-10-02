import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it.each(['missing', 'directory', 'oversized'])(
  'rejects a %s launch file before setup, locking or participant startup',
  (kind) => {
    const workspace = mkdtempSync(join(tmpdir(), 'chittr-cli-brief-'));
    const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const file = join(workspace, 'brief.md');
    const state = join(workspace, 'state');
    try {
      if (kind === 'directory') mkdirSync(file);
      if (kind === 'oversized') writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
      const result = spawnSync(
        process.execPath,
        [entry, '--web', '--state-dir', state, '--instructions-file', file],
        {
          cwd: workspace,
          env: { HOME: workspace, PATH: '' },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/ENOENT|EISDIR|exceeds 1 MiB/);
      expect(result.stdout).toBe('');
      expect(existsSync(state)).toBe(false);
      expect(existsSync(join(workspace, '.agents'))).toBe(false);
      for (const flag of ['--help', '--version']) {
        const info = spawnSync(process.execPath, [entry, flag, '--instructions-file', file], {
          cwd: workspace,
          env: { HOME: workspace, PATH: '' },
          encoding: 'utf8',
          timeout: 5000,
        });
        expect(info.status).toBe(0);
        expect(info.stderr).toBe('');
      }
      expect(existsSync(state)).toBe(false);
      expect(existsSync(join(workspace, '.agents'))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

it('reports the package version and Chittr help from a different launch directory', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'chittr-cli-identity-'));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  try {
    const version = spawnSync(process.execPath, [entry, '--version'], {
      cwd: workspace,
      env: { HOME: workspace },
      encoding: 'utf8',
    });
    expect(version.status).toBe(0);
    expect(version.stderr).toBe('');
    expect(version.stdout).toBe(`${manifest.version}\n`);
    const help = spawnSync(process.execPath, [entry, '--help'], {
      cwd: workspace,
      env: { HOME: workspace },
      encoding: 'utf8',
    });
    expect(help.status).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout.startsWith(`Chittr ${manifest.version}:`)).toBe(true);
    expect(help.stdout).toContain('Usage: chittr');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

it.each(['detected', 'configured'])('doctor checks only launch providers when %s', (mode) => {
  const workspace = mkdtempSync(join(tmpdir(), 'chittr-doctor-providers-'));
  const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const bin = join(workspace, 'bin');
  const home = join(workspace, 'home');
  const calls = join(workspace, 'calls.jsonl');
  try {
    mkdirSync(bin);
    mkdirSync(home);
    writeFileSync(calls, '');
    for (const command of ['codex', 'claude', 'grok', 'agy']) {
      writeFileSync(
        join(bin, command),
        `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command: ${JSON.stringify(command)}, args: process.argv.slice(2) }) + '\\n');
if (process.argv[2] === '--version') {
  console.log('fixture 1.0.0');
} else {
  process.exitCode = 1;
}
`,
        { mode: 0o755 },
      );
    }
    if (mode === 'configured') {
      mkdirSync(join(workspace, '.agents'));
      writeFileSync(
        join(workspace, '.agents/chittr.yaml'),
        JSON.stringify({
          version: 1,
          agents: Object.fromEntries(
            ['codex', 'claude', 'grok', 'antigravity'].map((provider) => [
              `agent-${provider}`,
              { provider },
            ]),
          ),
        }),
      );
    }
    const result = spawnSync(process.execPath, [entry, 'doctor', '--json'], {
      cwd: workspace,
      env: { HOME: home, PATH: bin, TMPDIR: workspace },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1); // Fake CLIs cannot pass a provider handshake.
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report.agents.map((agent: { provider: string }) => agent.provider).sort()).toEqual([
      'claude',
      'codex',
      'grok',
    ]);
    const invocations = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.some((call) => call.command === 'agy')).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
