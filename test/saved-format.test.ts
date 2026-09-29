import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../src/store.js';
import { AttachmentError } from '../src/attachments.js';
import type { Session } from '../src/types.js';

const fixtureText = readFileSync(
  fileURLToPath(new URL('./fixtures/saved-format-legacy-session.json', import.meta.url)),
  'utf8',
);
/** The checked-in older-shape record, parsed fresh so no case can mutate another's input. */
const fixture = (): any => JSON.parse(fixtureText);
const workspace: string = fixture().workspace;
const id: string = fixture().id;
/** A second session id, for the one case that needs two records in one workspace. */
const second = 'f3d0a1b6-4c27-4e88-9a15-6b0d2e7c4f39';

const CORE = 'Saved session is invalid or unsupported; it has not been overwritten';
const HISTORY = 'Saved message history is invalid; it has not been overwritten';
const notice = (detail: string) =>
  `Invalid saved ${detail}. The original file will be retained for diagnosis; valid conversation history remains available.`;
const image = {
  id: `att-${'0'.repeat(32)}`,
  filename: 'diagram.png',
  mediaType: 'image/png',
  byteSize: 1024,
  width: 16,
  height: 16,
};
const checkpoint = {
  version: 1,
  createdAt: '2026-02-01T09:10:00.000Z',
  sourceAgent: 'claude',
  through: 1,
  messageId: 'm1',
  entries: [
    {
      category: 'objective',
      text: 'Plan the storage migration',
      sources: [{ messageId: 'm1', author: 'human' }],
    },
  ],
};

const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));

/** Write one synthetic record where an older build would have left it. */
function write(store: SessionStore, session: unknown, sessionId = id) {
  const directory = join(store.directory, sessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'session.json');
  const raw = typeof session === 'string' ? session : JSON.stringify(session, null, 2);
  writeFileSync(path, raw);
  return { directory, path, raw };
}

/** Place one synthetic record in a fresh temporary storage base, as an older build left it. */
function place(session: unknown = fixture(), options: { latest?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'chittr-saved-format-'));
  const store = new SessionStore(workspace, join(base, 'state'));
  clean.push(() => {
    store.release();
    rmSync(base, { recursive: true, force: true });
  });
  const placed = write(store, session);
  const latest = join(store.directory, 'latest.json');
  if (options.latest !== false) writeFileSync(latest, JSON.stringify({ id }));
  return { store, ...placed, latest };
}

const core = (session: Session) => ({
  messages: session.messages.map(({ id, sequence, author, text, roots, deliveries }) => ({
    id,
    sequence,
    author,
    text,
    roots,
    deliveries,
  })),
  exchanges: session.exchanges,
});

it('loads, lists and round-trips the checked-in older-shape version-1 fixture', () => {
  const original = fixture();
  for (const absent of [
    'composerAttachments',
    'composerDraftRevision',
    'composerDraftVersions',
    'commandMode',
    'checkpoints',
    'handoffs',
    'recoveryRequired',
  ])
    expect(original).not.toHaveProperty(absent);
  expect(original.messages[1].question).toEqual({ choices: original.messages[1].question.choices });

  const { store } = place();
  store.acquire();
  expect(store.load()?.id).toBe(id);
  const loaded = store.load(id)!;
  expect(core(loaded)).toEqual(core(original));
  expect(store.list()).toEqual([
    { id, updatedAt: original.updatedAt, preview: original.messages[0].text, count: 3 },
  ]);
  store.save(loaded);
  expect(core(store.load(id)!)).toEqual(core(original));
  expect(core(store.load()!)).toEqual(core(original));
});

it.each(['unsupported 2', 'unsupported 0', 'the string "1"', 'an absent version'])(
  'rejects %s without overwriting anything, locked or unlocked',
  (label) => {
    for (const locked of [false, true]) {
      const session = fixture();
      if (label === 'an absent version') delete session.version;
      else session.version = label === 'the string "1"' ? '1' : Number(label.split(' ')[1]);
      const { store, directory, path, latest, raw } = place(session);
      const index = readFileSync(latest, 'utf8');
      const before = readdirSync(directory).sort();
      expect(before).toEqual(['session.json']);
      if (locked) store.acquire();
      expect(() => store.load(id)).toThrow(CORE);
      expect(() => store.list()).toThrow(CORE);
      expect(readFileSync(path, 'utf8')).toBe(raw);
      expect(readFileSync(latest, 'utf8')).toBe(index);
      expect(readdirSync(directory).sort()).toEqual(before);
      expect(readdirSync(directory).some((name) => name.startsWith('invalid-auxiliary-'))).toBe(
        false,
      );
    }
  },
);

