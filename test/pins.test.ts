import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import { transcript } from '../src/ui/terminal.js';
import { projectRoom } from '../src/snapshot.js';
import { complete } from '../src/completion.js';

let base: string, store: SessionStore, controller: RoomController;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'chittr-pins-'));
  store = new SessionStore(base, join(base, 'state'));
  store.acquire();
  controller = new RoomController(
    {
      workspace: base,
      humanName: 'Bill',
      permissions: { edits: false, commands: false, network: false },
      followUpTurns: 8,
      sources: [],
      provenance: {},
      agents: {},
    },
    store,
    undefined,
    { help: '', quit: async () => {} },
  );
});
afterEach(async () => {
  await controller.close();
  store.release();
  rmSync(base, { recursive: true, force: true });
});

it('pins, lists full text in conversation order, and unpins without changing messages or queues', async () => {
  await controller.submit('/pins');
  expect(controller.room.session.notices.at(-1)?.text).toContain('No pinned messages');
  await controller.submit('@human First message\n  with indentation');
  await controller.submit('@human Second message');
  const original = structuredClone(controller.room.session);
  await controller.submit('/pin #m2');
  await controller.submit('/pin m1');
  await controller.submit('/pin #m1');
  expect(controller.room.session.pinnedMessageIds).toEqual(['m2', 'm1']);
  expect(controller.room.session.notices.at(-1)?.text).toBe('Message #m1 is already pinned.');
  await controller.submit('/pins');
  expect(controller.room.session.notices.at(-1)?.text).toBe(
    'Pinned messages (2)\n\n#m1 · Bill (@human)\nFirst message\n  with indentation\n\n#m2 · Bill (@human)\nSecond message',
  );
  expect(
    transcript(projectRoom(controller.room), 100).find((line) => line.key === 'm1:header')?.text,
  ).toContain('#m1  [pinned]');
  expect(store.load()?.pinnedMessageIds).toEqual(['m2', 'm1']);
  await controller.submit('/unpin #m1');
  await controller.submit('/unpin #m1');
  expect(controller.room.session.notices.at(-1)?.text).toBe('Message #m1 is not pinned.');
  expect(store.load()?.pinnedMessageIds).toEqual(['m2']);
  expect(
    transcript(projectRoom(controller.room), 100).find((line) => line.key === 'm1:header')?.text,
  ).not.toContain('[pinned]');
  expect(controller.room.session.messages).toEqual(original.messages);
  expect(controller.room.session.exchanges).toEqual(original.exchanges);
  expect(controller.room.session.agents).toEqual(original.agents);
  expect(controller.room.session.paused).toEqual(original.paused);
  await controller.submit('/unpin #m2');
  await controller.submit('/pins');
  expect(controller.room.pinnedMessages()).toEqual([]);
  expect(controller.room.session.notices.at(-1)?.text).toContain('No pinned messages');
});

it('keeps pins with their saved conversation and accepts old sessions without pins', async () => {
  await controller.submit('@human Keep this');
  await controller.submit('/pin #m1');
  const id = controller.room.session.id;
  await controller.submit('/new');
  expect(controller.room.pinnedMessages()).toEqual([]);
  await controller.submit('@human Different m1');
  expect(controller.room.session.pinnedMessageIds).toEqual([]);
  await controller.submit('/sessions ' + id);
  expect(controller.room.pinnedMessages().map((message) => message.text)).toEqual(['Keep this']);
  const legacy = store.load()!;
  delete legacy.pinnedMessageIds;
  await controller.submit('/new');
  store.save(legacy);
  await controller.submit('/sessions ' + id);
  expect(controller.room.pinnedMessages()).toEqual([]);
  await controller.submit('/pin #m1');
  expect(store.load()?.pinnedMessageIds).toEqual(['m1']);
});

it('rejects malformed commands and missing message IDs without changing pins', async () => {
  await controller.submit('@human Existing message');
  await controller.submit('/pin #m1');
  const before = structuredClone(controller.room.session);
  for (const line of [
    '/pin',
    '/unpin',
    '/pin #m1 #m2',
    '/unpin #m1 extra',
    '/pin #m01',
    '/pin 1',
    '/pins #m1',
  ])
    await expect(controller.submit(line)).rejects.toThrow('Usage:');
  for (const line of ['/pin #m999', '/unpin #m999'])
    await expect(controller.submit(line)).rejects.toThrow('Unknown message #m999');
  expect(controller.room.session).toEqual(before);
  expect(complete(base, [], '/pi', 3).suggestions).toEqual(['/pin ', '/pins ']);
  expect(complete(base, [], '/un', 3).suggestions).toEqual(['/unpin ']);
});

it.each([['m999'], ['m1', 'm1'], ['#m1'], [42], 'm1', null].map((pins) => ({ pins })))(
  'refuses invalid persisted pins without overwriting the session: $pins',
  async ({ pins }) => {
    await controller.submit('@human Preserve history');
    const saved = store.load()!;
    const path = join(store.directory, saved.id, 'session.json');
    const corrupt = JSON.stringify({ ...saved, pinnedMessageIds: pins });
    writeFileSync(path, corrupt);
    expect(() => store.load(saved.id)).toThrow(/invalid/i);
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
  },
);
