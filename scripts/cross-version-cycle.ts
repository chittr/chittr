import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { deflateSync } from 'node:zlib';
import { chromium, type Page } from '@playwright/test';
import { evidenceFindings } from './evidence-sanitization.js';
import {
  draftConcurrencyProblems,
  judgeCycle,
  observeSession,
  survivalProblems,
  unexpectedDifferences,
  type ExpectedAttachment,
  type IntendedEdit,
  type ProcessObservation,
  type SessionObservation,
  type StoredAttachment,
} from './cross-version-outcomes.js';

// #58 cross-version session and draft verification. Distinct application
// processes — the release candidate's built entry point and the previous
// installed build's — take turns owning one isolated --state-dir for one
// workspace: new, previous, new. Every transition is an orderly close that
// releases the workspace lock. No agent is enabled, so no provider CLI starts
// and no model call is made: this is a storage experiment, and image delivery
// is #57's evidence. Neither build's global link nor real user state is touched.
//
//   npm run build
//   npx tsx scripts/cross-version-cycle.ts --previous <previous build>/dist/cli.js \
//     --output <private-output>/cross-version-cycle-<date>.json [--private <directory>]
//
// The retained record holds identities, hashes, sizes and outcomes. Fixture
// images, host paths and the working, backup and recovery storage stay in the
// private directory, which is removed unless --private names one to keep.

const { values } = parseArgs({
  options: {
    previous: { type: 'string' },
    new: { type: 'string' },
    output: { type: 'string' },
    private: { type: 'string' },
  },
});
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(values.previous, 'Name the previous build: --previous <path>/dist/cli.js');
assert.ok(values.output, 'Name the evidence file: --output <path>.json');
const entries = {
  new: realpathSync(resolve(values.new ?? join(repo, 'dist/cli.js'))),
  previous: realpathSync(resolve(values.previous)),
};
type Build = keyof typeof entries;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
function files(root: string, folder = root): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? files(root, join(folder, item.name))
      : [relative(root, join(folder, item.name))],
  );
}
/** `find . -type f | LC_ALL=C sort`, each line `<sha256>  ./<path>`, hashed. */
function treeHash(root: string) {
  const lines = files(root)
    .map((name) => `./${name}`)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((name) => `${sha256(readFileSync(join(root, name)))}  ${name}\n`);
  return sha256(lines.join(''));
}
function git(directory: string, ...args: string[]) {
  const run = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : undefined;
}
function identity(build: Build) {
  const entry = entries[build];
  const dist = dirname(entry);
  const root = dirname(dist);
  const linked = spawnSync('/bin/sh', ['-c', 'command -v chittr'], { encoding: 'utf8' });
  const executable = linked.status === 0 ? realpathSync(linked.stdout.trim()) : undefined;
  return {
    package: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string,
    sourceCommit: git(root, 'rev-parse', 'HEAD'),
    // The trees the build is made from. A later commit that leaves these unchanged,
    // such as one adding this evidence, builds the same product.
    productSourceTrees: Object.fromEntries(
      ['src', 'web', 'package.json', 'package-lock.json'].map((path) => [
        path,
        git(root, 'rev-parse', `HEAD:${path}`),
      ]),
    ),
    // Tracked source changes; untracked local files are not part of the build.
    sourcePatch: sha256(git(root, 'diff', 'HEAD') ?? ''),
    sourceClean: git(root, 'status', '--porcelain', '--untracked-files=no') === '',
    entrySha256: sha256(readFileSync(entry)),
    builtTreeSha256: treeHash(dist),
    builtFiles: files(dist).length,
    isLinkedAiChatExecutable: executable === entry,
  };
}

// A complete private PNG of random pixels: nothing about it is guessable or reused.
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data = Buffer.alloc(0)) {
  const name = Buffer.from(type);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}
function fixture() {
  const size = 48;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raster = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) randomBytes(size * 3).copy(raster, y * (size * 3 + 1) + 1);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raster)),
    chunk('IEND'),
  ]);
}

