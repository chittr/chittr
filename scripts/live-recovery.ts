// Opt-in subscription probe: npx tsx scripts/live-recovery.ts codex|grok
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter } from '../src/adapters/index.js';
import type { Message, Provider, RoomConfig } from '../src/types.js';

const provider = process.argv[2] as Provider;
assert.ok(['codex', 'grok'].includes(provider), 'Choose codex or grok');
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-recovery-probe-')));
const config: RoomConfig = {
  workspace,
  skills: { enabled: false },
  permissions: { edits: false, commands: false, network: false },
  followUpTurns: 1,
  sources: [],
  provenance: {},
  agents: {
    probe: { id: 'probe', provider, enabled: true, instructions: '', fingerprint: provider },
  },
};
const adapter = createAdapter(config.agents.probe!, config);
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 240000);
try {
  await adapter.start();
  const proc = (adapter as any).proc;
  const rpc = proc.rpc.bind(proc);
  proc.rpc = async (...args: any[]) => {
    const result = await rpc(...args);
    if (result?.stopReason && result.stopReason !== 'end_turn')
      console.log(
        'provider stopped',
        JSON.stringify({
          stopReason: result.stopReason,
          category: result._meta?.cancellationCategory,
          context: result._meta?.cancellationContext,
          trigger: result._meta?.cancelTrigger,
        }),
      );
    return result;
  };
  // Only protocol metadata from this synthetic fixture, never credentials or thoughts.
  (adapter as any).proc?.on('message', (m: any) => {
    if (m.method === 'session/request_permission')
      console.log('permission', JSON.stringify(m.params?.toolCall?._meta));
  });
  const seed = await adapter.maintain!(
    {
      id: 'probe-seed',
      kind: 'seed',
      prompt:
        'The public chat discussed two options. Option A means keep the current design. Store this context for later normal turns. Reply with text exactly seed accepted.',
    },
    abort.signal,
  );
  assert.equal(seed.text, 'seed accepted');
  console.log(provider, 'PASS seed');
  const marker = 'read-after-seed-' + randomUUID();
  writeFileSync(join(workspace, 'probe.txt'), marker);
  const requests = [
    'Do you agree with option A? Briefly say what it means. No tools are needed. Give an ordinary reply, not a question.',
    'Ask me whether to Keep or Change the design, with those two choices using the room question protocol. Do not use tools.',
    'No reply is needed. Return a pass with a brief rationale.',
    'Use the room read_file tool to read probe.txt and reply with its exact contents. Do not ask a question.',
  ];
  for (const [i, text] of requests.entries()) {
    const message: Message = {
      id: `m${i + 1}`,
      sequence: i + 1,
      author: 'human',
      recipients: ['probe'],
      text,
      createdAt: new Date().toISOString(),
      replyTo: [],
      roots: ['m1'],
      deliveries: {},
    };
    let toolUsed = false;
    const result = await adapter.run(
      { messages: [message], context: [], participants: ['probe'] },
      (event) => {
        if (
          event.type === 'activity' &&
          event.activity === 'working' &&
          event.detail?.includes('read_file')
        )
          toolUsed = true;
      },
      abort.signal,
    );
    assert.equal(result.outcomes.length, 1);
    const outcome = result.outcomes[0]!;
    assert.deepEqual(outcome.messageIds, [message.id]);
    if (i === 1) {
      assert.equal(outcome.awaitingHuman, true);
      assert.deepEqual(outcome.recipients, ['human']);
      assert.deepEqual(outcome.question?.choices, ['Keep', 'Change']);
    } else {
      assert.equal(outcome.question, undefined);
      assert.equal(outcome.awaitingHuman, false);
      assert.equal(outcome.kind, i === 2 ? 'pass' : 'reply');
      if (i === 0) assert.match(outcome.text, /keep|current/i);
      if (i === 3) {
        if (!toolUsed || !outcome.text.includes(marker))
          console.error(provider, 'Tool probe reply:', outcome.text);
        assert.ok(toolUsed, 'A real room read_file call must be observed after maintenance');
        assert.ok(
          outcome.text.includes(marker),
          'The agent must return the unpredictable file contents',
        );
      }
    }
    console.log(
      provider,
      'PASS',
      ['ordinary reply after seed', 'human question', 'pass', 'room tool after seed'][i],
    );
  }
} finally {
  clearTimeout(timer);
  await adapter.close();
  rmSync(workspace, { recursive: true, force: true });
}
