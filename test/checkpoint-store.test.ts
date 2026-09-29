import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store.js';
import { newSession } from '../src/room.js';
import type { RoomConfig } from '../src/types.js';
const clean: (() => void)[] = [];
afterEach(() => {
  clean.splice(0).forEach((f) => f());
});
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'checkpoint-store-'));
  const store = new SessionStore(base, join(base, 'state'));
  store.acquire();
  clean.push(() => {
    store.release();
    rmSync(base, { recursive: true, force: true });
  });
  const config: RoomConfig = {
    workspace: base,
    permissions: { edits: false, commands: false, network: false },
    followUpTurns: 1,
    agents: {},
    sources: [],
    provenance: {},
  };
  const session = newSession(config);
  session.agents.a = {
    id: 'a',
    fingerprint: 'a',
    connection: 'ready',
    activity: 'available',
    paused: false,
    contextThrough: 1,
    sessionId: 'old-provider',
    draft: '',
  };
  session.messages.push({
    id: 'm1',
    sequence: 1,
    author: 'human',
    text: 'Correction: Tuesday replaces Monday',
    recipients: [],
    replyTo: [],
    roots: ['m1'],
    deliveries: { a: { status: 'queued' } },
    createdAt: new Date().toISOString(),
  });
  session.exchanges.m1 = { used: 0, allowance: 1 };
  store.save(session);
  const path = join(store.directory, session.id, 'session.json');
  return { store, session, path };
}
it('loads old version-1 files without auxiliary records', () => {
  const { store, session } = setup();
  expect(store.load()?.id).toBe(session.id);
  expect(store.load()?.checkpoints).toBeUndefined();
});
it.each(['coverage', 'source', 'handoff', 'maintenance'])(
  'keeps malformed %s records listable, retains the original and preserves core state',
  (kind) => {
    const { store, session, path } = setup();
    const value: any = structuredClone(session);
    const checkpoint = {
      version: 1,
      createdAt: new Date().toISOString(),
      sourceAgent: 'a',
      through: 1,
      messageId: 'm1',
      entries: [
        {
          category: 'correction',
          text: 'Tuesday replaces Monday',
          sources: [{ messageId: 'm1', author: 'human' }],
        },
      ],
    };
    if (kind === 'coverage') value.checkpoints = [{ ...checkpoint, through: 2 }];
    if (kind === 'source')
      value.checkpoints = [
        {
          ...checkpoint,
          entries: [{ ...checkpoint.entries[0], sources: [{ messageId: 'm1', author: 'a' }] }],
        },
      ];
    if (kind === 'handoff') value.handoffs = { a: { text: 'invalid' } };
    if (kind === 'maintenance') value.agents.a.maintenance = { agent: 'a', status: 'nonsense' };
    const original = JSON.stringify(value);
    writeFileSync(path, original);
    expect(store.list()).toHaveLength(1);
    const loaded = store.load()!;
    expect(loaded.notices.at(-1)?.text).toContain('Invalid saved');
    expect(loaded.messages).toEqual(session.messages);
    expect(loaded.agents.a?.sessionId).toBe('old-provider');
    expect(readFileSync(path, 'utf8')).toBe(original);
    if (kind === 'maintenance') expect(loaded.agents.a?.recoveryRequired).toBe(true);
    store.save(loaded);
    const backup = readdirSync(join(store.directory, session.id)).find((name) =>
      name.startsWith('invalid-auxiliary-'),
    )!;
    expect(readFileSync(join(store.directory, session.id, backup), 'utf8')).toBe(original);
  },
);
it('rejects backward checkpoint versions while retaining valid checkpoints', () => {
  const { store, session, path } = setup();
  const checkpoint = {
    version: 2,
    createdAt: new Date().toISOString(),
    sourceAgent: 'a',
    through: 1,
    messageId: 'm1',
    entries: [
      {
        category: 'correction' as const,
        text: 'Tuesday replaces Monday',
        sources: [{ messageId: 'm1', author: 'human' }],
      },
    ],
  };
  session.checkpoints = [checkpoint, { ...checkpoint, version: 1 }];
  writeFileSync(path, JSON.stringify(session));
  expect(store.load()?.checkpoints?.map((c) => c.version)).toEqual([2]);
});