it('rejects non-JSON saved content with the runtime parse error and no write', () => {
  const { store, path, raw } = place('{ not json');
  expect(() => store.load(id)).toThrow(SyntaxError);
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(() => store.load('../escape')).toThrow('Invalid saved session ID');
});

it.each([
  { label: 'a workspace mismatch', message: CORE, break: (s: any) => (s.workspace = '/elsewhere') },
  { label: 'an id mismatch', message: CORE, break: (s: any) => (s.id = randomUUID()) },
  { label: 'missing notices', message: CORE, break: (s: any) => delete s.notices },
  {
    label: 'out-of-order sequence',
    message: HISTORY,
    break: (s: any) => (s.messages[2].sequence = 5),
  },
  {
    label: 'a duplicated attachment draft',
    message: 'Saved attachment draft is invalid; it has not been overwritten',
    break: (s: any) => (s.composerAttachments = [image, { ...image }]),
  },
  {
    label: 'too many draft writers',
    message: 'Saved attachment draft writers are invalid; it has not been overwritten',
    break: (s: any) =>
      (s.composerDraftVersions = Object.fromEntries(
        Array.from({ length: 1001 }, () => [randomUUID(), 0]),
      )),
  },
  {
    label: 'a pin with no message',
    message: 'Saved message pins are invalid; the session has not been overwritten',
    break: (s: any) => (s.pinnedMessageIds = ['m999']),
  },
  {
    label: 'a frozen answer before its question',
    message: 'Saved question history is invalid; it has not been overwritten',
    break: (s: any) => (s.messages[1].question.frozenAnswerId = 'm1'),
  },
])('rejects $label with its own message and leaves the file byte-identical', (entry) => {
  const session = fixture();
  entry.break(session);
  const { store, path, latest, raw } = place(session);
  const index = readFileSync(latest, 'utf8');
  store.acquire();
  expect(() => store.load(id)).toThrow(entry.message);
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(readFileSync(latest, 'utf8')).toBe(index);
});

it('freezes legacy questions in memory always and on disk only under the lock', () => {
  const unlocked = place();
  expect(unlocked.store.load(id)!.messages[1]!.question!.frozenAnswerId).toBe('m3');
  expect(readFileSync(unlocked.path, 'utf8')).toBe(unlocked.raw);

  const open = fixture();
  open.messages.pop();
  open.agents.claude.contextThrough = 2;
  const unanswered = place(open);
  expect(unanswered.store.load(id)!.messages[1]!.question!.frozenAnswerId).toBeNull();
  expect(readFileSync(unanswered.path, 'utf8')).toBe(unanswered.raw);

  const locked = place();
  locked.store.acquire();
  const index = readFileSync(locked.latest, 'utf8');
  expect(locked.store.load(id)!.messages[1]!.question!.frozenAnswerId).toBe('m3');
  const persisted = JSON.parse(readFileSync(locked.path, 'utf8'));
  expect(persisted.messages[1].question.frozenAnswerId).toBe('m3');
  expect(persisted.updatedAt).toBe(fixture().updatedAt);
  expect(readFileSync(locked.latest, 'utf8')).toBe(index);
});

