import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { TerminalAttachments } from '../src/ui/terminal-attachments.js';
import { tinyPng } from './image-fixture.js';

let root: string, store: SessionStore, controller: RoomController, ui: TerminalUI;
let stdin: EventEmitter, output: string;
let read: ReturnType<typeof vi.fn<() => Promise<string>>>;
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const feed = (value: string) => stdin.emit('data', Buffer.from(value));
const frame = () => output.split('\x1b[?25l\x1b[H').at(-1)!;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'terminal-ui-'));
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'fixture.png'), tinyPng());
  store = new SessionStore(workspace, join(root, 'state'));
  store.acquire();
  controller = new RoomController(
    {
      workspace,
      permissions: { edits: false, commands: false, network: false },
      agents: {},
      sources: [],
      provenance: {},
      followUpTurns: 8,
    },
    store,
    undefined,
    { help: '', quit: async () => {} },
  );
  stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  output = '';
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 96,
    rows: 28,
    write: (text: string) => {
      output += text;
      return true;
    },
  });
  vi.stubGlobal('process', { ...process, stdin, stdout });
  read = vi.fn(async () => 'clipboard text');
  ui = new TerminalUI(
    controller.room,
    (line, sessionId) => controller.submitDraft({ source: 'terminal-text', line, sessionId }),
    async () => {},
    { write: async () => {}, read },
    new TerminalAttachments(controller, workspace),
  );
  controller.on('room', (room) => ui.setRoom(room));
  ui.mount();
});
afterEach(async () => {
  ui.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await controller.close();
  store.release();
  rmSync(root, { recursive: true, force: true });
});

