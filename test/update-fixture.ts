import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function updateFixture(options: Record<string, unknown> = {}, builtCli = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chittr update ')));
  const bin = join(dir, 'npm bin');
  const workspace = join(dir, 'workspace');
  const home = join(dir, 'home');
  const npmRoot = join(dir, 'global modules');
  const root = join(npmRoot, '@chittr/cli');
  const entry = join(root, 'dist/cli.js');
  const callsPath = join(dir, 'calls.jsonl');
  const manifest = join(root, 'package.json');
  const scenarioPath = join(dir, 'scenario.json');
  const release = join(dir, 'release');
  const ready = join(dir, 'ready');
  const stopped = join(dir, 'stopped');
  for (const path of [bin, workspace, home, join(root, 'dist')])
    mkdirSync(path, { recursive: true });
  writeFileSync(
    manifest,
    JSON.stringify({ name: '@chittr/cli', version: '1.0.0', type: 'module' }),
  );
  writeFileSync(callsPath, '');
  writeFileSync(
    join(workspace, '.npmrc'),
    'registry=https://project.invalid\nprefix=/wrong-prefix\n',
  );
  const scenario = {
    npmRoot,
    manifest,
    metadata: { version: '1.1.0', engines: { node: '>=22.12.0' } },
    release,
    ready,
    stopped,
    ...options,
  };
  const configure = (changes: Record<string, unknown>) => {
    Object.assign(scenario, changes);
    writeFileSync(scenarioPath, JSON.stringify(scenario));
  };
  configure({});
  if (builtCli) {
    cpSync(fileURLToPath(new URL('../dist', import.meta.url)), join(root, 'dist'), {
      recursive: true,
    });
    symlinkSync(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(root, 'node_modules'),
    );
  } else {
    writeFileSync(
      entry,
      `import { updateInstallation } from ${JSON.stringify(new URL('../dist/update.js', import.meta.url).href)};
${options.nodeVersion ? `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(options.nodeVersion)} });` : ''}
updateInstallation(new URL(import.meta.url)).catch(e => { console.error(e.message); process.exitCode = 1; });\n`,
    );
  }
  const npm = join(bin, 'npm');
  writeFileSync(
    npm,
    `#!${process.execPath}
const fs = require('node:fs');
const scenarioPath = ${JSON.stringify(scenarioPath)};
const s = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ executable: process.argv[1], args, cwd: process.cwd(), context: process.env.UPDATE_CONTEXT }) + '\\n');
if (!args.includes('--global')) { console.error('project .npmrc leaked into npm context'); process.exit(2); }
if (args[0] === 'root') {
  console.log(s.npmRoot);
  if (s.rootError) { console.error('root query failed'); process.exitCode = 2; }
} else if (args[0] === 'view') {
  if (s.viewError) { console.error('registry offline diagnostic'); process.exit(3); }
  // npm view unwraps the sole returned field when engines is absent.
  const metadata = s.metadata && typeof s.metadata === 'object' && Object.keys(s.metadata).length === 1 && 'version' in s.metadata ? s.metadata.version : s.metadata;
  console.log(s.metadataRaw === undefined ? JSON.stringify(metadata) : s.metadataRaw);
  if (s.holdView) { fs.writeFileSync(s.ready, String(process.pid)); setInterval(() => {}, 1000); }
  if (s.removeNpm) fs.unlinkSync(process.argv[1]);
  // Move latest after lookup; the installer must still receive the old exact version.
  if (s.moveTag) { s.metadata.version = '9.9.9'; fs.writeFileSync(scenarioPath, JSON.stringify(s)); }
} else if (args[0] === 'install') {
  console.log('installer stdout before exit');
  console.error('installer stderr before exit');
  if (s.largeOutput) process.stdout.write('x'.repeat(2 * 1024 * 1024 + 100));
  const finish = () => {
    if (s.installError) { console.error('npm EACCES fixture diagnosis'); process.exit(4); }
    const version = args.find(a => a.startsWith('@chittr/cli@')).slice('@chittr/cli@'.length);
    if (s.after === 'missing') fs.unlinkSync(s.manifest);
    else if (s.after === 'directory') { fs.unlinkSync(s.manifest); fs.mkdirSync(s.manifest); }
    else if (s.after === 'malformed') fs.writeFileSync(s.manifest, '{broken');
    else {
      fs.writeFileSync(s.manifest, JSON.stringify({ name: s.after === 'name' ? 'other' : '@chittr/cli', version: s.after === 'version' ? '0.0.1' : version }));
      if (s.after === 'unreadable') fs.chmodSync(s.manifest, 0);
    }
  };
  if (s.hold) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
      fs.writeFileSync(s.stopped, signal);
      if (!s.ignoreSignal) setTimeout(() => process.exit(0), 80);
    });
    fs.writeFileSync(s.ready, String(process.pid));
    const timer = setInterval(() => { if (fs.existsSync(s.release)) { clearInterval(timer); finish(); } }, 10);
  } else finish();
} else { console.error('unexpected npm command'); process.exit(5); }
`,
    { mode: 0o755 },
  );
  const env = { HOME: home, PATH: bin, UPDATE_CONTEXT: 'preserved', TMPDIR: dir };
  const run = (args: string[] = [], launchEntry = entry) =>
    spawnSync(process.execPath, [launchEntry, ...args], {
      cwd: workspace,
      env,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
  const start = () => {
    const child = spawn(process.execPath, [entry], {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { child, done, output: () => ({ stdout, stderr }) };
  };
  const calls = (): { executable: string; args: string[]; cwd: string; context: string }[] =>
    readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    dir,
    bin,
    workspace,
    home,
    npmRoot,
    root,
    entry,
    npm,
    env,
    manifest,
    release,
    ready,
    stopped,
    configure,
    run,
    start,
    calls,
  };
}
