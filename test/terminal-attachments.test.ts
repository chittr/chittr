import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RoomController } from '../src/controller.js';
import { Room } from '../src/room.js';
import { SessionStore } from '../src/store.js';
import { TerminalAttachments } from '../src/ui/terminal-attachments.js';
import {
  parseAttachmentAction,
  completeAttachmentAction,
  readAttachmentPath,
  attachmentLabel,
} from '../src/ui/attachment-input.js';
import { transcript } from '../src/ui/terminal.js';
import { projectRoom } from '../src/snapshot.js';
import { complete } from '../src/completion.js';
import { readClipboardImage } from '../src/ui/clipboard.js';
import { paddedPng, tinyPng } from './image-fixture.js';

vi.mock('node:fs/promises', { spy: true });

let root: string,
  workspace: string,
  store: SessionStore,
  controller: RoomController,
  terminal: TerminalAttachments;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'terminal-images-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace);
  store = new SessionStore(workspace, join(root, 'state'));
  store.acquire();
  controller = new RoomController(
    {
      workspace,
      permissions: { edits: false, commands: false, network: false },
      sources: [],
      provenance: {},
      agents: {},
      followUpTurns: 8,
    },
    store,
    undefined,
    { help: 'Shared help', quit: async () => {} },
  );
  terminal = new TerminalAttachments(controller, workspace);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await controller.close();
  store.release();
  rmSync(root, { recursive: true, force: true });
});
const file = (name = 'photo one.png') => {
  const path = join(workspace, name);
  writeFileSync(path, tinyPng());
  return path;
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it('round-trips literal paths and terminal completion, including spaces, quotes, options and explicit symlinks', async () => {
  const paths = [
    file(),
    file('quote"slash\\.png'),
    file('--list'),
    file(' leading trailing '),
    file('$(touch SENTINEL).png'),
  ];
  symlinkSync(paths[0]!, join(workspace, 'linked.png'));
  for (const path of paths) {
    expect(parseAttachmentAction('/attach ' + JSON.stringify(path))).toEqual({
      kind: 'path',
      path,
    });
    expect((await readAttachmentPath(path, workspace)).bytes).toEqual(tinyPng());
  }
  expect(parseAttachmentAction('/attach photo one.png')).toEqual({
    kind: 'path',
    path: 'photo one.png',
  });
  expect(parseAttachmentAction('/attach -- --list')).toEqual({ kind: 'path', path: '--list' });
  expect(parseAttachmentAction('/attach --verbose')).toEqual({ kind: 'path', path: '--verbose' });
  for (const input of ['~/photo.png', 'photo\\ one.png', '"unfinished'])
    expect(() => parseAttachmentAction('/attach ' + input)).toThrow(/quoted|JSON/);
  for (const prefix of [
    '/attach ',
    '/attach ./',
    '/attach ' + workspace + '/',
    '/attach "./photo',
  ]) {
    const suggestions = await completeAttachmentAction(prefix, workspace, []);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      const parsed = parseAttachmentAction(suggestion);
      expect(parsed.kind).toBe('path');
      if (parsed.kind === 'path')
        expect((await readAttachmentPath(parsed.path, workspace)).bytes).toEqual(tinyPng());
    }
  }
  expect(await completeAttachmentAction('/attach link', workspace, [])).toEqual([
    '/attach "linked.png"',
  ]);
  expect(await completeAttachmentAction('/attach --c', workspace, [])).toEqual([
    '/attach --clipboard',
  ]);
  expect(complete(workspace, [], '/attach ./', 10)).toEqual({ start: 10, suggestions: [] });
  expect(complete(workspace, [], '@human ./', 9).suggestions.join()).not.toContain('linked.png');
  expect(() => readFileSync(join(workspace, 'SENTINEL'))).toThrow();
});

