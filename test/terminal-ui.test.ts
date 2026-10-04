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
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';

let root: string, store: SessionStore, controller: RoomController, ui: TerminalUI;
let stdin: EventEmitter, output: string;
let read: ReturnType<typeof vi.fn<() => Promise<string>>>;
let write: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
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
  write = vi.fn(async (_text: string) => {});
  ui = new TerminalUI(
    controller.room,
    (line, sessionId) => controller.submitDraft({ source: 'terminal-text', line, sessionId }),
    async () => {},
    { write, read },
    new TerminalAttachments(controller, workspace),
  );
  controller.on('room', (room) => ui.setRoom(room));
  ui.mount();
});

const screenLines = () => stripAnsi(frame()).split('\r\n');
const bodyTop = () =>
  screenLines()[2 + Math.ceil(stringWidth('Connecting participants…') / process.stdout.columns)]!;
function draft(source: string) {
  controller.room.session.agents.codex ??= {
    id: 'codex',
    connection: 'ready',
    activity: 'replying',
    paused: false,
    fingerprint: 'fixture',
    draft: '',
    contextThrough: 0,
  };
  controller.room.session.agents.codex.draft = source;
  controller.room.emit('change');
}
function scrollFromStart(steps: number) {
  feed('\x1b[<64;1;4M'.repeat(100));
  feed('\x1b[<65;1;4M'.repeat(steps));
}

it('anchors an unfinished code source line through closing, resize and removal fallback', () => {
  process.stdout.columns = 24;
  process.stdout.rows = 12;
  const source =
    '```ts\nfirst\n  named-code\n' + Array.from({ length: 20 }, (_, i) => `tail ${i}`).join('\n');
  draft(source);
  scrollFromStart(1);
  expect(bodyTop()).toContain('named-code');
  expect(frame()).toContain('History');
  draft(source + '\n```\n\nLater output');
  expect(bodyTop()).toContain('named-code');
  expect(frame()).toContain('History');
  process.stdout.columns = 20;
  process.stdout.emit('resize');
  expect(bodyTop()).toContain('named-code');
  expect(frame()).toContain('History');
  draft('```ts\n```\n\n' + Array.from({ length: 20 }, (_, i) => `after ${i}`).join('\n'));
  expect(bodyTop()).toBe('  ts');
  expect(frame()).toContain('History');
});

it('anchors a named table source row when a later wide cell reflows earlier rows', () => {
  process.stdout.columns = 24;
  process.stdout.rows = 12;
  const table =
    'Intro\n\n| A | B |\n| --- | --- |\n| named | v |\n' +
    Array.from({ length: 20 }, (_, i) => `| later${i} | value |`).join('\n');
  draft(table);
  scrollFromStart(2);
  expect(bodyTop()).toContain('named');
  expect(frame()).toContain('History');
  draft(table + '\n| final | ' + 'wide'.repeat(40) + ' |');
  expect(bodyTop()).toContain('named');
  expect(frame()).toContain('History');
});

it('holds styled selection through incoming output, copies on release and Ctrl+C, and refreshes at its anchor', async () => {
  process.stdout.columns = 24;
  process.stdout.rows = 12;
  const source =
    '```ts\nfirst\n  named-code\n' + Array.from({ length: 20 }, (_, i) => `tail ${i}`).join('\n');
  draft(source);
  scrollFromStart(1);
  const initial = screenLines().slice(0, -1);
  feed('\x1b[<0;1;4M\x1b[<32;24;4M');
  const held = screenLines().slice(0, -1);
  draft(source + '\n```\n\nNew text');
  expect(screenLines().slice(0, -1)).toEqual(held);
  feed('\x1b[<0;24;4m');
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith('  named-code'));
  feed('\x03');
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  feed('\x1b');
  await vi.waitFor(() => expect(bodyTop()).toContain('named-code'));
  expect(frame()).toContain('History');
  expect(screenLines().slice(0, -1)).toEqual(initial);
  feed('**raw composer**');
  expect(controller.room.session.composerDraft).toBe('**raw composer**');
  expect(frame()).toContain('**raw composer**');
  feed('\x1b');
  await vi.waitFor(() => expect(frame()).toContain('Latest'));
  draft(source + '\n```\n\nNewest tail');
  expect(frame()).toContain('Newest tail');
  expect(frame()).toContain('Latest');
});

