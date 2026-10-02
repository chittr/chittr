import { afterEach, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { installWithNpm } from '../src/update.js';
import { updateFixture } from './update-fixture.js';

const fixtures: ReturnType<typeof updateFixture>[] = [];
function fixture(options: Record<string, unknown> = {}) {
  const f = updateFixture(options);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) rmSync(f.dir, { recursive: true, force: true });
});

function failed(result: ReturnType<ReturnType<typeof updateFixture>['run']>) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('Updated Chittr');
  expect(result.stderr).toContain('#reinstall-or-uninstall');
  expect(result.stderr).toContain('#back-up-and-restore');
}
function noInstall(f: ReturnType<typeof updateFixture>) {
  expect(f.calls().some((call) => call.args[0] === 'install')).toBe(false);
}

it('pins latest with one executable/cwd/environment/global context, supporting spaces and bin symlinks', () => {
  const f = fixture({ moveTag: true });
  symlinkSync(f.entry, join(f.bin, 'chittr'));
  // Run the normal executable symlink, with a conflicting project .npmrc present.
  const result = f.run([], join(f.bin, 'chittr'));
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`Updating Chittr 1.0.0 to 1.1.0 at ${f.root}`);
  expect(result.stdout).toContain('Close all other Chittr rooms');
  expect(result.stdout).toContain('complete backup');
  expect(result.stdout).toContain(
    'https://github.com/chittr/chittr/blob/main/docs/installation.md#back-up-and-restore',
  );
  expect(result.stdout).toContain('Updated Chittr to 1.1.0. Launch Chittr again');
  expect(JSON.parse(readFileSync(f.manifest, 'utf8')).version).toBe('1.1.0');
  expect(f.calls().map((call) => call.args)).toEqual([
    ['root', '--global'],
    ['view', '@chittr/cli@latest', 'version', 'engines', '--json', '--global'],
    ['install', '--global', '@chittr/cli@1.1.0'],
  ]);
  for (const call of f.calls())
    expect(call).toMatchObject({ executable: f.npm, cwd: f.workspace, context: 'preserved' });
});

it.each([
  ['equal', '1.0.0', '1.0.0', 'Chittr 1.0.0 is already current.'],
  [
    'newer running',
    '2.0.0',
    '1.9.9',
    'Chittr 2.0.0 is newer than npm latest 1.9.9. Nothing changed.',
  ],
  ['prerelease below stable', '1.1.0-beta.9', '1.1.0', 'Updated Chittr to 1.1.0.'],
  ['numeric prerelease', '1.1.0-beta.9', '1.1.0-beta.10', 'Updated Chittr to 1.1.0-beta.10.'],
  ['build metadata', '1.0.0+local', '1.0.0+registry', 'already current'],
])('compares %s with SemVer', (_, running, target, output) => {
  const f = fixture({ metadata: { version: target } });
  writeFileSync(
    f.manifest,
    JSON.stringify({ name: '@chittr/cli', version: running, type: 'module' }),
  );
  const result = f.run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(output);
  if (!output.startsWith('Updated')) {
    noInstall(f);
    expect(result.stdout).not.toContain('Close all other');
    expect(result.stdout).not.toContain('Updating Chittr');
  }
});