const root = realpathSync(
  values.private
    ? (mkdirSync(resolve(values.private), { recursive: true, mode: 0o700 }),
      mkdtempSync(join(resolve(values.private), 'cycle-')))
    : mkdtempSync(join(tmpdir(), 'chittr-cross-version-')),
);
const workspace = join(root, 'workspace');
const state = join(root, 'state');
mkdirSync(join(workspace, '.agents'), { recursive: true });
mkdirSync(join(root, 'fixtures'));
// Every agent a user-level config could enable is switched off for this workspace.
writeFileSync(
  join(workspace, '.agents/chittr.yaml'),
  `version: 1
human: {name: Tester}
skills: {enabled: false}
permissions: {edits: false, commands: false, network: false}
agents:
  codex: {provider: codex, enabled: false}
  claude: {provider: claude, enabled: false}
  grok: {provider: grok, enabled: false}
  antigravity: {provider: antigravity, enabled: false}
`,
);

const processes: ProcessObservation[] = [];
const edits: IntendedEdit[] = [];
const fixtures = new Map<string, { sha256: string; byteSize: number }>();
function newFixture(name: string) {
  const bytes = fixture();
  const path = join(root, 'fixtures', name);
  writeFileSync(path, bytes);
  fixtures.set(name, { sha256: sha256(bytes), byteSize: bytes.length });
  return { path, bytes };
}

const sessionPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/;
function sessionDirectories(base = state) {
  return existsSync(base)
    ? readdirSync(base).filter((name) => statSync(join(base, name)).isDirectory())
    : [];
}
function sessionIds(base = state) {
  return sessionDirectories(base).flatMap((directory) =>
    readdirSync(join(base, directory)).filter((name) => sessionPattern.test(name)),
  );
}
function savedSession(id: string, base = state): Record<string, unknown> {
  const [directory] = sessionDirectories(base);
  return JSON.parse(readFileSync(join(base, directory!, id, 'session.json'), 'utf8'));
}
const lockPresent = (base = state) =>
  sessionDirectories(base).some((directory) => existsSync(join(base, directory, 'room.lock')));

async function until(check: () => boolean, what: string, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (check()) return;
    } catch {
      // session.json is replaced by rename; a read between the two is retried.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

type TerminalAction =
  | { do: 'attach'; path: string }
  | { do: 'type'; text: string; expect: string }
  | { do: 'enter'; messages: number }
  | { do: 'pin'; message: string }
  | { do: 'remove-last' }
  | { do: 'list' };
function terminal(step: string, build: Build, session: string | undefined, acts: TerminalAction[]) {
  const run = spawnSync(
    'python3',
    [
      join(repo, 'scripts/cross-version-terminal.py'),
      '--entry',
      entries[build],
      '--workspace',
      workspace,
      '--state-dir',
      state,
      ...(session ? ['--session', session] : []),
      '--actions',
      JSON.stringify(acts),
    ],
    { encoding: 'utf8', timeout: 180000 },
  );
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1) || '{}');
  processes.push({
    step,
    pid: result.pid,
    build,
    entry: 'terminal',
    exitCode: result.exitCode ?? null,
    terminated: Boolean(result.terminated),
    lockPresentAfterExit: Boolean(result.lockPresentAfterExit),
    expectedSessionId: session,
    openedSessionId: result.savedConversationId ?? undefined,
    createdSessionIds: result.createdSessionIds ?? [],
  });
  assert.equal(result.error ?? null, null, `${step}: ${result.error}`);
  assert.equal(run.status, 0, `${step}: terminal driver failed`);
  return result as {
    pid: number;
    savedConversationId: string;
    createdSessionIds: string[];
    listedAttachmentIds: string[];
    removedAttachmentId?: string;
  };
}

