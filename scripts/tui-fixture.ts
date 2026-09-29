// Deterministic terminal integration fixture. No provider process or model call.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoomController } from '../src/controller.js';
import { TerminalAttachments } from '../src/ui/terminal-attachments.js';
import { tinyPng } from '../test/image-fixture.js';
import { Room } from '../src/room.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, RoomConfig } from '../src/types.js';
const workspace = process.cwd();
writeFileSync(join(workspace, 'sample.txt'), 'completion fixture');
writeFileSync(join(workspace, 'photo one.png'), tinyPng());
const config: RoomConfig = {
  workspace,
  humanName: 'Bill McGlone',
  permissions: { edits: false, commands: false, network: false },
  followUpTurns: 8,
  sources: [],
  provenance: {},
  agents: {
    codex: {
      id: 'codex',
      provider: 'codex',
      enabled: true,
      instructions: '',
      fingerprint: 'fixture',
    },
  },
};
const adapter: AgentAdapter = {
  async start() {
    return { sessionId: 'fixture', restored: false };
  },
  async run(input, event, signal) {
    event({ type: 'received' });
    if (input.messages.some((message) => message.text === 'Selection activity')) {
      // Let the PTY driver establish its selection before this peer streams and
      // completes, regardless of runner speed.
      while (!existsSync(join(process.argv[2]!, 'release-selection-peer'))) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    for (let i = 0; i < 10; i++) {
      if (signal.aborted) throw new Error('Interrupted');
      event({ type: 'activity', activity: 'replying' });
      event({ type: 'text', text: 'Concurrent streamed reply '.repeat(i + 1) });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      outcomes: input.messages.map((message) => ({
        messageIds: [message.id],
        kind: 'reply' as const,
        recipients: ['human'],
        text: 'Completed fixture response.',
      })),
    };
  },
  async interrupt() {},
  async close() {},
};
mkdirSync(process.argv[2]!, { recursive: true });
const store = new SessionStore(workspace, process.argv[2]);
store.acquire();
const controller = new RoomController(config, store, undefined, {
  help: 'Fixture help',
  quit: async () => quit(),
  createRoom: (config, store, session) => new Room(config, store, session, () => adapter),
});
const room = controller.room;
for (let i = 0; i < 30; i++) room.send(`@human History marker ${String(i).padStart(2, '0')}`);
let ui: TerminalUI;
let closed = false;
const quit = async () => {
  if (closed) return;
  closed = true;
  await room.close();
  store.release();
  ui.unmount();
};
ui = new TerminalUI(
  room,
  (line, sessionId) => controller.submitDraft({ source: 'terminal-text', line, sessionId }),
  quit,
  {
    async write(text) {
      if (existsSync(join(process.argv[2]!, 'clipboard-failure')))
        throw new Error('Fixture unavailable');
      writeFileSync(join(process.argv[2]!, 'clipboard.txt'), text);
    },
    async read() {
      if (existsSync(join(process.argv[2]!, 'clipboard-failure')))
        throw new Error('Fixture unavailable');
      return readFileSync(join(process.argv[2]!, 'clipboard.txt'), 'utf8');
    },
  },
  new TerminalAttachments(controller, workspace),
);
controller.on('room', (room) => ui.setRoom(room));
ui.mount();
process.once('SIGHUP', () => {
  void quit();
});
await room.start();
