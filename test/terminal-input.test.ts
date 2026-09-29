import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomController } from '../src/controller.js';
import { Room } from '../src/room.js';
import { SessionStore } from '../src/store.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { TerminalAttachments } from '../src/ui/terminal-attachments.js';
import { projectRoom } from '../src/snapshot.js';
import type { Key } from '../src/ui/input.js';
import type {
  AdapterEvent,
  AgentAdapter,
  AgentConfig,
  AttachmentMetadata,
  RoomConfig,
  TurnInput,
  TurnResult,
} from '../src/types.js';

vi.mock('../src/snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/snapshot.js')>();
  return { ...actual, projectRoom: vi.fn(actual.projectRoom) };
});

class Fake implements AgentAdapter {
  async start(id?: string) {
    return { sessionId: id ?? 'native', restored: false };
  }
  run(_input: TurnInput, _event: (e: AdapterEvent) => void, signal: AbortSignal) {
    return new Promise<TurnResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
    });
  }
  async interrupt() {}
  async close() {}
}
/** Narrow test-only view of the private input state; no public terminal API is added. */
type Internals = {
  value: string;
  cursor: number;
  suggestions: string[];
  selection?: unknown;
  mounted: boolean;
  feedback?: string;
  action?: { cursor: number; abort: AbortController; dispatched?: boolean };
  key(key: Key): void;
  complete(automatic?: boolean): void;
  paint(output: string[]): void;
};
const internals = (ui: TerminalUI) => ui as unknown as Internals;
const agent = (id: string, enabled = true): AgentConfig => ({
  id,
  provider: 'codex',
  enabled,
  instructions: '',
  fingerprint: id,
});
const attachment = (id: string): AttachmentMetadata => ({
  id: `att-${id.repeat(32)}`,
  filename: `${id}.png`,
  mediaType: 'image/png',
  byteSize: 10,
  width: 1,
  height: 1,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let root: string, workspace: string, store: SessionStore, controller: RoomController;
let ui: TerminalUI, rooms: Room[], read: ReturnType<typeof vi.fn<() => Promise<string>>>;
const config = (overrides: Partial<RoomConfig> = {}): RoomConfig => ({
  workspace,
  permissions: { edits: false, commands: false, network: false },
  agents: { codex: agent('codex'), claude: agent('claude') },
  followUpTurns: 8,
  sources: [],
  provenance: {},
  ...overrides,
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'terminal-input-'));
  workspace = join(root, 'project');
  mkdirSync(workspace);
  store = new SessionStore(workspace, join(root, 'state'));
  store.acquire();
  rooms = [];
  controller = new RoomController(config(), store, undefined, {
    help: '',
    quit: async () => {},
    createRoom: (cfg, persistence, session) => {
      const room = new Room(cfg, persistence, session, () => new Fake());
      rooms.push(room);
      return room;
    },
  });
  read = vi.fn(async () => 'clipboard text');
  ui = new TerminalUI(
    controller.room,
    (line, sessionId) => controller.submitDraft({ source: 'terminal-text', line, sessionId }),
    async () => {},
    { write: async () => {}, read },
    new TerminalAttachments(controller, workspace),
  );
  // Input is exercised without mount(); draws stay suppressed for the whole file.
  ui.draw = () => {};
  vi.mocked(projectRoom).mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await controller.close();
  store.release();
  rmSync(root, { recursive: true, force: true });
});
const press = (name: string, text?: string) => internals(ui).key({ name, text });
const type = (text: string) => press('text', text);
/**
 * Sentinels for work a narrow read must not do. Room's own operations (reload,
 * persistence, sends) legitimately touch these, so each check observes only the
 * window between `reset()` and the assertion: one input action.
 */
function forbidden(room: Room) {
  const reads: (string | symbol)[] = [];
  room.session.messages = new Proxy(room.session.messages, {
    get(target, property, receiver) {
      reads.push(property);
      return Reflect.get(target, property, receiver);
    },
  });
  const spies = {
    pending: vi.spyOn(room, 'pending'),
    support: vi.spyOn(room, 'initialImageSupport'),
    idle: vi.spyOn(room, 'isIdle'),
  };
  return {
    reads,
    reset() {
      reads.length = 0;
      for (const spy of Object.values(spies)) spy.mockClear();
      vi.mocked(projectRoom).mockClear();
    },
    none(historyReads = false) {
      if (!historyReads) expect(reads).toEqual([]);
      expect(spies.pending).not.toHaveBeenCalled();
      expect(spies.support).not.toHaveBeenCalled();
      expect(spies.idle).not.toHaveBeenCalled();
      expect(projectRoom).not.toHaveBeenCalled();
    },
  };
}