// The product opens the default browser itself. Denying exactly that one exec keeps
// the experiment off the operator's desktop; the product reports it could not open
// the browser and carries on, which is its own documented fallback.
const noDesktopBrowser = '(version 1)(allow default)(deny process-exec (literal "/usr/bin/open"))';
type BrowserContext = { page: Page; sessionId: string };
async function browser<T>(
  step: string,
  build: Build,
  session: string | undefined,
  work: (context: BrowserContext) => Promise<T>,
) {
  const before = new Set(sessionIds());
  const child: ChildProcess = spawn(
    '/usr/bin/sandbox-exec',
    [
      '-p',
      noDesktopBrowser,
      process.execPath,
      entries[build],
      ...(session ? ['resume', session] : []),
      '--web',
      '--state-dir',
      state,
    ],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout!.on('data', (data) => (output += data));
  child.stderr!.on('data', (data) => (output += data));
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  const observation: ProcessObservation = {
    step,
    pid: child.pid,
    build,
    entry: 'browser',
    exitCode: null,
    terminated: false,
    lockPresentAfterExit: true,
    expectedSessionId: session,
    createdSessionIds: [],
  };
  processes.push(observation);
  const chrome = await chromium.launch(
    process.env.CHITTR_BROWSER
      ? { executablePath: process.env.CHITTR_BROWSER }
      : { channel: 'chrome' },
  );
  try {
    await until(() => /http:\/\/127\.0\.0\.1:\d+\/#[\da-f]+/.test(output), `${step} URL`);
    const page = await chrome.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(output.match(/http:\/\/127\.0\.0\.1:\d+\/#[\da-f]+/)![0]);
    await page.locator('textarea[aria-label="Message"]').waitFor({ timeout: 30000 });
    // The session this process actually serves, from its own authenticated state API.
    // The page authenticates itself first; until then the API answers 401.
    const sessionId = await page.evaluate(async () => {
      for (let attempt = 0; attempt < 150; attempt++) {
        const response = await fetch('/api/state');
        const id = response.ok ? (await response.json())?.session?.id : undefined;
        if (typeof id === 'string') return id;
        await new Promise((done) => setTimeout(done, 100));
      }
      return undefined;
    });
    assert.ok(sessionId, `${step}: the served page never reported its session`);
    observation.openedSessionId = sessionId;
    const result = await work({ page, sessionId });
    // The product's own Quit control: stop, save, release the lock, exit.
    await page.getByRole('button', { name: 'Quit', exact: true }).click();
    const code = await Promise.race([
      exited,
      new Promise<'late'>((done) => setTimeout(() => done('late'), 20000)),
    ]);
    if (code === 'late') {
      observation.terminated = true;
      child.kill('SIGTERM');
      observation.exitCode = await exited;
    } else observation.exitCode = code;
    return result;
  } finally {
    await chrome.close();
    if (child.exitCode === null && child.signalCode === null) {
      observation.terminated = true;
      child.kill('SIGTERM');
      await exited;
    }
    observation.lockPresentAfterExit = lockPresent();
    observation.createdSessionIds = sessionIds().filter((id) => !before.has(id));
  }
}
async function pasteImage(page: Page, name: string, bytes: Buffer, count: number) {
  await page.evaluate(
    ({ name, bytes }) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(bytes)], name, { type: 'image/png' }));
      document
        .querySelector('textarea[aria-label="Message"]')!
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
    },
    { name, bytes: [...bytes] },
  );
  await page.waitForFunction(
    (count) => {
      const images = [...document.querySelectorAll('.draft-images img')] as HTMLImageElement[];
      return images.length === count && images.every((image) => image.naturalWidth > 0);
    },
    count,
    { timeout: 30000 },
  );
}
/** Draft previews the served page actually decoded, through its authenticated reads. */
const renderedDraftImages = (page: Page) =>
  page.evaluate(
    () =>
      ([...document.querySelectorAll('.draft-images img')] as HTMLImageElement[]).filter(
        (image) => image.naturalWidth > 0,
      ).length,
  );
