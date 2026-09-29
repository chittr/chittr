// Opt-in subscription probe: npm run test:compaction -- codex [replacement|native]
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Room, newSession } from '../src/room.js';
import { createAdapter } from '../src/adapters/index.js';
import { contextBudgets } from '../src/checkpoint.js';
import type { AgentAdapter, RoomConfig, Message, Provider } from '../src/types.js';
const provider = (process.argv[2] ?? 'codex') as Provider;
if (!['codex', 'claude', 'grok', 'antigravity'].includes(provider))
  throw new Error('Choose a supported provider');
const route = process.argv[3] ?? 'replacement';
const focus = process.env.CHITTR_COMPACTION_FOCUS;
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-compaction-')));
const artifact = process.env.CHITTR_COMPACTION_TRACE
  ? resolve(process.env.CHITTR_COMPACTION_TRACE)
  : join(directory, 'trace.json');
const marker = (name: string) => `${name}_${randomUUID().replaceAll('-', '')}`;
const fixtures = {
  correction: {
    old: marker('OLD_MONDAY'),
    new: marker('NEW_TUESDAY'),
    messageId: 'm1',
    author: 'human',
    category: 'correction',
  },
  proposal: {
    marker: marker('PROPOSAL_POSTGRES'),
    messageId: 'm2',
    author: 'probe',
    category: 'disagreement',
  },
  objection: {
    marker: marker('OBJECTION_SQLITE'),
    messageId: 'm3',
    author: 'peer',
    category: 'disagreement',
  },
  pending: {
    marker: marker('QUESTION_BACKUP'),
    messageId: 'm4',
    author: 'human',
    category: 'pending-ask',
  },
  artifact: {
    marker: marker('ARTIFACT_PLAN'),
    messageId: 'm5',
    author: 'human',
    category: 'artifact',
  },
};
const config: RoomConfig = {
  workspace: directory,
  skills: { enabled: false },
  permissions: { edits: false, commands: false, network: false },
  followUpTurns: 1,
  sources: [],
  provenance: {},
  agents: {
    probe: {
      id: 'probe',
      provider,
      enabled: true,
      model: process.env.CHITTR_COMPACTION_MODEL,
      instructions: '',
      fingerprint: provider,
    },
  },
};
const session = newSession(config);
const texts = [
  `User correction: The release date was Monday ${fixtures.correction.old}; it is now Tuesday ${fixtures.correction.new}. Preserve the old/new relationship.`,
  `I propose Postgres ${fixtures.proposal.marker}. This is disputed and the human has not decided.`,
  `I object to Postgres and propose SQLite ${fixtures.objection.marker} because deployment is simpler. The human has not decided.`,
  `Pending question ${fixtures.pending.marker}: who will verify backups? It remains unanswered.`,
  `Relevant artifact: docs/${fixtures.artifact.marker}.md is the plan to inspect later.`,
];
session.messages = texts.map((text, i): Message => ({
  id: `m${i + 1}`,
  sequence: i + 1,
  author: ['human', 'probe', 'peer', 'human', 'human'][i]!,
  text,
  recipients: [],
  replyTo: [],
  roots: ['m1'],
  deliveries: {},
  createdAt: new Date().toISOString(),
}));
session.exchanges.m1 = { used: 0, allowance: 1 };
const trace: any = {
  provider,
  route,
  focus,
  directory,
  fixtures,
  events: [],
  seeds: [],
  checkpoints: [],
  results: [],
};
let original: AgentAdapter | undefined;
const room = new Room(config, { save() {} }, session, (agent, cfg, environment) => {
  const adapter = createAdapter(agent, cfg, environment);
  original ??= adapter;
  const wrapper: AgentAdapter = {
    get nativeCompaction() {
      return route === 'native' && !!adapter.nativeCompaction;
    },
    get nativeCompactionInstructions() {
      return adapter.nativeCompactionInstructions;
    },
    get sourceHandoff() {
      return !!adapter.sourceHandoff;
    },
    async start(id) {
      const result = await adapter.start(id);
      (adapter as any).proc?.on('message', (m: any) =>
        trace.events.push({
          method: m.method ?? m.type ?? m.event,
          subtype: m.subtype,
          threadId: m.params?.threadId,
          turnId: m.params?.turnId ?? m.params?.turn?.id,
          item: m.params?.item?.type,
          status: m.params?.turn?.status,
          model: m.model,
          tools: m.tools,
          mcp_servers: m.mcp_servers,
          user_message_uuid: m.user_message_uuid,
          user_message_uuids: m.user_message_uuids,
          compact_metadata: m.compact_metadata,
        }),
      );
      const proc = (adapter as any).proc;
      if (provider === 'claude' && proc) {
        const send = proc.send.bind(proc);
        proc.send = (message: any) => {
          if (message.type === 'user')
            trace.events.push({
              method: 'outgoing-user',
              uuid: message.uuid,
              compact: message.message?.content?.startsWith('/compact')
                ? message.message.content
                : undefined,
            });
          return send(message);
        };
      }
      return result;
    },
    run: adapter.run.bind(adapter),
    compact: adapter.compact?.bind(adapter),
    interrupt: adapter.interrupt.bind(adapter),
    close: adapter.close.bind(adapter),
    async maintain(request, signal) {
      if (request.kind === 'seed')
        trace.seeds.push({
          bytes: Buffer.byteLength(request.prompt),
          prompt: JSON.parse(request.prompt),
        });
      return adapter.maintain!(request, signal);
    },
  };
  return wrapper;
});
let expired = false;
const deadline = setTimeout(
  () => {
    expired = true;
    void room.close();
  },
  10 * 60 * 1000,
);
async function waitIdle(reply = false) {
  while (!room.isIdle() || (reply && room.session.messages.at(-1)?.author === 'human')) {
    if (expired) throw new Error('Live compaction probe timed out');
    if (reply && room.session.agents.probe?.connection === 'unavailable')
      throw new Error(room.session.agents.probe.error ?? 'Probe provider unavailable');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
try {
  await room.start();
  room.pause();
  assert.equal(room.session.agents.probe?.connection, 'ready', room.session.agents.probe?.error);
  if (route === 'native') {
    assert.equal(original?.nativeCompaction, true, 'Native capability unverified');
    // Seed the real source context through the separate maintenance path.
    const seed = await original!.maintain!(
      {
        id: randomUUID(),
        kind: 'seed',
        prompt: `Remember these public fixture records: ${JSON.stringify(session.messages)}. Return "seed accepted".`,
      },
      new AbortController().signal,
    );
    assert.equal(seed.text, 'seed accepted');
  }
  for (let cycle = 1; cycle <= 3; cycle++) {
    if (route === 'native' && provider === 'claude') {
      // Claude explicitly declines short histories. Create enough actual turns
      // to exercise three real boundaries, rather than three acknowledged no-ops.
      for (let turn = 0; turn < 4; turn++) {
        await original!.maintain!(
          {
            id: randomUUID(),
            kind: 'seed',
            prompt:
              `Retain the earlier fixture records. Completed verification history, cycle ${cycle}, turn ${turn}:\n` +
              Array.from(
                { length: 45 },
                (_, i) => `Record ${i}: check finished, no new decision or pending work.`,
              ).join('\n') +
              '\nReturn "seed accepted".',
          },
          new AbortController().signal,
        );
      }
    }
    if (cycle > 1)
      room.send(
        `@probe Checkpoint cycle ${cycle}: keep the earlier correction, attributed proposal and objection, pending question, and artifact markers unchanged.`,
      );
    room.compact('probe', focus);
    await waitIdle();
    assert.equal(
      room.session.agents.probe!.maintenance?.status,
      'completed',
      room.session.agents.probe!.maintenance?.detail,
    );
    if (route === 'replacement') {
      const checkpoint = room.session.checkpoints!.at(-1)!;
      trace.checkpoints.push(checkpoint);
      assert.equal(checkpoint.version, cycle);
      for (const fixture of Object.values(fixtures)) {
        const markers = 'old' in fixture ? [fixture.old, fixture.new] : [fixture.marker];
        for (const marker of markers)
          assert(
            checkpoint.entries.some(
              (entry) =>
                entry.category === fixture.category &&
                entry.text.includes(marker) &&
                entry.sources.some(
                  (source) =>
                    source.messageId === fixture.messageId && source.author === fixture.author,
                ),
            ),
            `Missing ${fixture.category} marker/source ${marker}`,
          );
      }
      assert(trace.seeds.every((seed: any) => seed.bytes <= contextBudgets.seed));
    }
    trace.results.push({
      cycle,
      pass: true,
      status: room.session.agents.probe!.maintenance?.status,
    });
    console.log(JSON.stringify(trace.results.at(-1)));
  }
  room.send(
    `@probe State the new release marker and the old release marker. Then try read_file on /etc/hosts and state whether room policy denies it.`,
  );
  await room.continue();
  await waitIdle(true);
  const result = room.session.messages.at(-1)!;
  assert.equal(room.session.agents.probe!.connection, 'ready', room.session.agents.probe!.error);
  assert(
    result.text.includes(fixtures.correction.old) && result.text.includes(fixtures.correction.new),
    'Continuation lost correction markers',
  );
  assert(
    /denied|restricted|outside|limited to/i.test(result.text),
    'Continuation did not report the file-access denial',
  );
  trace.continuation = result;
  trace.pass = true;
} catch (error) {
  trace.error = String(error);
  throw error;
} finally {
  clearTimeout(deadline);
  await room.close();
  writeFileSync(artifact, JSON.stringify(trace, null, 2));
  console.log(`Trace: ${artifact}`);
}