it.each([
  'missing npm',
  'linked package',
  'other prefix',
  'source',
  'local',
  'npx',
  'name',
  'version',
  'missing destination',
])('rejects %s before installation', (kind) => {
  const f = fixture();
  let launchEntry = f.entry;
  if (kind === 'missing npm') rmSync(f.npm);
  if (kind === 'linked package') {
    const linked = join(f.dir, 'linked');
    renameSync(f.root, linked);
    symlinkSync(linked, f.root);
  }
  if (kind === 'other prefix') {
    const otherRoot = join(f.dir, 'other modules');
    mkdirSync(join(otherRoot, '@chittr/cli'), { recursive: true });
    f.configure({ npmRoot: otherRoot });
  }
  if (kind === 'local' || kind === 'npx') {
    const localRoot = join(
      kind === 'local' ? f.workspace : join(f.home, '.npm/_npx/fixture'),
      'node_modules/@chittr/cli',
    );
    mkdirSync(dirname(localRoot), { recursive: true });
    renameSync(f.root, localRoot);
    launchEntry = join(localRoot, 'dist/cli.js');
  }
  if (kind === 'source') {
    // import.meta.url now points into src, even though invoked through dist/cli.js.
    mkdirSync(join(f.root, 'src'));
    renameSync(f.entry, join(f.root, 'src/cli.js'));
    symlinkSync(join(f.root, 'src/cli.js'), f.entry);
  }
  if (kind === 'name' || kind === 'version')
    writeFileSync(
      f.manifest,
      JSON.stringify({
        name: kind === 'name' ? 'wrong' : '@chittr/cli',
        version: kind === 'version' ? 'wat' : '1.0.0',
        type: 'module',
      }),
    );
  if (kind === 'missing destination') f.configure({ npmRoot: join(f.dir, 'absent') });
  const result = f.run([], launchEntry);
  failed(result);
  noInstall(f);
  if (kind === 'other prefix') expect(result.stderr).toContain('prefixes do not match');
  expect(result.stderr).toContain('Installation was not started; no package files were changed.');
  expect(result.stderr).toContain('Use the installation method that owns this copy');
  if (kind === 'local' || kind === 'npx' || kind === 'missing destination') {
    expect(result.stderr).toContain(`This Chittr runs from ${dirname(dirname(launchEntry))}`);
    expect(result.stderr).toContain('npm on PATH has no verifiable global @chittr/cli at');
    expect(result.stderr).toContain(
      kind === 'missing destination' ? join(f.dir, 'absent/@chittr/cli') : f.root,
    );
  }
});

it.each([
  { metadataRaw: '{oops' },
  { metadataRaw: '' },
  { metadata: null },
  { metadata: [] },
  { metadata: {} },
  { metadata: { version: '1.2' } },
  { metadata: { version: '--evil' } },
  { metadata: { version: '1.1.0', engines: null } },
  { metadata: { version: '1.1.0', engines: { node: 22 } } },
  { metadata: { version: '1.1.0', engines: { node: 'nonsense' } } },
  { metadata: { version: '1.1.0', engines: { node: '>=999' } } },
  { viewError: true },
  { rootError: true },
  { npmRoot: 'relative/root' },
])('rejects invalid/unavailable metadata or incompatible Node: %j', (options) => {
  const f = fixture(options);
  const result = f.run();
  failed(result);
  noInstall(f);
  expect(result.stdout).not.toContain('Updating Chittr');
  expect(result.stderr).toContain('Installation was not started; no package files were changed.');
  if (!options.rootError && !options.npmRoot)
    expect(result.stderr).not.toContain('Use the installation method that owns this copy');
  if (options.viewError) expect(result.stderr).toContain('registry offline diagnostic');
  if (options.metadataRaw !== undefined)
    expect(result.stderr).toContain('npm view @chittr/cli@latest returned unreadable metadata');
});

it.each([{}, { npm: '>=11' }])('adds no Node constraint for engines %j', (engines) => {
  const f = fixture({ metadata: { version: '1.1.0', engines } });
  const result = f.run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Updated Chittr to 1.1.0');
});

it('uses npm engine-range semantics for a prerelease Node runtime', () => {
  const f = fixture({ nodeVersion: '25.0.0-rc.1' });
  const result = f.run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Updated Chittr to 1.1.0');
});

it.each(['missing', 'directory', 'malformed', 'name', 'version', 'unreadable'])(
  'does not report success with a %s post-install manifest',
  (after) => {
    const f = fixture({ after });
    const result = f.run();
    failed(result);
    expect(result.stderr).toContain('npm may have changed package files');
    expect(result.stderr).not.toContain('Use the installation method that owns this copy');
    expect(f.calls().at(-1)?.args[0]).toBe('install');
  },
);