it('preserves a completed Markdown anchor as later replies arrive and clears selection on resize', async () => {
  process.stdout.columns = 24;
  process.stdout.rows = 12;
  await controller.submit('//**named-message**\n' + 'body\n'.repeat(30));
  scrollFromStart(0);
  // Header is the first row; scroll one page to a source line inside this message.
  feed('\x1b[<65;1;4M');
  const first = bodyTop();
  expect(first).toContain('body');
  expect(frame()).toContain('History');
  await controller.submit('//new reply');
  expect(bodyTop()).toBe(first);
  expect(frame()).toContain('History');
  feed('\x1b[<0;1;4M\x1b[<32;10;4M');
  expect(frame()).toContain('\x1b[30;103m');
  process.stdout.columns = 30;
  process.stdout.emit('resize');
  expect(frame()).not.toContain('\x1b[30;103m');
  expect(bodyTop()).toBe(first);
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

it('renders one short staged-image line per affected recipient after staged attachments', async () => {
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
  expect(frame()).not.toContain("can't receive images");
  feed('\x0ffixture.png\r');
  await vi.waitFor(() => expect(controller.room.session.composerAttachments).toHaveLength(1));
  await vi.waitFor(() => expect(frame()).toContain("@claude can't receive images yet"));
  const rendered = frame();
  expect(rendered).toContain("@antigravity can't receive images");
  expect(rendered).toContain('Ctrl+O, /attach --status for details.');
  // The full reasons stay behind /attach --status.
  expect(rendered).not.toContain('Claude model has not been observed');
  expect(rendered).not.toContain('Antigravity images are unsupported');
  expect(rendered.indexOf('Staged att-')).toBeLessThan(
    rendered.indexOf("@claude can't receive images yet"),
  );
  vi.mocked(controller.room.initialImageSupport).mockReturnValue({
    available: true,
    status: 'available',
  });
  feed(' ');
  expect(frame()).not.toContain("can't receive images");
});

it('prints each recipient image reason with /attach --status, keeping the caption and staged images, and sends nothing', async () => {
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
      ? { available: true, status: 'available' }
      : {
          available: false,
          status: 'unsupported',
          reason: 'Antigravity images are unsupported',
        },
  );
  feed('@claude @antigravity compare these');
  feed('\x0ffixture.png\r');
  await vi.waitFor(() => expect(controller.room.session.composerAttachments).toHaveLength(1));
  await vi.waitFor(() => expect(frame()).toContain("@antigravity can't receive images"));
  const staged = controller.room.session.composerAttachments!.map((a) => a.id);
  const messages = controller.room.session.messages.length;
  feed('\x0f--status\r');
  await vi.waitFor(() =>
    expect(frame()).toContain('@antigravity: Antigravity images are unsupported'),
  );
  expect(frame()).toContain('@claude: can receive images');
  expect(controller.room.session.messages).toHaveLength(messages);
  expect(controller.room.session.composerAttachments!.map((a) => a.id)).toEqual(staged);
  expect(controller.room.session.composerDraft).toBe('@claude @antigravity compare these');
  expect(frame()).toContain('@claude @antigravity compare these');
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

it('opens plan and exact-message views locally and keeps the plan indicator after dismissal', async () => {
  feed('/plan\r');
  await vi.waitFor(() => expect(stripAnsi(frame())).toContain('focus on'));
  expect(controller.room.session.messages).toHaveLength(1);
  expect(controller.room.session.messages[0]!.deliveries).toEqual({});
  feed('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 40));
  await controller.submit('/plan add approach -- Terminal plan content');
  const notices = controller.room.session.notices.length;
  feed('/plan show\r');
  await vi.waitFor(() => expect(stripAnsi(frame())).toContain('Terminal plan content'));
  expect(controller.room.session.notices).toHaveLength(notices);
  feed('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(stripAnsi(frame())).toContain('Plan: focus on');
  feed('/message #m2\r');
  await vi.waitFor(() => expect(stripAnsi(frame())).toContain('#m2'));
  expect(controller.room.session.messages).toHaveLength(2);
  feed('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 40));
  feed('/new\r');
  await vi.waitFor(() => expect(controller.room.session.plan).toBeUndefined());
});