it.each(['success', 'error'])(
  'ignores delayed clipboard %s after switching rooms',
  async (outcome) => {
    const pending = deferred<string>();
    read.mockReturnValueOnce(pending.promise);
    feed('old\x16');
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await controller.submit('/new');
    feed('new room');
    if (outcome === 'success') pending.resolve('stale clipboard');
    else pending.reject(new Error('stale error'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(controller.room.session.composerDraft).toBe('new room');
    expect(frame()).not.toContain('stale');
  },
);
it('retains the draft/cursor guard on successful text paste and does not paste into a newly opened attachment input', async () => {
  const pending = deferred<string>();
  read.mockReturnValueOnce(pending.promise);
  feed('caption\x16');
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  feed('\x1b[D');
  pending.resolve('wrong cursor');
  await vi.waitFor(() => expect(frame()).toContain('Draft changed while reading clipboard'));
  expect(controller.room.session.composerDraft).toBe('caption');
  const next = deferred<string>();
  read.mockReturnValueOnce(next.promise);
  feed('\x16');
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  feed('\x0f');
  next.resolve('wrong input');
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(frame()).not.toContain('wrong input');
  expect(controller.room.session.composerDraft).toBe('caption');
});
it('reconciles external draft changes on the screen without persisting attachment action text', async () => {
  feed('/reply #m1 caption\x0fmissing');
  controller.room.saveDraft('accepted elsewhere');
  feed('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 45));
  expect(frame()).toContain('accepted elsewhere');
  expect(controller.room.session.composerDraft).toBe('accepted elsewhere');
  feed('\x0ffixture.png\r');
  await vi.waitFor(() => expect(controller.room.session.composerAttachments).toHaveLength(1));
  expect(controller.room.session.composerDraft).toBe('accepted elsewhere');
});
it('does not prepend failed old sends or clear later text in the newly selected room', async () => {
  const pending = deferred<void>();
  vi.spyOn(controller, 'submit').mockReturnValueOnce(pending.promise);
  feed('old send\r');
  await controller.submit('/new');
  feed('new caption');
  pending.reject(new Error('old failure'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(controller.room.session.composerDraft).toBe('new caption');
  expect(frame()).not.toContain('old failure');
});
it('sends image-only from Enter and history recall never restages the attachment', async () => {
  feed('\x0ffixture.png\r');
  await vi.waitFor(() => expect(controller.room.session.composerAttachments).toHaveLength(1));
  await vi.waitFor(() => expect(frame()).not.toContain('Attach ›'));
  feed('\r');
  await vi.waitFor(() => expect(controller.room.session.messages).toHaveLength(1));
  const id = controller.room.session.messages[0]!.attachments![0]!.id;
  expect(store.load()?.messages[0]?.attachments?.[0]?.id).toBe(id);
  feed('\x1b[A');
  expect(controller.room.session.composerAttachments).toEqual([]);
  feed('\r');
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(controller.room.session.messages).toHaveLength(1);
});

it('renders grouped staged-image warnings immediately after staged attachments', async () => {
  controller.room.config.agents = {
    claude: {
      id: 'claude',
      provider: 'claude',
      enabled: true,
      instructions: '',
      fingerprint: 'claude',
    },
    antigravity: {
      id: 'antigravity',
      provider: 'antigravity',
      enabled: true,
      instructions: '',
      fingerprint: 'antigravity',
    },
  };
  vi.spyOn(controller.room, 'initialImageSupport').mockImplementation((id) =>
    id === 'claude'
      ? {
          available: false,
          status: 'not_observed',
          reason: 'Claude model has not been observed',
        }
      : {
          available: false,
          status: 'unsupported',
          reason: 'Antigravity images are unsupported',
        },
  );
  feed('@claude @antigravity compare');
  expect(frame()).not.toContain('Image status warning');
  feed('\x0ffixture.png\r');
  await vi.waitFor(() => expect(controller.room.session.composerAttachments).toHaveLength(1));
  await vi.waitFor(() => expect(frame()).toContain('Image status warning'));
  const rendered = frame();
  expect(rendered).toContain('Not observed: @claude: Claude model has not been observed');
  expect(rendered).toContain('Unsupported:');
  expect(rendered).toContain('@antigravity: Antigravity images are unsupported');
  expect(rendered.indexOf('Staged att-')).toBeLessThan(rendered.indexOf('Image status warning'));
  vi.mocked(controller.room.initialImageSupport).mockReturnValue({
    available: true,
    status: 'available',
  });
  feed(' ');
  expect(frame()).not.toContain('Image status warning');
});

it('keeps staged-image warning recipients tied to the composer while attachment input is open', async () => {
  controller.room.config.agents = {
    codex: {
      id: 'codex',
      provider: 'codex',
      enabled: true,
      instructions: '',
      fingerprint: 'codex',
    },
  };
  vi.spyOn(controller.room, 'initialImageSupport').mockReturnValue({
    available: false,
    status: 'unsupported',
    reason: 'Codex images are unsupported',
  });
  feed('@human here\x0ffixture.png\r');
  await vi.waitFor(() => expect(controller.room.session.composerAttachments).toHaveLength(1));
  await vi.waitFor(() => expect(frame()).not.toContain('Attach ›'));
  expect(frame()).not.toContain('Image status warning');
  feed('\x0f' + '\x7f'.repeat('/attach '.length) + 'shot.png');
  expect(frame()).toContain('shot.png');
  expect(frame()).toContain('Attachment input');
  expect(frame()).not.toContain('Image status warning');
  feed('\x1b');
});

it('clears text commands before switching and restores a failed text command only into its unchanged draft', async () => {
  const original = controller.room.session.id;
  feed('/new\r');
  await vi.waitFor(() => expect(controller.room.session.id).not.toBe(original));
  expect(store.load(original)?.composerDraft).toBe('');
  feed('/unknown\r');
  await vi.waitFor(() => expect(controller.room.session.composerDraft).toBe('/unknown'));
  feed(' suffix');
  expect(controller.room.session.composerDraft).toBe('/unknown suffix');
});

it('invalidates old command/file completions when an authoritative caption replaces their input', async () => {
  feed('/\t');
  expect(frame()).toContain('/pause');
  controller.room.saveDraft('new caption');
  feed('\r');
  await vi.waitFor(() => expect(controller.room.session.messages).toHaveLength(1));
  expect(controller.room.session.messages[0]!.text).toBe('new caption');
  feed('./');
  expect(frame()).toContain('File explorer');
  controller.room.saveDraft('accepted file caption');
  expect(frame()).not.toContain('File explorer');
  feed('\r');
  await vi.waitFor(() => expect(controller.room.session.messages).toHaveLength(2));
  expect(controller.room.session.messages[1]!.text).toBe('accepted file caption');
});

it('replaces the entire quoted path on Tab and keeps directory edits inside the closing quote', async () => {
  const workspace = controller.room.config.workspace;
  mkdirSync(join(workspace, 'folder'));
  writeFileSync(join(workspace, 'folder', 'photo one.png'), tinyPng());
  feed('retained caption\x0f"./fi"\x1b[D\t');
  await vi.waitFor(() => expect(frame()).toContain('/attach "./fixture.png"'));
  expect(frame()).not.toContain('fixture.png""');
  feed('\r');
  await vi.waitFor(() => expect(controller.room.session.composerAttachments).toHaveLength(1));
  feed('\x0f./fol\t');
  await vi.waitFor(() => expect(frame()).toContain('/attach "./folder/"'));
  feed('pho\t');
  await vi.waitFor(() => expect(frame()).toContain('/attach "./folder/photo one.png"'));
  feed('\r');
  await vi.waitFor(() => expect(controller.room.session.composerAttachments).toHaveLength(2));
  expect(controller.room.session.composerDraft).toBe('retained caption');
});

it.each([false, true])(
  'shows the eventual dispatched removal outcome after Esc, later edit=%s',
  async (edit) => {
    feed('caption\x0ffixture.png\r');
    await vi.waitFor(() => expect(controller.room.session.composerAttachments).toHaveLength(1));
    await vi.waitFor(() => expect(frame()).not.toContain('Attach ›'));
    const id = controller.room.session.composerAttachments![0]!.id;
    const update = controller.updateDraft.bind(controller),
      gate = deferred<void>();
    const spy = vi.spyOn(controller, 'updateDraft').mockImplementationOnce(async (...args) => {
      await gate.promise;
      return update(...args);
    });
    feed('\x0f--remove ' + id + '\r');
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    feed('\x1b');
    await vi.waitFor(() => expect(frame()).toContain('input dismissed'));
    expect(controller.room.session.composerAttachments).toHaveLength(1);
    if (edit) feed(' later');
    gate.resolve();
    if (edit) {
      await vi.waitFor(() => expect(frame()).toContain('Attachment error: Draft changed'));
      expect(controller.room.session.composerAttachments![0]!.id).toBe(id);
      expect(controller.room.session.composerDraft).toBe('caption later');
    } else {
      await vi.waitFor(() => expect(frame()).toContain('Image removed from draft'));
      expect(controller.room.session.composerAttachments).toEqual([]);
      expect(controller.room.session.composerDraft).toBe('caption');
    }
  },
);

it('cancels ingestion before dispatch without accepting or resurrecting its staged reference', async () => {
  const stage = controller.stageAttachment.bind(controller),
    gate = deferred<void>();
  const spy = vi.spyOn(controller, 'stageAttachment').mockImplementationOnce(async (input) => {
    const result = await stage(input);
    await gate.promise;
    return result;
  });
  feed('caption\x0ffixture.png\r');
  await vi.waitFor(() => expect(spy).toHaveBeenCalled());
  feed('\x1b');
  await vi.waitFor(() => expect(frame()).not.toContain('Attach ›'));
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(controller.room.session.composerAttachments ?? []).toEqual([]);
  expect(controller.room.session.composerDraft).toBe('caption');
  expect(frame()).not.toContain('Attachment error:');
});