it('stages absolute, relative and symlink paths; removes by host ID; sends copied bytes after source deletion', async () => {
  const room = controller.room;
  room.send('@human parent');
  room.saveDraft('/reply #m1 caption');
  const path = file();
  symlinkSync(path, join(workspace, 'link.png'));
  for (const input of [JSON.stringify(path), 'photo one.png', 'link.png'])
    await terminal.action('/attach ' + input, room);
  expect(room.session.composerDraft).toBe('/reply #m1 caption');
  expect(room.session.messages).toHaveLength(1);
  const [first, second, third] = room.session.composerAttachments!;
  expect(await terminal.action('/attach --list', room)).toContain(first!.id);
  expect(
    await completeAttachmentAction(
      '/attach --remove att-',
      workspace,
      room.session.composerAttachments!,
    ),
  ).toContain('/attach --remove ' + second!.id);
  await terminal.action('/attach --remove ' + second!.id, room);
  unlinkSync(path);
  unlinkSync(join(workspace, 'link.png'));
  await terminal.send('/reply #m1 caption', room);
  const message = room.session.messages.at(-1)!;
  expect(message.replyTo).toEqual(['m1']);
  expect(message.text).toBe('caption');
  expect(message.recipients).toEqual(['human']);
  expect(message.attachments?.map((a) => a.id)).toEqual([first!.id, third!.id]);
  expect(store.attachmentAccess(room.session.id).resolve(first!.id).bytes).toEqual(tinyPng());
  expect(store.load(room.session.id)?.messages.at(-1)?.attachmentOperation).toEqual(
    message.attachmentOperation,
  );
  const saved = JSON.stringify(store.load(room.session.id));
  expect(saved).not.toContain(path);
  expect(saved).not.toContain(tinyPng().toString('base64'));
  expect(room.session.composerAttachments).toEqual([]);
  expect(room.session.composerDraft).toBe('');
});

it('rejects missing, unreadable, nonregular, malformed and over-limit sources without accepting references', async () => {
  const room = controller.room;
  room.saveDraft('keep caption');
  writeFileSync(join(workspace, 'bad.png'), 'not png');
  // A complete, valid PNG one byte over the per-image limit.
  writeFileSync(join(workspace, 'huge.png'), paddedPng(3 * 1024 * 1024 + 1));
  execFileSync('/usr/bin/mkfifo', [join(workspace, 'pipe')]);
  for (const path of ['missing', '.', 'pipe', 'bad.png'])
    await expect(terminal.action('/attach ' + path, room)).rejects.toThrow();
  await expect(terminal.action('/attach huge.png', room)).rejects.toThrow(
    'Image exceeds the 3 MiB per-image limit.',
  );
  const denied = Object.assign(new Error('secret path'), { code: 'EACCES' });
  vi.spyOn(fs, 'open').mockRejectedValueOnce(denied);
  await expect(readAttachmentPath(file(), workspace)).rejects.toThrow('EACCES');
  expect(room.session.composerAttachments ?? []).toEqual([]);
  expect(room.session.composerDraft).toBe('keep caption');
});

it('stages a PNG of exactly the 3 MiB per-image limit through /attach', async () => {
  const largest = paddedPng(3 * 1024 * 1024);
  expect(largest.length).toBe(3_145_728);
  writeFileSync(join(workspace, 'largest.png'), largest);
  const read = await readAttachmentPath('largest.png', workspace);
  expect(read.bytes.equals(largest)).toBe(true);
  const room = controller.room;
  await expect(terminal.action('/attach largest.png', room)).resolves.toContain('3145728 bytes');
  expect(room.session.composerAttachments).toEqual([
    expect.objectContaining({ filename: 'largest.png', byteSize: 3_145_728 }),
  ]);
});

it('bounds growing reads, detects replacement, and closes the selected handle on error and cancellation', async () => {
  const path = file();
  const realOpen = fs.open;
  let close = vi.fn(),
    total = 0;
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args);
    const originalClose = handle.close.bind(handle);
    close = vi.fn(originalClose);
    handle.close = close;
    handle.read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      buffer.fill(1, offset, offset + length);
      total += length;
      return { bytesRead: length, buffer };
    }) as unknown as typeof handle.read;
    return handle;
  });
  await expect(readAttachmentPath(path, workspace)).rejects.toThrow(
    'Image exceeds the 3 MiB per-image limit.',
  );
  expect(total).toBe(3 * 1024 * 1024 + 1);
  expect(close).toHaveBeenCalledOnce();
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = (async (...readArgs: Parameters<typeof read>) => {
      const result = await read(...readArgs);
      unlinkSync(path);
      writeFileSync(path, tinyPng());
      return result;
    }) as unknown as typeof handle.read;
    return handle;
  });
  await expect(readAttachmentPath(path, workspace)).rejects.toThrow('changed');
  const abort = new AbortController();
  abort.abort();
  await expect(readAttachmentPath(path, workspace, abort.signal)).rejects.toThrow();
});