it('rewrites a locked legacy record before auxiliary recovery, so the retained copy is not the original bytes', () => {
  const session = fixture();
  session.checkpoints = [{ ...checkpoint, through: 4, messageId: 'm4' }];
  const { store, directory, path, raw } = place(session);
  store.acquire();
  const loaded = store.load(id)!;
  expect(loaded.notices.map((n) => n.text)).toEqual([notice('checkpoint record')]);
  expect(loaded.checkpoints).toEqual([]);
  const rewritten = readFileSync(path, 'utf8');
  expect(rewritten).not.toBe(raw);
  expect(JSON.parse(rewritten).messages[1].question.frozenAnswerId).toBe('m3');
  expect(JSON.parse(rewritten).checkpoints).toEqual(session.checkpoints);
  store.save(loaded);
  const retained = readdirSync(directory).filter((name) => name.startsWith('invalid-auxiliary-'));
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatch(/^invalid-auxiliary-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.json$/);
  const copy = readFileSync(join(directory, retained[0]!), 'utf8');
  expect(copy).toBe(rewritten);
  // The retained copy is the rewritten record, not the bytes the fixture had before the load.
  expect(JSON.parse(copy).messages[1].question).toHaveProperty('frozenAnswerId', 'm3');
  expect(JSON.parse(raw).messages[1].question).not.toHaveProperty('frozenAnswerId');
  expect(JSON.parse(copy).checkpoints).toEqual(session.checkpoints);
});

it.each([
  {
    label: 'checkpoints that are not an array',
    detail: 'checkpoints',
    break: (s: any) => (s.checkpoints = 'none'),
    check: (s: Session) => expect(s.checkpoints).toEqual([]),
  },
  {
    label: 'one malformed checkpoint record',
    detail: 'checkpoint record',
    break: (s: any) => (s.checkpoints = [{ ...checkpoint, through: 4, messageId: 'm4' }]),
    check: (s: Session) => expect(s.checkpoints).toEqual([]),
  },
  {
    label: 'continuation notes that are not an object',
    detail: 'continuation notes',
    break: (s: any) => (s.handoffs = []),
    check: (s: Session) => expect(s.handoffs).toEqual({}),
  },
  {
    label: 'one malformed continuation note',
    detail: 'continuation note for @claude',
    break: (s: any) => (s.handoffs = { claude: { text: 'unparsable' } }),
    check: (s: Session) => expect(s.handoffs).toEqual({}),
  },
  {
    label: 'a checkpoint reference with no checkpoint',
    detail: 'checkpoint reference for @claude',
    break: (s: any) => (s.agents.claude.checkpointVersion = 7),
    check: (s: Session) => expect(s.agents.claude!.checkpointVersion).toBeUndefined(),
  },
  {
    label: 'a non-boolean agent recovery hold',
    detail: 'recovery hold for @claude',
    break: (s: any) => (s.agents.claude.recoveryRequired = 'yes'),
    check: (s: Session) => expect(s.agents.claude!.recoveryRequired).toBe(true),
  },
  {
    label: 'a non-boolean room recovery hold',
    detail: 'room recovery hold',
    break: (s: any) => (s.recoveryRequired = 'yes'),
    check: (s: Session) => expect(s.recoveryRequired).toBe(true),
  },
])(
  'drops or coerces $label with its own notice, and retains the original at the next save',
  (entry) => {
    const session = fixture();
    entry.break(session);
    const { store, directory, path, raw } = place(session);
    const loaded = store.load(id)!;
    expect(loaded.notices.map((n) => n.text)).toEqual([notice(entry.detail)]);
    entry.check(loaded);
    expect(loaded.messages).toHaveLength(3);
    // An unlocked load writes nothing at all.
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(readdirSync(directory)).toEqual(['session.json']);
    // The next save copies whatever session.json holds, then overwrites it.
    store.acquire();
    store.save(loaded);
    const retained = readdirSync(directory).filter((name) => name.startsWith('invalid-auxiliary-'));
    expect(retained).toHaveLength(1);
    expect(readFileSync(join(directory, retained[0]!), 'utf8')).toBe(raw);
    expect(readFileSync(path, 'utf8')).not.toBe(raw);
  },
);

