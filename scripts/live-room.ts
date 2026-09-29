import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Room } from '../src/room.js';
import { SessionStore } from '../src/store.js';
import { providerIds, type Provider } from '../src/providers.js';
const pair = process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'claude'];
assert.ok(
  pair.length === 2 &&
    pair[0] !== pair[1] &&
    pair.every((p) => providerIds.includes(p as Provider)),
  'Select two distinct supported providers',
);
const [first, second] = pair as [Provider, Provider];
const base = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-room-live-'))),
  workspace = join(base, 'project');
mkdirSync(join(workspace, '.agents'), { recursive: true });
writeFileSync(
  join(workspace, '.agents', 'chittr.yaml'),
  `version: 1
agents:
  ${first}:
    provider: ${first}
    instructions:
      sources:
        - text: 'This is a short collaboration check. Use at most two sentences per contribution. When the human says SETTLED, pass with a short rationale. When the human corrects a requirement, acknowledge to human only.'
  ${second}:
    provider: ${second}
    instructions:
      sources:
        - text: 'This is a short collaboration check. Use at most two sentences per contribution. When ${first} asks a review question, inspect the referenced file and answer human only. When the human says SETTLED, pass. When the human corrects a requirement, acknowledge to human only.'
`,
);
writeFileSync(
  join(workspace, 'calc.ts'),
  'export function average(total: number, count: number) { return total / count; }\n',
);
const config = loadConfig(workspace, join(base, 'no-user-config'))!;
const store = new SessionStore(workspace, join(base, 'state'));
store.acquire();
const room = new Room(config, store);
async function settled() {
  const until = Date.now() + 240000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    const failed = Object.values(room.session.agents).find((a) => a.connection === 'unavailable');
    if (failed) throw new Error(`${failed.id}: ${failed.error}`);
    if (room.isIdle() && Object.keys(config.agents).every((id) => room.pending(id).queued === 0))
      return;
  }
  throw new Error('Conversation exceeded bounded integration-test timeout');
}
let reported = 0;
room.on('change', () => {
  while (reported < room.session.messages.length) {
    const message = room.session.messages[reported++]!;
    console.log(
      message.id,
      message.author,
      'to',
      message.recipients.join(',') || 'room',
      message.text.slice(0, 250),
    );
  }
});
try {
  await room.start();
  room.send(
    `@${first} Inspect calc.ts, then ask ${second} one specific review question about count=0. Direct your reply to ${second} using recipient metadata.`,
  );
  await settled();
  assert.ok(
    room.session.messages.some((m) => m.author === first && m.recipients.includes(second)),
    'The first agent must address its peer directly',
  );
  assert.ok(
    room.session.messages.some(
      (m) => m.author === second && m.replyTo.some((id) => room.message(id)?.author === first),
    ),
    'The second agent must answer its peer',
  );
  for (const id of pair)
    assert.ok(
      room.session.activities?.some(
        (a) => a.agent === id && a.activity === 'working' && a.detail?.includes('read_file'),
      ),
      `${id} must inspect the task file`,
    );
  const correction = room.send(
    'Correction: count=0 must return null, not throw or return zero. Please both acknowledge the corrected requirement, directing your replies to human only.',
  );
  await settled();
  for (const id of pair) assert.equal(correction.deliveries[id]?.status, 'contributed');
  const settledMessage = room.send(
    'SETTLED. We agree and there is nothing further to add. Please pass with a brief rationale.',
  );
  await settled();
  for (const id of pair) assert.equal(settledMessage.deliveries[id]?.status, 'passed');
  assert.equal(
    room.session.messages.at(-1)?.id,
    settledMessage.id,
    'Passes must not create more chat messages',
  );
  await room.close();
  assert.equal(store.load()?.messages.length, room.session.messages.length);
  console.log(
    'PASS real multi-agent conversation, direct peer question, file inspection by both agents, concurrent human-correction replies, explicit passes, durable transcript',
  );
} finally {
  await room.close();
  store.release();
  rmSync(base, { recursive: true, force: true });
}