it('completes from the current enabled set at Tab time, before and after reload, without projecting', async () => {
  const room = controller.room;
  const spies = forbidden(room);
  type('@c');
  spies.reset();
  press('tab');
  expect(internals(ui).suggestions).toEqual(['@codex ', '@claude ']);
  spies.none();
  press('escape');
  await room.reload(
    config({
      humanName: 'Zoë',
      agents: { cortex: agent('cortex'), claude: agent('claude', false), codex: agent('codex') },
    }),
  );
  spies.reset();
  press('tab');
  expect(internals(ui).suggestions).toEqual(['@cortex ', '@codex ']);
  spies.none();
});

it('uses the reloaded human name and the borrowed messages when moving vertically', async () => {
  const room = controller.room;
  const spies = forbidden(room);
  type('a'.repeat(70));
  spies.reset();
  press('up');
  expect(internals(ui).cursor).toBe(70);
  expect(internals(ui).value).toBe('a'.repeat(70));
  spies.none(true);
  await room.reload(config({ humanName: 'Zoë the Magnificent' }));
  spies.reset();
  press('up');
  // The wider prefix wraps the same text onto two rows, so Up moves within the draft.
  expect(internals(ui).cursor).toBe(12);
  spies.none();
  press('end');
  press('escape');
  room.send('@codex hello there');
  press('clear-line');
  spies.reset();
  press('up');
  expect(internals(ui).value).toBe('@codex hello there');
  // Normal history traversal reads the borrowed messages; nothing else is derived.
  expect(spies.reads).toContain('filter');
  spies.none(true);
});

it('completes attachment actions from the current staged list and keeps stale-result guards', async () => {
  const room = controller.room;
  const spies = forbidden(room);
  room.session.composerAttachments = [attachment('a'), attachment('b')];
  press('attachments');
  expect(internals(ui).action).toBeDefined();
  type('--remove ');
  spies.reset();
  internals(ui).complete();
  await flush();
  expect(internals(ui).suggestions).toEqual([
    `/attach --remove ${attachment('a').id}`,
    `/attach --remove ${attachment('b').id}`,
  ]);
  spies.none();
  room.session.composerAttachments = [attachment('c')];
  spies.reset();
  internals(ui).complete();
  await flush();
  expect(internals(ui).value).toBe(`/attach --remove ${attachment('c').id}`);
  spies.none();
  internals(ui).value = '/attach --remove ';
  internals(ui).cursor = internals(ui).value.length;
  internals(ui).suggestions = [];
  internals(ui).complete();
  internals(ui).value = '/attach --remove x';
  await flush();
  expect(internals(ui).suggestions).toEqual([]);
  internals(ui).value = '/attach --remove ';
  internals(ui).complete();
  await controller.submit('/new');
  ui.setRoom(controller.room);
  await flush();
  expect(internals(ui).suggestions).toEqual([]);
  expect(internals(ui).action).toBeUndefined();
});

it('clears a held selection on input and reads current facts before any new frame', () => {
  const paint = vi.spyOn(internals(ui), 'paint');
  internals(ui).selection = { text: () => 'held text', dragging: false };
  type('@');
  press('tab');
  expect(internals(ui).selection).toBeUndefined();
  expect(internals(ui).suggestions).toEqual(['@human ', '@codex ', '@claude ']);
  expect(paint).not.toHaveBeenCalled();
  expect(projectRoom).not.toHaveBeenCalled();
});

it.each(['success', 'error'])(
  'discards a stale clipboard %s after a room switch and keeps the new draft',
  async (outcome) => {
    internals(ui).mounted = true;
    let settle!: (value: string) => void, fail!: (error: Error) => void;
    read.mockReturnValueOnce(
      new Promise<string>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
    );
    type('old');
    press('clipboard-paste');
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await controller.submit('/new');
    ui.setRoom(controller.room);
    type('new room');
    if (outcome === 'success') settle('stale clipboard');
    else fail(new Error('stale error'));
    await flush();
    expect(internals(ui).value).toBe('new room');
    expect(controller.room.session.composerDraft).toBe('new room');
    expect(internals(ui).feedback).toBeUndefined();
  },
);