it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
  'cancels metadata lookup on %s without installing',
  async (signal) => {
    const f = fixture({ holdView: true });
    const run = f.start();
    try {
      await vi.waitFor(() => expect(existsSync(f.ready)).toBe(true));
      const pid = Number(readFileSync(f.ready, 'utf8'));
      run.child.kill(signal);
      expect(await run.done).toBe(1);
      expect(() => process.kill(pid, 0)).toThrow();
      noInstall(f);
      expect(run.output().stderr).toContain(
        'Installation was not started; no package files were changed.',
      );
      expect(run.output().stderr).not.toContain('Use the installation method that owns this copy');
      expect(run.output().stdout).not.toContain('Updating Chittr');
    } finally {
      run.child.kill('SIGTERM');
      await run.done;
    }
  },
);

it.each([{ installError: true }, { removeNpm: true }])(
  'reports installer failure: %j',
  (options) => {
    const f = fixture(options);
    const result = f.run();
    failed(result);
    expect(result.stderr).toContain(
      options.installError ? 'npm EACCES fixture diagnosis' : 'Could not start npm',
    );
  },
);

it('delivers stdout and stderr before exit, without the 2 MiB buffered-helper cap', async () => {
  const f = fixture({ hold: true, largeOutput: true });
  const run = f.start();
  try {
    await vi.waitFor(() => {
      expect(run.output().stdout.length).toBeGreaterThan(2 * 1024 * 1024);
      expect(run.output().stderr).toContain('installer stderr before exit');
    });
    expect(run.child.exitCode).toBeNull();
    expect(run.output().stdout).not.toContain('Updated Chittr');
    writeFileSync(f.release, 'go');
    expect(await run.done).toBe(0);
    expect(run.output().stdout).toContain('Updated Chittr to 1.1.0');
  } finally {
    run.child.kill('SIGTERM');
    await run.done;
  }
});

it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
  'forwards %s, waits for the installer, and fails even if it exits zero',
  async (signal) => {
    const f = fixture({ hold: true });
    const run = f.start();
    try {
      await vi.waitFor(() => expect(existsSync(f.ready)).toBe(true));
      const pid = Number(readFileSync(f.ready, 'utf8'));
      run.child.kill(signal);
      expect(await run.done).toBe(1);
      expect(readFileSync(f.stopped, 'utf8')).toBe(signal);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(run.output().stderr).toContain('Update cancelled');
      expect(run.output().stdout).not.toContain('Updated Chittr');
    } finally {
      run.child.kill('SIGTERM');
      await run.done;
    }
  },
);

it('terminates an installer that ignores cancellation', async () => {
  const f = fixture({ hold: true, ignoreSignal: true });
  const run = f.start();
  try {
    await vi.waitFor(() => expect(existsSync(f.ready)).toBe(true));
    const pid = Number(readFileSync(f.ready, 'utf8'));
    run.child.kill('SIGTERM');
    expect(await run.done).toBe(1);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    run.child.kill('SIGTERM');
    await run.done;
  }
});

it('keeps a real installer alive when the timer clock crosses 30 seconds', async () => {
  const f = fixture({ hold: true });
  const controller = new AbortController();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const done = installWithNpm(f.npm, ['install', '--global', '@chittr/cli@1.1.0'], {
    cwd: f.workspace,
    env: f.env,
    signal: controller.signal,
  });
  try {
    await vi.waitFor(() => expect(existsSync(f.ready)).toBe(true));
    const pid = Number(readFileSync(f.ready, 'utf8'));
    await vi.advanceTimersByTimeAsync(31000);
    expect(() => process.kill(pid, 0)).not.toThrow();
    writeFileSync(f.release, 'go');
    await done;
    expect(JSON.parse(readFileSync(f.manifest, 'utf8')).version).toBe('1.1.0');
  } finally {
    vi.useRealTimers();
    controller.abort('SIGTERM');
    await done.catch(() => {});
  }
});
