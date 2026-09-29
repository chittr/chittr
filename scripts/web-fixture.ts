// Browser integration fixture. No real provider processes or subscription calls.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Room } from '../src/room.js';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import { WebUI } from '../src/web.js';
import { loadConfig } from '../src/config.js';
import type { AgentAdapter } from '../src/types.js';

const base =
  process.env.CHITTR_FIXTURE_BASE ?? realpathSync(mkdtempSync(join(tmpdir(), 'chittr-web-')));
const workspace = join(base, 'web-pilot');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'sample.ts'), 'export const answer = 42;\n');
const home = join(base, 'home');
mkdirSync(join(home, '.agents'), { recursive: true });
writeFileSync(
  join(home, '.agents/chittr.yaml'),
  `version: 1
human: {name: Bill}
skills: {enabled: false}
defaultAgents:
  codex: {provider: codex}
  claude: {provider: claude}
`,
);
const config = loadConfig(workspace, home)!;
const adapter = (id: string): AgentAdapter => ({
  async start() {
    return { sessionId: 'fixture-' + id, restored: false };
  },
  async run(input, event, signal) {
    event({ type: 'received' });
    event({ type: 'activity', activity: 'considering' });
    const reportContext = (usedTokens: number) => {
      if (id === 'codex' || id === 'claude')
        event({
          type: 'context',
          usage: {
            usedTokens,
            ...(id === 'codex' ? { maxTokens: 200000 } : {}),
            updatedAt: new Date().toISOString(),
          },
        });
    };
    reportContext(48000);
    if (input.messages.some((message) => message.text.includes('[free-question]')))
      return {
        outcomes: input.messages.map((message) => ({
          messageIds: [message.id],
          recipients: ['human'],
          kind: 'reply' as const,
          text: 'Supporting context',
          question: {
            prompt: 'What should we investigate next?',
            intent: 'free-text' as const,
            choices: [],
          },
        })),
      };
    if (input.messages.some((message) => message.consultation)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        outcomes: input.messages.map((message) =>
          message.consultation
            ? {
                messageIds: [message.id],
                recipients: ['human'],
                kind: 'reply' as const,
                text: 'Advice for the human',
                recommendation: {
                  questionId: message.consultation.questionId,
                  requestId: message.id,
                  answer: id === 'claude' ? 'Probe first' : 'Paste and send',
                  reasoning:
                    id === 'claude'
                      ? 'Verify the smallest case first.'
                      : 'Inspect the full behavior with a realistic input.',
                },
              }
            : { messageIds: [message.id], recipients: [], kind: 'pass' as const, text: 'Noted' },
        ),
      };
    }
    const pass = input.messages.some((message) => message.text.includes('[pass]'));
    if (input.messages.some((message) => message.text.includes('[question]')))
      return {
        outcomes: input.messages.map((message) => ({
          messageIds: [message.id],
          kind: 'reply',
          recipients: [],
          text: 'Which implementation should we start with?',
          awaitingHuman: true,
          question: {
            prompt:
              'Which implementation should we start with? Consider the existing browser and terminal behavior before choosing a plan for the question workflow.',
            intent: 'decision',
            choices: [
              'Probe first',
              'Paste and send',
              '/pause @claude',
              'Investigate the existing behavior across browser, terminal, restart, and provider failures before choosing the smallest implementation that preserves every current permission',
            ],
          },
        })),
      };
    const text =
      id === 'codex'
        ? 'The project has a useful separation between **conversation behaviour** and the interface.\n\n- The room coordinates agents, messages, and permissions.\n- Each agent keeps its own context and can reply independently.\n- Both interfaces share the same saved conversation.\n\n```ts\nconst room = new Room(config, store);\nawait room.start();\n```\n\nI would keep the next change focused on the room controls.'
        : 'I agree with keeping one shared room engine. That gives us a consistent place to handle queues, interruption, and recovery.\n\nOne detail to check: **refreshing the browser should restore the view without repeating work**. We can test that by dropping a response after the server accepts a message.\n\nBill, the interface is ready for your next idea.';
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('Interrupted'));
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          reject(new Error('Interrupted'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, 120);
        signal.addEventListener('abort', abort, { once: true });
      });
      if (!pass) {
        event({ type: 'activity', activity: 'replying' });
        event({ type: 'text', text: text.slice(0, Math.round((text.length * (i + 1)) / 10)) });
      }
      if (i === 5) reportContext(72000);
    }
    if (input.messages.some((message) => message.text.includes('[fail]')))
      throw new Error('Fixture provider failure');
    return {
      outcomes: input.messages.map((message) => ({
        messageIds: [message.id],
        kind: pass ? 'pass' : 'reply',
        recipients: pass ? [] : ['human'],
        text: pass ? 'The other contributions cover my view.' : text,
      })),
    };
  },
  async maintain(request, signal) {
    signal.throwIfAborted();
    const text =
      request.kind === 'seed'
        ? 'seed accepted'
        : JSON.stringify({
            entries: JSON.parse(request.prompt).messages.map((message: any) => ({
              category: 'objective',
              text: message.text,
              sources: [{ messageId: message.id, author: message.author }],
            })),
          });
    return { text, sessionId: 'prepared-' + id };
  },
  async interrupt() {},
  async close() {},
});
const store = new SessionStore(workspace, join(base, 'state'));
store.acquire();
let web: WebUI;
let closed = false;
const restored = store.load();
const controller = new RoomController(config, store, restored, {
  help: 'Fixture help',
  quit: async () => {
    if (closed) return;
    closed = true;
    await controller.close();
    web.unmount();
    store.release();
  },
  createRoom: (next, persistence, session) =>
    new Room(next, persistence, session, (agent) => adapter(agent.id)),
  loadConfig: () => loadConfig(workspace, home),
});
if (!restored)
  controller.room.send(
    'Let’s explore the project together. How should we structure the browser interface?',
  );
web = new WebUI(controller, { port: Number(process.env.CHITTR_TEST_PORT ?? 4189) });
const url = await web.mount();
mkdirSync('.local', { recursive: true });
writeFileSync(
  '.local/web-fixture.json',
  JSON.stringify({ url, workspace, home, pid: process.pid, directory: store.directory }),
  { mode: 0o600 },
);
console.log('Browser fixture is ready.');
await controller.room.start();
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void controller.close().finally(() => {
      web.unmount();
      store.release();
      if (!process.env.CHITTR_FIXTURE_BASE) rmSync(base, { recursive: true, force: true });
      process.exit(0);
    });
  });