it('does not stage into another room or overwrite later accepted drafts after delayed reads or staging', async () => {
  const room = controller.room;
  room.saveDraft('original');
  const read = deferred<Awaited<ReturnType<typeof readAttachmentPath>>>();
  terminal = new TerminalAttachments(controller, workspace, {
    file: () => read.promise,
    clipboard: readClipboardImage,
  });
  const action = terminal.action('/attach outside.png', room);
  await controller.submit('/new', room.session.id);
  controller.room.saveDraft('new room');
  read.resolve({ bytes: Buffer.from(tinyPng()), filename: 'fixture.png' });
  await expect(action).rejects.toThrow('Conversation changed');
  expect(controller.room.session.composerDraft).toBe('new room');
  expect(controller.room.session.composerAttachments ?? []).toEqual([]);
  const active = controller.room;
  const pending = deferred<Awaited<ReturnType<RoomController['stageAttachment']>>>();
  const stage = controller.stageAttachment.bind(controller);
  vi.spyOn(controller, 'stageAttachment').mockImplementationOnce(async (input) => {
    const value = await stage(input);
    await pending.promise;
    return value;
  });
  terminal = new TerminalAttachments(controller, workspace);
  const delayed = terminal.action('/attach ' + file(), active);
  await vi.waitFor(() => expect(controller.stageAttachment).toHaveBeenCalled());
  active.saveDraft('later edit');
  pending.resolve(undefined as never);
  await expect(delayed).rejects.toThrow('Draft changed');
  expect(active.session.composerDraft).toBe('later edit');
  expect(active.session.composerAttachments ?? []).toEqual([]);
});

it('rejects stale removal without resurrecting another writer references', async () => {
  const room = controller.room;
  await terminal.action('/attach ' + file(), room);
  const id = room.session.composerAttachments![0]!.id;
  const update = controller.updateDraft.bind(controller);
  const gate = deferred<void>();
  vi.spyOn(controller, 'updateDraft').mockImplementationOnce(async (...args) => {
    await gate.promise;
    return update(...args);
  });
  const removal = terminal.action('/attach --remove ' + id, room);
  room.saveDraft('later');
  gate.resolve();
  await expect(removal).rejects.toThrow('Draft changed');
  expect(room.session.composerAttachments?.[0]?.id).toBe(id);
  expect(room.session.composerDraft).toBe('later');
});

it('restores durable drafts after restart and reconciles lost send acknowledgements without duplication', async () => {
  await terminal.action('/attach ' + file(), controller.room);
  controller.room.saveDraft('@human caption');
  const sessionId = controller.room.session.id;
  await controller.close();
  const session = store.load(sessionId)!;
  controller = new RoomController(controller.room.config, store, session, {
    help: '',
    quit: async () => {},
  });
  terminal = new TerminalAttachments(controller, workspace);
  const room = controller.room;
  const id = room.session.composerAttachments![0]!.id;
  const submit = controller.submit.bind(controller);
  vi.spyOn(controller, 'submit').mockImplementationOnce(async (...args) => {
    await submit(...args);
    throw new Error('lost acknowledgement');
  });
  await terminal.send(room.session.composerDraft!, room);
  expect(room.session.messages).toHaveLength(1);
  expect(room.session.messages[0]?.attachments?.[0]?.id).toBe(id);
  const operation = room.session.messages[0]!.attachmentOperation!.id;
  await submit('@human caption', sessionId, { attachmentIds: [id], operationId: operation });
  expect(room.session.messages).toHaveLength(1);
  room.saveDraft({
    text: '',
    attachmentIds: [id],
    baseRevision: room.session.composerDraftRevision,
  });
  await terminal.send('', room);
  expect(room.session.messages).toHaveLength(2);
  expect(room.session.messages[1]!.attachmentOperation!.id).not.toBe(operation);
  expect(room.session.messages[1]!.text).toBe('');
  expect(room.session.messages[1]!.recipients).toEqual([]);
});