it('normalizes the session a failed listing reaches first and never writes the rejected one', () => {
  const base = mkdtempSync(join(tmpdir(), 'chittr-saved-format-'));
  const store = new SessionStore(workspace, join(base, 'state'));
  clean.push(() => {
    store.release();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(store.directory, id), { recursive: true, mode: 0o700 });
  mkdirSync(join(store.directory, second), { recursive: true, mode: 0o700 });
  store.acquire();
  // `list()` enumerates with readdirSync, whose order is not defined. Read that order once
  // every entry exists, then place the legacy record where the listing looks first, so the
  // assertions below hold on any filesystem rather than only on a name-ordered one.
  const [first, last] = readdirSync(store.directory).filter((name) => /^[\da-f-]{36}$/.test(name));
  const legacy = fixture();
  legacy.id = first;
  const visited = write(store, legacy, first);
  const broken = fixture();
  broken.id = last;
  broken.version = 2;
  const rejected = write(store, broken, last!);

  expect(() => store.list()).toThrow(CORE);
  // The rejected record is never written.
  expect(readFileSync(rejected.path, 'utf8')).toBe(rejected.raw);
  // The record the listing reached first was normalized in place before the throw, and that
  // is the only way it differs from what the test wrote.
  const normalized = fixture();
  normalized.id = first;
  normalized.messages[1].question.frozenAnswerId = 'm3';
  expect(readFileSync(visited.path, 'utf8')).not.toBe(visited.raw);
  expect(JSON.parse(readFileSync(visited.path, 'utf8'))).toEqual(normalized);
});

it('holds the agent and the room when saved maintenance names another agent', () => {
  const session = fixture();
  session.agents.claude.maintenance = {
    id: 'operation-1',
    agent: 'codex',
    status: 'running',
    route: 'replacement',
    startedAt: '2026-02-01T09:10:00.000Z',
  };
  const { store, directory, path, raw } = place(session);
  const loaded = store.load(id)!;
  expect(loaded.notices.map((n) => n.text)).toEqual([
    notice('maintenance state for @claude; explicit recovery is required'),
  ]);
  expect(loaded.agents.claude!.maintenance).toBeUndefined();
  expect(loaded.agents.claude!.recoveryRequired).toBe(true);
  expect(loaded.recoveryRequired).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe(raw);
  store.acquire();
  store.save(loaded);
  const retained = readdirSync(directory).filter((name) => name.startsWith('invalid-auxiliary-'));
  expect(retained).toHaveLength(1);
  expect(readFileSync(join(directory, retained[0]!), 'utf8')).toBe(raw);
});

it.each([
  { label: 'non-JSON', content: 'not an index' },
  {
    label: 'an unknown index version',
    content: JSON.stringify({ version: 2, attachments: {}, operations: {} }),
  },
])('keeps a corrupt attachment index intact and reports attachment-corrupt: $label', (entry) => {
  const { store, directory } = place();
  const index = join(directory, 'attachments', 'index.json');
  mkdirSync(join(directory, 'attachments'), { recursive: true, mode: 0o700 });
  writeFileSync(index, entry.content);
  store.acquire();
  expect(readFileSync(index, 'utf8')).toBe(entry.content);
  expect(store.load(id)?.id).toBe(id);
  expect(readFileSync(index, 'utf8')).toBe(entry.content);
  try {
    store.attachmentAccess(id).resolve(image.id);
    expect.unreachable('resolve must reject a corrupt index');
  } catch (error) {
    expect(error).toBeInstanceOf(AttachmentError);
    expect((error as AttachmentError).code).toBe('attachment-corrupt');
  }
});

it('resolves the latest pointer without ever writing to it', () => {
  const absent = place(fixture(), { latest: false });
  expect(absent.store.load()).toBeUndefined();

  const missing = place();
  const index = readFileSync(missing.latest, 'utf8');
  rmSync(missing.directory, { recursive: true, force: true });
  expect(() => missing.store.load()).toThrow(/ENOENT/);
  expect(readFileSync(missing.latest, 'utf8')).toBe(index);

  const invalid = fixture();
  invalid.workspace = '/elsewhere';
  const rejected = place(invalid);
  expect(() => rejected.store.load()).toThrow(CORE);
  expect(readFileSync(rejected.latest, 'utf8')).toBe(index);

  const pointer = place();
  for (const content of [JSON.stringify({ id: 'not a session' }), JSON.stringify({})]) {
    writeFileSync(pointer.latest, content);
    expect(() => pointer.store.load()).toThrow('Invalid saved session ID');
    expect(readFileSync(pointer.latest, 'utf8')).toBe(content);
  }
  // latest.json itself is parsed without validation: its own corruption is a raw parse error.
  writeFileSync(pointer.latest, 'corrupt');
  expect(() => pointer.store.load()).toThrow(SyntaxError);
  expect(readFileSync(pointer.latest, 'utf8')).toBe('corrupt');
});