const renderedMessageImages = (page: Page) =>
  page.evaluate(
    () =>
      ([...document.querySelectorAll('[data-message-id] img')] as HTMLImageElement[]).filter(
        (image) => image.naturalWidth > 0,
      ).length,
  );
async function typeDraft(page: Page, id: string, text: string) {
  await page.locator('textarea[aria-label="Message"]').fill(text);
  await until(() => savedSession(id).composerDraft === text, 'saved browser draft');
}

/**
 * What the candidate's own store says about every expected attachment. The store
 * only ever opens `copy`, so the storage the product processes produced is read
 * but never written here: `indexFrom` is where the index entries are read, as files.
 */
async function inspect(
  copy: string,
  indexFrom: string,
  expected: ExpectedAttachment[],
  cleanupAt?: number,
) {
  const { SessionStore } = await import(pathToFileURL(join(dirname(entries.new), 'store.js')).href);
  const store = new SessionStore(workspace, copy);
  store.acquire();
  try {
    const cleaned = cleanupAt === undefined ? undefined : store.cleanupAttachments(cleanupAt);
    const stored: StoredAttachment[] = [];
    const [directory] = sessionDirectories(indexFrom);
    for (const want of expected) {
      const index = JSON.parse(
        readFileSync(join(indexFrom, directory!, want.sessionId, 'attachments/index.json'), 'utf8'),
      ).attachments[want.id];
      const item: StoredAttachment = {
        sessionId: want.sessionId,
        id: want.id,
        indexed: Boolean(index),
        orphanedAt: index?.orphanedAt,
        indexSha256: index?.sha256,
      };
      try {
        const { bytes } = store.attachmentAccess(want.sessionId).resolve(want.id);
        item.resolvedSha256 = sha256(bytes);
        item.resolvedByteSize = bytes.length;
      } catch (error) {
        item.resolveError = (error as Error).name;
      }
      stored.push(item);
    }
    return { stored, cleaned };
  } finally {
    store.release();
  }
}