it('retains failed send identity and draft; rejects a delayed send against later edits', async () => {
  const room = controller.room;
  await terminal.action('/attach ' + file(), room);
  room.saveDraft('caption');
  const submit = controller.submit.bind(controller);
  const calls: string[] = [];
  vi.spyOn(controller, 'submit').mockImplementation(async (...args) => {
    calls.push(args[2]!.operationId!);
    if (calls.length === 1) throw new Error('indeterminate');
    return submit(...args);
  });
  await expect(terminal.send('caption', room)).rejects.toThrow('indeterminate');
  expect(room.session.composerDraft).toBe('caption');
  expect(room.session.composerAttachments).toHaveLength(1);
  await terminal.send('caption', room);
  expect(calls[0]).toBe(calls[1]);
  expect(room.session.messages).toHaveLength(1);
  await terminal.action('/attach ' + file(), room);
  const gate = deferred<void>();
  vi.mocked(controller.submit).mockImplementationOnce(async (...args) => {
    await gate.promise;
    return submit(...args);
  });
  const sending = terminal.send('', room);
  room.saveDraft('later edit');
  gate.resolve();
  await expect(sending).rejects.toThrow('Draft changed');
  expect(room.session.composerDraft).toBe('later edit');
  expect(room.session.composerAttachments).toHaveLength(1);
  expect(room.session.messages).toHaveLength(1);
});

it('acknowledges committed send A after host draft B is accepted, without restoring over or clearing B', async () => {
  const room = controller.room;
  await terminal.action('/attach ' + file(), room);
  room.saveDraft('A');
  const first = room.session.composerAttachments![0]!;
  const second = await controller.stageAttachment({
    sessionId: room.session.id,
    operationId: randomUUID(),
    filename: 'second.png',
    mediaType: 'image/png',
    bytes: tinyPng(),
  });
  const submit = controller.submit.bind(controller);
  const operations: string[] = [];
  vi.spyOn(controller, 'submit').mockImplementationOnce(async (...args) => {
    operations.push(args[2]!.operationId!);
    await submit(...args);
    room.saveDraft({
      text: 'B',
      attachmentIds: [second.id],
      baseRevision: room.session.composerDraftRevision,
    });
    throw new Error('lost acknowledgement');
  });
  const revision = room.session.composerDraftRevision!;
  const result = await terminal.send('A', room);
  expect(result.dispatch).toMatchObject({ status: 'failed', error: 'lost acknowledgement' });
  expect(result.commitment).toEqual({ status: 'committed', operationId: operations[0] });
  expect(result.recovery).toEqual({ status: 'skipped', reason: 'ineligible' });
  expect(room.session.messages).toHaveLength(1);
  expect(room.session.messages[0]).toMatchObject({
    text: 'A',
    attachments: [first],
    attachmentOperation: { id: operations[0] },
  });
  expect(room.session.composerDraft).toBe('B');
  expect(room.session.composerAttachments).toEqual([second]);
  expect(room.session.composerDraftRevision).toBe(revision + 2);
  vi.mocked(controller.submit).mockImplementation((...args) => {
    operations.push(args[2]!.operationId!);
    return submit(...args);
  });
  await terminal.send('B', room);
  expect(operations).toHaveLength(2);
  expect(operations[1]).not.toBe(operations[0]);
  expect(room.session.messages).toHaveLength(2);
  expect(room.session.messages[1]).toMatchObject({ text: 'B', attachments: [second] });
});

it('uses shared captionless reply inheritance and explicit overrides, and keeps question/literal commands unchanged', async () => {
  const room = controller.room;
  room.send('@human parent');
  for (const line of ['/reply #m1', '/reply #m1 @human']) {
    await terminal.action('/attach ' + file(), room);
    room.saveDraft(line);
    await terminal.send(line, room);
    expect(room.session.messages.at(-1)?.replyTo).toEqual(['m1']);
    expect(room.session.messages.at(-1)?.recipients).toEqual(['human']);
  }
  await expect(controller.submit('')).rejects.toThrow();
  await controller.submit('//attach literal.png');
  expect(room.session.messages.at(-1)?.text).toBe('/attach literal.png');
  await expect(controller.submit('/attach secret.png')).rejects.toThrow('Unknown command /attach');
  expect(room.session.composerAttachments).toEqual([]);
});

it('renders escaped bounded metadata with full IDs and no bytes or source paths', async () => {
  const room = controller.room;
  await terminal.action('/attach ' + file('escape\u202e.png'), room);
  const metadata = room.session.composerAttachments![0]!;
  expect(attachmentLabel({ ...metadata, filename: 'escape\x1b[2J.png' })).not.toContain('\x1b');
  expect(attachmentLabel(metadata)).toContain('\\u202e');
  await terminal.send('', room);
  const display = transcript(projectRoom(room), 24)
    .map((l) => l.text)
    .join('\n');
  expect(display).not.toContain('\x1b[2J');
  expect(display).not.toContain(workspace);
  expect(display).not.toContain(tinyPng().toString('base64'));
});