const started = new Date().toISOString();
const evidence: Record<string, any> = {
  issue: 58,
  experiment: 'cross-version session and draft cycle: new build, previous build, new build',
  startedAt: started,
  host: {
    os: spawnSync('/usr/bin/sw_vers', { encoding: 'utf8' })
      .stdout.trim()
      .replace(/:\s+/g, ': ')
      .replace(/\n/g, '; '),
    node: process.version,
  },
  builds: { new: identity('new'), previous: identity('previous') },
  isolation: {
    storage: 'a private --state-dir and workspace created for this run',
    configuredEnabledAgents: 0,
    entryPoints: 'each build invoked by the path of its own dist/cli.js; no link changed',
    desktopBrowserOpenDenied: true,
  },
};
let failure: unknown;
try {
  assert.notEqual(
    evidence.builds.new.builtTreeSha256,
    evidence.builds.previous.builtTreeSha256,
    'The two entry points are the same build; that is a same-build restart, not this check',
  );

  // 1. New product: sent image messages and unsent drafts, terminal and browser.
  const images = {
    aSent: newFixture('a-sent.png'),
    aDraft1: newFixture('a-draft-1.png'),
    aDraft2: newFixture('a-draft-2.png'),
    bSent: newFixture('b-sent.png'),
    bDraft1: newFixture('b-draft-1.png'),
    bDraft2: newFixture('b-draft-2.png'),
    cSent: newFixture('c-sent.png'),
    cDraft1: newFixture('c-draft-1.png'),
    control: newFixture('control-removed.png'),
  };
  const create = (
    name: string,
    sent: string,
    caption: string,
    draft: string,
    drafts: TerminalAction[],
  ) =>
    terminal(`new-1 terminal create ${name}`, 'new', undefined, [
      { do: 'attach', path: sent },
      { do: 'type', text: caption, expect: caption },
      { do: 'enter', messages: 1 },
      { do: 'type', text: draft, expect: draft },
      ...drafts,
    ]);
  // The control is staged between the two kept images and removed again, which leaves
  // an orphaned index entry: the one thing cleanup beyond grace is supposed to delete.
  const createdA = create('a', images.aSent.path, 'terminal sent image', 'terminal unsent draft', [
    { do: 'attach', path: images.aDraft1.path },
    { do: 'attach', path: images.control.path },
    { do: 'remove-last' },
    { do: 'attach', path: images.aDraft2.path },
  ]);
  const a = createdA.savedConversationId;
  const controlId = createdA.removedAttachmentId;
  assert.ok(controlId, 'The control image was never staged and removed');
  const c = create(
    'c',
    images.cSent.path,
    'second terminal sent image',
    'draft the old build sends',
    [{ do: 'attach', path: images.cDraft1.path }],
  ).savedConversationId;
  const b = await browser('new-1 browser create', 'new', undefined, async ({ page, sessionId }) => {
    await pasteImage(page, 'b-sent.png', images.bSent.bytes, 1);
    await page.locator('textarea[aria-label="Message"]').fill('browser sent image');
    await page.locator('textarea[aria-label="Message"]').press('Enter');
    await until(
      () => (savedSession(sessionId).messages as unknown[]).length === 1,
      'browser sent message',
    );
    await pasteImage(page, 'b-draft-1.png', images.bDraft1.bytes, 1);
    await pasteImage(page, 'b-draft-2.png', images.bDraft2.bytes, 2);
    await typeDraft(page, sessionId, 'browser unsent draft');
    return sessionId;
  });
  const ids = { a, b, c };
  assert.equal(new Set(Object.values(ids)).size, 3, 'Expected three distinct saved sessions');
  assert.equal(lockPresent(), false, 'The new build left the workspace lock behind');

  // The comparison record, with each reference's original content hash and size.
  const baseline: Record<string, SessionObservation> = {};
  const expected: ExpectedAttachment[] = [];
  const [directory] = sessionDirectories();
  for (const id of Object.values(ids)) {
    const saved = savedSession(id);
    baseline[id] = observeSession(saved);
    const index = JSON.parse(
      readFileSync(join(state, directory!, id, 'attachments/index.json'), 'utf8'),
    ).attachments;
    const note = (use: 'sent' | 'draft') => (item: { id: string; byteSize: number }) => {
      const blob = readFileSync(
        join(state, directory!, id, 'attachments/blobs', `${index[item.id].sha256}.bin`),
      );
      assert.equal(sha256(blob), index[item.id].sha256);
      assert.ok(
        [...fixtures.values()].some((known) => known.sha256 === sha256(blob)),
        'A stored blob is not one of the fixtures',
      );
      expected.push({
        sessionId: id,
        id: item.id,
        sha256: sha256(blob),
        byteSize: blob.length,
        use,
      });
    };
    for (const message of saved.messages as any[])
      (message.attachments ?? []).forEach(note('sent'));
    ((saved.composerAttachments ?? []) as any[]).forEach(note('draft'));
  }
  assert.equal(expected.filter((item) => item.use === 'sent').length, 3);
  assert.equal(expected.filter((item) => item.use === 'draft').length, 5);
  evidence.sessions = {
    terminalDraftEdited: a,
    browserDraftEdited: b,
    terminalDraftSentByPreviousBuild: c,
  };
  evidence.comparisonRecord = { sessions: baseline, attachments: expected };

  // 2. Coherent untouched backup of the whole workspace session storage, taken while
  // no process owns it. It is never opened by either build.
  const backup = join(root, 'backup-before-previous-build');
  cpSync(join(state, directory!), join(backup, directory!), { recursive: true });
  const backupTree = treeHash(backup);
  evidence.backup = {
    boundary:
      'the whole workspace session directory under --state-dir: latest.json and every session folder with its session.json and attachments/index.json and attachments/blobs',
    takenWhileUnowned: true,
    containsWorkspaceLock: files(backup).some((name) => name.endsWith('room.lock')),
    files: files(backup).length,
    treeSha256: backupTree,
  };
  assert.equal(evidence.backup.containsWorkspaceLock, false);

  // 3. Previous product: reopen each session by ID, make ordinary saves, close orderly.
  terminal('previous terminal reopen a', 'previous', a, [
    { do: 'type', text: ' kept by old build', expect: 'terminal unsent draft kept by old build' },
  ]);
  edits.push({
    kind: 'draft-text',
    sessionId: a,
    build: 'previous',
    text: 'terminal unsent draft kept by old build',
  });
  terminal('previous terminal reopen c', 'previous', c, [
    { do: 'enter', messages: 2 },
    { do: 'pin', message: 'm1' },
  ]);
  edits.push(
    { kind: 'text-message', sessionId: c, build: 'previous', text: 'draft the old build sends' },
    { kind: 'pin', sessionId: c, build: 'previous', messageId: 'm1' },
  );
  await browser('previous browser reopen b', 'previous', b, async ({ page, sessionId }) => {
    assert.equal(sessionId, b, 'The previous build served a different session');
    await typeDraft(page, b, 'browser unsent draft edited in old build');
    await page.getByRole('button', { name: 'Pin message' }).first().click();
    await until(
      () => (savedSession(b).pinnedMessageIds as string[] | undefined)?.includes('m1') === true,
      'saved browser pin',
    );
  });
  edits.push(
    {
      kind: 'draft-text',
      sessionId: b,
      build: 'previous',
      text: 'browser unsent draft edited in old build',
    },
    { kind: 'pin', sessionId: b, build: 'previous', messageId: 'm1' },
  );
  assert.equal(lockPresent(), false, 'The previous build left the workspace lock behind');
  const afterPrevious = Object.fromEntries(
    Object.values(ids).map((id) => [id, observeSession(savedSession(id))]),
  );
  const previousDifferences = Object.values(ids).flatMap((id) =>
    unexpectedDifferences(baseline[id]!, afterPrevious[id]!, edits),
  );
  // Kept apart from the untouched backup: the state as the previous build left it.
  const afterPreviousCopy = join(root, 'state-after-previous-build');
  cpSync(join(state, directory!), join(afterPreviousCopy, directory!), { recursive: true });
  evidence.previousBuild = {
    intendedEdits: structuredClone(edits),
    // What each session held after the previous build closed, before the new build
    // touched it again: the verdict's first comparison is recomputable from this.
    sessions: afterPrevious,
    unexpectedChanges: previousDifferences,
    postDowngradeStateKeptSeparately: true,
    untouchedBackupStillIntact: treeHash(backup) === backupTree,
  };

  // 4. New product again: reopen each session, look through the product, save, close.
  const reopenedA = terminal('new-2 terminal reopen a', 'new', a, [{ do: 'list' }]);
  const reopenedC = terminal('new-2 terminal reopen c', 'new', c, [
    { do: 'list' },
    { do: 'type', text: 'new build again', expect: 'new build again' },
  ]);
  edits.push({ kind: 'draft-text', sessionId: c, build: 'new', text: 'new build again' });
  const browserView = await browser('new-2 browser reopen b', 'new', b, async ({ page }) => {
    await page.waitForFunction(
      () =>
        ([...document.querySelectorAll('.draft-images img')] as HTMLImageElement[]).filter(
          (image) => image.naturalWidth > 0,
        ).length === 2,
      undefined,
      { timeout: 30000 },
    );
    const view = {
      draftText: await page.locator('textarea[aria-label="Message"]').inputValue(),
      draftImagesDecoded: await renderedDraftImages(page),
      sentImagesDecoded: await renderedMessageImages(page),
    };
    await typeDraft(page, b, 'browser draft saved by new build again');
    return view;
  });
  edits.push({
    kind: 'draft-text',
    sessionId: b,
    build: 'new',
    text: 'browser draft saved by new build again',
  });
  const draftIds = (id: string) =>
    expected.filter((item) => item.sessionId === id && item.use === 'draft').map((item) => item.id);
  evidence.productView = {
    terminalListedDraftIds: {
      [a]: reopenedA.listedAttachmentIds,
      [c]: reopenedC.listedAttachmentIds,
    },
    terminalListedEveryDraftId: [a, c].every((id) =>
      draftIds(id).every((attachment) =>
        (id === a ? reopenedA : reopenedC).listedAttachmentIds.includes(attachment),
      ),
    ),
    browser: browserView,
  };
  assert.equal(lockPresent(), false, 'The new build left the workspace lock behind');

  const final = Object.fromEntries(
    Object.values(ids).map((id) => [id, observeSession(savedSession(id))]),
  );
  // Each transition is judged against the state it started from. The return to the
  // new build starts from what the previous build left, so anything that build
  // created, such as the exchange its send opened, has to be preserved as well.
  const newBuildEdits = edits.filter((edit) => edit.build === 'new');
  const differences = [
    ...previousDifferences,
    ...Object.values(ids).flatMap((id) =>
      unexpectedDifferences(afterPrevious[id]!, final[id]!, newBuildEdits),
    ),
  ];
  const concurrency = Object.values(final).flatMap(draftConcurrencyProblems);
  // Live references after the new build's startup cleanup and ordinary saves: the
  // index as those processes left it, resolved through the store on a copy.
  const liveCopy = join(root, 'state-inspected');
  cpSync(join(state, directory!), join(liveCopy, directory!), { recursive: true });
  const live = await inspect(liveCopy, state, expected);
  // Supporting time-controlled fixture, on a separate copy of the product-produced
  // state: cleanup run more than 24 hours after the recorded product check.
  const graceCopy = join(root, 'state-beyond-grace');
  cpSync(join(state, directory!), join(graceCopy, directory!), { recursive: true });
  const productCheckAt = Date.now();
  const cleanupAt = productCheckAt + 25 * 60 * 60 * 1000;
  const aged = await inspect(graceCopy, graceCopy, expected, cleanupAt);
  const controlIn = (base: string) => {
    const folder = join(base, directory!, a, 'attachments');
    const entry = JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8')).attachments[
      controlId
    ];
    const blob = join(folder, 'blobs', `${fixtures.get('control-removed.png')!.sha256}.bin`);
    return {
      indexed: Boolean(entry),
      orphaned: Boolean(entry?.orphanedAt),
      blob: existsSync(blob),
    };
  };
  const controlAfterCycle = controlIn(state);
  const controlBeyondGrace = controlIn(graceCopy);
  const controlOrphan = {
    orphanedAfterCycle:
      controlAfterCycle.indexed && controlAfterCycle.orphaned && controlAfterCycle.blob,
    removedBeyondGrace: !controlBeyondGrace.indexed && !controlBeyondGrace.blob,
  };
  evidence.finalObservation = { sessions: final, intendedEdits: edits };
  evidence.attachmentSurvival = {
    afterNewBuildReconciliation: live.stored,
    beyondOrphanGrace: {
      kind: 'supporting time-controlled fixture on a separate copy; the process cycle above is the product evidence',
      productCheckAt: new Date(productCheckAt).toISOString(),
      cleanupAt: new Date(cleanupAt).toISOString(),
      hoursAfterProductCheck: 25,
      retentionHours: 24,
      cleanupResult: aged.cleaned,
      attachments: aged.stored,
      control: {
        what: 'an image staged in a draft and removed again, so nothing references it',
        id: controlId,
        afterCycle: controlAfterCycle,
        beyondGrace: controlBeyondGrace,
      },
    },
  };

  // 5. Recovery rehearsal: the untouched backup restored into separate storage and
  // opened by the new product. Required when direct compatibility fails; run either
  // way so the documented route is a demonstrated one.
  const recovered = join(root, 'state-recovered');
  cpSync(backup, recovered, { recursive: true });
  const restoredBefore = treeHash(recovered);
  const recoveredProcess = spawnSync(
    'python3',
    [
      join(repo, 'scripts/cross-version-terminal.py'),
      '--entry',
      entries.new,
      '--workspace',
      workspace,
      '--state-dir',
      recovered,
      '--session',
      a,
      '--actions',
      JSON.stringify([{ do: 'list' }]),
    ],
    { encoding: 'utf8', timeout: 180000 },
  );
  const recoveredResult = JSON.parse(recoveredProcess.stdout.trim().split('\n').at(-1) || '{}');
  const recoveredStore = await inspect(recovered, recovered, expected);
  const recoveredSessions = Object.values(ids).map((id) =>
    unexpectedDifferences(baseline[id]!, observeSession(savedSession(id, recovered)), []),
  );
  evidence.recoveryRehearsal = {
    restoredFrom: 'the untouched pre-downgrade backup, copied into separate storage',
    restoredTreeMatchedBackup: restoredBefore === backupTree,
    openedByNewBuild: {
      exitCode: recoveredResult.exitCode ?? null,
      openedSessionId: recoveredResult.savedConversationId ?? null,
      listedEveryDraftId: draftIds(a).every((attachment) =>
        (recoveredResult.listedAttachmentIds ?? []).includes(attachment),
      ),
      lockPresentAfterExit: Boolean(recoveredResult.lockPresentAfterExit),
    },
    differencesFromComparisonRecord: recoveredSessions.flat(),
    survivalProblems: survivalProblems(expected, recoveredStore.stored),
    postDowngradeEditsPreservedSeparately: existsSync(afterPreviousCopy),
    untouchedBackupStillIntact: treeHash(backup) === backupTree,
  };

  evidence.processes = processes;
  evidence.sameSessionDirectory = sessionDirectories().length === 1;
  // Observed, not assumed: no saved session ever held a connected agent or a provider
  // session, so no provider CLI served a turn and no model was called.
  const agentStates = Object.values(ids).flatMap((id) =>
    Object.values(savedSession(id).agents as Record<string, any>),
  );
  evidence.isolation.observedConnectedAgents = agentStates.filter(
    (agent) => agent.connection !== 'unavailable',
  ).length;
  evidence.isolation.observedProviderSessions = agentStates.filter(
    (agent) => agent.sessionId !== undefined,
  ).length;
  assert.equal(evidence.isolation.observedConnectedAgents, 0);
  assert.equal(evidence.isolation.observedProviderSessions, 0);
  evidence.judgement = judgeCycle({
    processes,
    differences,
    concurrency,
    survival: survivalProblems(expected, live.stored),
    beyondGrace: survivalProblems(expected, aged.stored),
    controlOrphan,
    sameSessionDirectory: evidence.sameSessionDirectory,
  });
  evidence.status = evidence.judgement.verdict === 'direct-compatible' ? 'passed' : 'failed';
} catch (error) {
  failure = error;
  evidence.processes = processes;
  evidence.status = 'error';
  evidence.error = (error as Error).message.replaceAll(root, '<private>');
} finally {
  evidence.finishedAt = new Date().toISOString();
  const text = JSON.stringify(evidence, null, 2) + '\n';
  const findings = evidenceFindings(text);
  if (findings.length) {
    failure ??= new Error(`Evidence failed sanitization: ${findings.join('; ')}`);
  } else writeFileSync(resolve(values.output!), text);
  if (values.private) process.stdout.write(`Private storage kept at ${root}\n`);
  else rmSync(root, { recursive: true, force: true });
}
if (failure) throw failure;
process.stdout.write(`${evidence.status}: ${evidence.judgement.verdict}\n`);
if (evidence.status !== 'passed') process.exitCode = 1;
