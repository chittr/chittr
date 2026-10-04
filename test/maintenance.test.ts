import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Room, newSession } from '../src/room.js';
import { RoomController } from '../src/controller.js';
import { checkPlanCapacity } from '../src/plan.js';
import { planReserve, planView } from '../src/plan-view.js';
import {
  checkpointChunks,
  checkpointPrompt,
  contextBudgets,
  reconstructionPrompt,
  parseCheckpoint,
  parseHandoff,
} from '../src/checkpoint.js';
import { MaintenanceOutputError, turnPrompt } from '../src/protocol.js';
import type {
  AgentAdapter,
  RoomConfig,
  TurnInput,
  MaintenanceRequest,
  MaintenanceResult,
  TurnResult,
  Session,
} from '../src/types.js';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const providerRefusal =
  "Claude provider refusal (reasoning_extraction): This request was blocked by Anthropic's safeguards.";
const rooms: Room[] = [];
afterEach(async () => {
  for (const room of rooms.splice(0)) await room.close();
});
class Fake implements AgentAdapter {
  sessionId = randomUUID();
  nativeCompaction = false;
  nativeCompactionInstructions = false;
  compactInstructions: (string | undefined)[] = [];
  sourceHandoff = false;
  compactError?: string;
  compactCalls = 0;
  inputs: TurnInput[] = [];
  maintenanceInputs: MaintenanceRequest[] = [];
  closed = false;
  restored = false;
  holdTurn = false;
  holdMaintenance = false;
  runError?: string;
  maintenanceError?: string;
  maintenanceErrorKind?: MaintenanceRequest['kind'];
  failSeed = false;
  badSummary?: string;
  release?: () => void;
  cancel?: () => void;
  async start(id?: string) {
    return {
      sessionId: this.restored ? this.sessionId : (id ?? this.sessionId),
      restored: this.restored,
    };
  }
  async run(input: TurnInput, _event: unknown, signal: AbortSignal): Promise<TurnResult> {
    this.inputs.push(input);
    if (this.runError) throw new Error(this.runError);
    if (this.holdTurn) await this.wait(signal);
    return {
      outcomes: input.messages.map((m) => ({
        kind: 'pass',
        text: 'Done',
        messageIds: [m.id],
        recipients: [],
      })),
    };
  }
  wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.release = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(new Error('Interrupted'));
      };
      this.cancel = abort;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async compact(_id: string, signal: AbortSignal, instructions?: string) {
    this.compactCalls++;
    this.compactInstructions.push(instructions);
    if (this.holdMaintenance) await this.wait(signal);
    if (this.compactError) throw new Error(this.compactError);
    return { status: 'completed' as const };
  }
  async maintain(request: MaintenanceRequest, signal: AbortSignal): Promise<MaintenanceResult> {
    this.maintenanceInputs.push(request);
    if (this.maintenanceError && this.maintenanceErrorKind === request.kind)
      throw new Error(this.maintenanceError);
    if (this.holdMaintenance) await this.wait(signal);
    if (request.kind === 'seed') {
      if (this.failSeed) throw new Error('Seed refused');
      return { text: 'seed accepted', sessionId: this.sessionId };
    }
    if (request.kind === 'checkpoint' && this.badSummary !== undefined)
      return { text: this.badSummary };
    const { previousEntries, messages } = JSON.parse(request.prompt);
    return {
      text: JSON.stringify({
        entries: [
          ...previousEntries,
          ...messages.map((m: any) => ({
            category: 'objective',
            text: m.text,
            sources: [{ messageId: m.id, author: m.author }],
          })),
        ],
      }),
    };
  }
  async interrupt() {
    this.cancel?.();
  }
  async close() {
    this.closed = true;
    this.cancel?.();
  }
}
function setup(
  options: {
    native?: boolean;
    configure?: (adapter: Fake, index: number, agent: string) => void;
    save?: (session: Session) => void;
    session?: Session;
  } = {},
) {
  const adapters: Fake[] = [];
  const config: RoomConfig = {
    workspace: '/workspace',
    permissions: { edits: false, commands: false, network: false },
    followUpTurns: 3,
    agents: Object.fromEntries(
      ['a', 'b'].map((id) => [
        id,
        { id, provider: 'codex', enabled: true, instructions: '', fingerprint: id },
      ]),
    ),
    sources: [],
    provenance: {},
  };
  const room = new Room(config, { save: options.save ?? (() => {}) }, options.session, (agent) => {
    const adapter = new Fake();
    adapter.nativeCompaction = !!options.native;
    options.configure?.(adapter, adapters.length, agent.id);
    adapters.push(adapter);
    return adapter;
  });
  rooms.push(room);
  return { room, adapters, config };
}
async function idle(room: Room) {
  for (let i = 0; i < 200 && !room.isIdle(); i++) await tick();
  expect(room.isIdle()).toBe(true);
}
it('keeps the existing failed-turn and explicit-retry behavior for a Claude provider refusal', async () => {
  const { room, adapters, config } = setup({
    configure: (adapter, _index, agent) => {
      if (agent === 'a') adapter.runError = providerRefusal;
    },
  });
  config.agents.b!.enabled = false;
  await room.start();
  room.send('@a Work');
  await tick();
  await idle(room);
  const state = room.session.agents.a!;
  expect(state).toMatchObject({ connection: 'unavailable', error: providerRefusal });
  expect(room.session.messages[0]!.deliveries.a?.status).toBe('failed');
  expect(adapters[0]!.closed).toBe(true);
  expect(room.session.notices.at(-1)!.text).toContain('/reconnect @a');
  expect(room.session.notices.at(-1)!.text).toContain('/retry #m1 @a');
});

it('keeps the source session usable when a replacement seed gets a Claude provider refusal', async () => {
  const { room, adapters, config } = setup({
    configure: (adapter, index) => {
      if (index >= 2) {
        adapter.maintenanceError = providerRefusal;
        adapter.maintenanceErrorKind = 'seed';
      }
    },
  });
  config.agents.b!.enabled = false;
  await room.start();
  room.pause();
  room.send('@a Pending');
  const source = adapters[0]!;
  const originalSession = room.session.agents.a!.sessionId;
  room.compact('a');
  await idle(room);
  expect(room.session.agents.a!).toMatchObject({
    sessionId: originalSession,
    connection: 'ready',
    maintenance: { status: 'failed', detail: providerRefusal },
  });
  expect(room.session.agents.a!.recoveryRequired).toBeUndefined();
  expect(source.closed).toBe(false);
});

it('keeps recovery required when recovery-purpose maintenance gets a Claude provider refusal', async () => {
  const first = setup();
  first.config.agents.b!.enabled = false;
  await first.room.start();
  first.room.pause();
  first.room.send('@a Saved work');
  const saved = structuredClone(first.room.session);
  await first.room.close();

  const next = setup({
    session: saved,
    configure: (adapter) => {
      adapter.restored = true;
      adapter.maintenanceError = providerRefusal;
      adapter.maintenanceErrorKind = 'checkpoint';
    },
  });
  next.config.agents.b!.enabled = false;
  await next.room.start();
  await idle(next.room);
  expect(next.room.session.agents.a!).toMatchObject({
    connection: 'unavailable',
    recoveryRequired: true,
    maintenance: { status: 'failed', detail: providerRefusal, purpose: 'recovery' },
  });
  expect(next.room.session.messages[0]!.deliveries.a?.status).toBe('queued');
});
it('registers promptly, waits for the active target, coalesces duplicates, and lets peers and new input proceed', async () => {
  const { room, adapters } = setup({
    native: true,
    configure: (a, index) => {
      a.holdTurn = index === 0;
      a.holdMaintenance = index === 0;
    },
  });
  await room.start();
  room.send('First');
  await tick();
  const id = room.compact('a');
  expect(room.compact('a')).toBe(id);
  await tick();
  expect(room.session.agents.a!.maintenance?.status).toBe('waiting');
  room.send('Second');
  await tick();
  expect(adapters[1]!.inputs).toHaveLength(2);
  expect(adapters[0]!.inputs).toHaveLength(1);
  adapters[0]!.release!();
  await tick();
  expect(room.session.agents.a!.maintenance?.status).toBe('running');
  adapters[0]!.holdTurn = false;
  adapters[0]!.release!();
  await idle(room);
  await tick();
  expect(adapters[0]!.inputs).toHaveLength(2);
  expect(room.session.messages.every((m) => m.deliveries.a?.status === 'passed')).toBe(true);
});
it.each([true, false])(
  'preserves pauses, waiting state, deliveries and budgets during maintenance; native=%s',
  async (native) => {
    const { room } = setup({ native });
    await room.start();
    room.pause();
    room.pause('a');
    room.send('@a Pending');
    room.session.agents.a!.awaitingHuman = true;
    const deliveries = structuredClone(room.session.messages);
    const exchanges = structuredClone(room.session.exchanges);
    room.compact('a');
    await idle(room);
    expect(room.session.paused).toBe(true);
    expect(room.session.agents.a!.paused).toBe(true);
    expect(room.session.agents.a!.awaitingHuman).toBe(true);
    expect(room.session.messages).toEqual(deliveries);
    expect(room.session.exchanges).toEqual(exchanges);
    expect(room.session.agents.a!.maintenance?.status).toBe('completed');
  },
);
it('applies new pause/continue actions during maintenance without restoring stale flags', async () => {
  const { room, adapters } = setup({ native: true });
  await room.start();
  room.pause();
  room.send('@a Pending');
  adapters[0]!.holdMaintenance = true;
  room.compact('a');
  await tick();
  room.pause('a');
  await room.continue();
  adapters[0]!.release!();
  await idle(room);
  expect(room.session.paused).toBe(false);
  expect(room.session.agents.a!.paused).toBe(true);
  expect(room.session.messages[0]!.deliveries.a?.status).toBe('queued');
});
it('cancels a waiting request, preserves interrupted accounting, and refuses conflicting lifecycle commands', async () => {
  const { room, adapters, config } = setup({
    native: true,
    configure: (a, i) => {
      a.holdTurn = i === 0;
    },
  });
  await room.start();
  room.send('@a Work');
  await tick();
  room.compact('a');
  await tick();
  await expect(room.reconnect('a')).rejects.toThrow('maintenance');
  await expect(room.reload(config)).rejects.toThrow('idle');
  await room.stop('a');
  expect(room.session.agents.a!.maintenance?.status).toBe('cancelled');
  expect(room.session.messages[0]!.deliveries.a?.status).toBe('interrupted');
  expect(adapters[0]!.closed).toBe(true);
  expect(room.isIdle()).toBe(true);
});
it('closes summarizers and rejects late completion after cancellation', async () => {
  const { room, adapters } = setup({
    configure: (a, i) => {
      if (i >= 2) a.holdMaintenance = true;
    },
  });
  await room.start();
  room.pause();
  room.send('@a Work');
  const old = room.session.agents.a!.sessionId;
  room.compact('a');
  await tick();
  await room.stop('a');
  adapters[2]!.release?.();
  await tick();
  expect(adapters[2]!.closed).toBe(true);
  expect(room.session.agents.a!.sessionId).toBe(old);
  expect(room.session.checkpoints).toBeUndefined();
  expect(room.session.agents.a!.maintenance?.status).toBe('cancelled');
});
it.each(['seed', 'persistence'])(
  'preserves old provider and cursor when %s fails before swap',
  async (failure) => {
    let refuse = false;
    const { room, adapters } = setup({
      configure: (a, i) => {
        a.failSeed = failure === 'seed' && i >= 2;
      },
      save: (s) => {
        if (refuse && s.checkpoints?.length) throw new Error('Disk failed');
      },
    });
    await room.start();
    room.send('@a Done');
    await tick();
    room.pause();
    room.send('@a Queued');
    const old = structuredClone(room.session.agents.a!);
    refuse = true;
    room.compact('a');
    await idle(room);
    expect(room.session.agents.a!.sessionId).toBe(old.sessionId);
    expect(room.session.agents.a!.contextThrough).toBe(old.contextThrough);
    expect(room.session.messages[1]!.deliveries.a?.status).toBe('queued');
    expect(adapters[0]!.closed).toBe(false);
    expect(room.session.checkpoints).toBeUndefined();
    expect(room.session.agents.a!.maintenance?.status).toBe('failed');
    expect(adapters.slice(2).every((a) => a.closed)).toBe(true);
  },
);
it.each([
  ['compaction', '{"entries":[{"text":"unfinished'],
  ['compaction', '{"entries":"invalid shape"}'],
  ['recovery', '{"entries":[{"text":"unfinished'],
  ['recovery', '{"entries":"invalid shape"}'],
])(
  'retains the checkpoint and queued work when %s receives a malformed summary: %s',
  async (route, output) => {
    let badSummary: string | undefined;
    let persisted: Session | undefined;
    const save = (session: Session) => {
      persisted = structuredClone(session);
    };
    const first = setup({
      save,
      configure: (adapter) => {
        adapter.badSummary = badSummary;
      },
    });
    first.config.agents.b!.enabled = false;
    await first.room.start();
    first.room.pause();
    first.room.send('@a Existing context');
    first.room.compact('a');
    await idle(first.room);
    expect(first.room.session.checkpoints).toHaveLength(1);
    first.room.send('@a Pending work');
    const before = structuredClone(first.room.session);
    badSummary = output;
    let target = first;
    if (route === 'recovery') {
      await first.room.close();
      target = setup({
        session: before,
        save,
        configure: (adapter) => {
          adapter.restored = true;
          adapter.badSummary = output;
        },
      });
      target.config.agents.b!.enabled = false;
      await target.room.start();
    } else first.room.compact('a');
    await idle(target.room);
    const state = target.room.session.agents.a!;
    expect(state.maintenance).toMatchObject({
      status: 'failed',
      detail: '@a returned an invalid chat summary; chat context was not replaced',
    });
    expect(target.room.session.notices.at(-1)!.text).toContain(
      'returned an invalid chat summary; chat context was not replaced',
    );
    expect(target.room.session.checkpoints).toEqual(before.checkpoints);
    expect(target.room.session.messages).toEqual(before.messages);
    expect(state.sessionId).toBe(before.agents.a!.sessionId);
    expect(state.contextThrough).toBe(before.agents.a!.contextThrough);
    expect(target.adapters.every((a) => a.inputs.length === 0)).toBe(true);
    expect(persisted!.checkpoints).toEqual(before.checkpoints);
    expect(persisted!.messages).toEqual(before.messages);
    expect(persisted!.agents.a!.maintenance?.status).toBe('failed');
    if (route === 'recovery')
      expect(state).toMatchObject({ connection: 'unavailable', recoveryRequired: true });
  },
);
it('serializes concurrent checkpoints and cancels a waiting writer promptly', async () => {
  const { room, adapters } = setup({
    configure: (a, i) => {
      if (i === 2) a.holdMaintenance = true;
    },
  });
  await room.start();
  room.pause();
  room.send('Pending');
  room.compact('a');
  room.compact('b');
  await tick();
  await room.stop('b');
  expect(room.session.agents.b!.maintenance?.status).toBe('cancelled');
  adapters[2]!.release!();
  await idle(room);
  expect(room.session.checkpoints?.map((c) => c.version)).toEqual([1]);
});
it('makes three replacements with monotonic sources and bounded seeds, then dispatches each obligation exactly once', async () => {
  const { room, adapters } = setup();
  await room.start();
  room.pause();
  for (let cycle = 1; cycle <= 3; cycle++) {
    room.send(`@a fixture-${cycle}`);
    room.compact('a');
    await idle(room);
    expect(room.session.checkpoints?.at(-1)).toMatchObject({
      version: cycle,
      through: cycle,
      messageId: `m${cycle}`,
    });
  }
  const checkpoint = room.session.checkpoints!.at(-1)!;
  expect(checkpoint.entries.map((e) => e.sources[0])).toEqual(
    [1, 2, 3].map((i) => ({ messageId: `m${i}`, author: 'human' })),
  );
  for (const request of adapters
    .flatMap((a) => a.maintenanceInputs)
    .filter((r) => r.kind === 'seed'))
    expect(Buffer.byteLength(request.prompt)).toBeLessThanOrEqual(contextBudgets.seed);
  await room.continue();
  await tick();
  const normal = adapters.flatMap((a) => a.inputs);
  expect(normal).toHaveLength(1);
  expect(normal[0]!.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  expect(normal[0]!.context).toEqual([]);
  expect(room.session.exchanges).toEqual(
    Object.fromEntries([1, 2, 3].map((i) => [`m${i}`, { used: 0, allowance: 3 }])),
  );
});
it('recovers lost native state using a checkpoint seed before queued delivery', async () => {
  const first = setup();
  await first.room.start();
  first.room.pause();
  first.room.send('@a Work');
  first.room.compact('a');
  await idle(first.room);
  const saved = structuredClone(first.room.session);
  await first.room.close();
  const next = setup({
    session: saved,
    configure: (a) => {
      a.restored = true;
    },
  });
  await next.room.start();
  await tick();
  const a = next.adapters[0]!;
  expect(a.maintenanceInputs.some((r) => r.kind === 'seed')).toBe(true);
  expect(a.inputs).toHaveLength(1);
  expect(a.inputs[0]!.context).toEqual([]);
  expect(next.room.session.agents.a!.checkpointVersion).toBe(1);
  expect(next.room.session.checkpoints).toHaveLength(1);
});
it('reports each real catch-up phase while preserving a paused queue', async () => {
  const first = setup();
  await first.room.start();
  first.room.pause();
  first.room.send('@a Work');
  const saved = structuredClone(first.room.session);
  await first.room.close();
  const next = setup({
    session: saved,
    configure: (a) => {
      a.restored = true;
      a.holdMaintenance = true;
    },
  });
  next.config.agents.b!.enabled = false;
  const started = next.room.start();
  for (
    let i = 0;
    i < 100 && !next.adapters.some((a) => a.maintenanceInputs[0]?.kind === 'checkpoint');
    i++
  )
    await tick();
  const summarizer = next.adapters.find((a) => a.maintenanceInputs[0]?.kind === 'checkpoint')!;
  expect(summarizer).toBeDefined();
  expect(next.room.session.agents.a!.maintenance).toMatchObject({
    purpose: 'recovery',
    status: 'running',
    detail: 'Summarizing earlier messages',
  });
  expect(next.room.session.agents.a!.connection).toBe('connecting');
  const controller = new RoomController(next.config, {} as any, undefined, {
    help: '',
    quit: async () => {},
    createRoom: () => next.room,
  });
  await controller.submit('/participants');
  const notice = next.room.session.notices.at(-1)!.text;
  expect(notice).toContain('Connection: connecting · Status: Catching up on the chat');
  expect(notice).toContain('Detail: Summarizing earlier messages');
  expect(notice).not.toContain('Activity: available');
  next.room.pause('a');
  summarizer.release!();
  for (let i = 0; i < 100 && !next.adapters[0]!.maintenanceInputs.length; i++) await tick();
  expect(next.adapters[0]!.maintenanceInputs[0]?.kind).toBe('seed');
  expect(next.room.session.agents.a!.maintenance!.detail).toBe(
    'Loading the chat context into a fresh session',
  );
  expect(next.adapters[0]!.inputs).toHaveLength(0);
  next.adapters[0]!.release!();
  await started;
  expect(next.room.session.agents.a!.maintenance).toMatchObject({
    status: 'completed',
    detail: 'Caught up on the chat',
  });
  expect(next.room.session.messages[0]!.deliveries.a!.status).toBe('queued');
});
it('holds interrupted maintenance for explicit recovery after restart', async () => {
  const first = setup({ native: true });
  await first.room.start();
  first.room.pause();
  first.room.send('@a Work');
  first.adapters[0]!.holdMaintenance = true;
  first.room.compact('a');
  await tick();
  const saved = structuredClone(first.room.session);
  const next = setup({ session: saved });
  await next.room.start();
  expect(next.room.session.agents.a!.recoveryRequired).toBe(true);
  expect(next.room.session.agents.a!.maintenance?.status).toBe('failed');
  expect(next.adapters).toHaveLength(1);
  expect(next.room.session.messages[0]!.deliveries.a?.status).toBe('queued');
});
it('rejects command syntax, disabled/stopped targets and permits input while a command is running', async () => {
  const { room, config } = setup({ native: true });
  const controller = new RoomController(config, {} as any, undefined, {
    help: '',
    quit: async () => {},
    createRoom: () => room,
  });
  await room.start();
  for (const command of ['/compact @a @b', '/compact @human', '/compact @bad!'])
    await expect(controller.submit(command)).rejects.toThrow();
  room.pause();
  room.send('@a Work');
  await controller.submit('/compact @a');
  await controller.submit('@b Incoming');
  await idle(room);
  await controller.submit('/checkpoint');
  expect(room.session.notices.at(-1)?.text).toContain('No checkpoint');
  await room.stop('a');
  await expect(controller.submit('/compact @a')).rejects.toThrow('Reconnect');
});
it('bounds incremental input and rejects invalid sources, coverage and oversized required reply targets', () => {
  const session = newSession(setup().config);
  session.messages = Array.from({ length: 6 }, (_, i) => ({
    id: `m${i + 1}`,
    sequence: i + 1,
    author: 'human',
    text: 'x'.repeat(50000),
    recipients: [],
    replyTo: [],
    roots: [],
    createdAt: new Date().toISOString(),
    deliveries: {},
  }));
  const chunks = checkpointChunks(session.messages, []);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.flat()).toEqual(session.messages);
  for (const chunk of chunks)
    expect(Buffer.byteLength(checkpointPrompt([], chunk))).toBeLessThan(
      contextBudgets.summarizerInput,
    );
  const checkpoint = {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceAgent: 'a',
    through: 6,
    messageId: 'm6',
    entries: [
      {
        category: 'objective' as const,
        text: 'Objective',
        sources: [{ messageId: 'm1', author: 'wrong' }],
      },
    ],
  };
  expect(() => parseCheckpoint(checkpoint, session.messages)).toThrow('attribution');
  expect(() => parseCheckpoint({ ...checkpoint, messageId: 'm7' }, session.messages)).toThrow(
    'coverage',
  );
  expect(() =>
    parseHandoff(
      { agent: 'a', fingerprint: 'a', through: 7, text: '', available: false },
      'a',
      session.messages,
    ),
  ).toThrow('coverage');
  const prompt = turnPrompt({
    messages: [{ ...session.messages[5]!, replyTo: ['m1', 'm2', 'm3'] }],
    context: [],
    history: session.messages,
    participants: ['a'],
  });
  expect(JSON.parse(prompt).replyTargets).toHaveLength(3);
  expect(Buffer.byteLength(prompt)).toBeGreaterThan(contextBudgets.nextTurn);
});

it('commits concurrent replacements in monotonic order without losing queued messages', async () => {
  const { room } = setup();
  await room.start();
  room.pause();
  room.send('For both agents');
  room.compact('a');
  room.compact('b');
  await idle(room);
  expect(room.session.checkpoints?.map((c) => [c.version, c.through])).toEqual([[1, 1]]);
  expect(room.session.agents.a!.checkpointVersion).toBe(1);
  expect(room.session.agents.b!.checkpointVersion).toBe(1);
  expect(room.session.messages[0]!.deliveries).toEqual({
    a: { status: 'queued' },
    b: { status: 'queued' },
  });
});
it('preserves new messages arriving during seed preparation and includes exact older reply targets', async () => {
  const { room, adapters } = setup({
    configure: (a, i) => {
      if (i === 3) a.holdMaintenance = true;
    },
  });
  await room.start();
  room.pause();
  const first = room.send('@a Original question');
  room.compact('a');
  await tick();
  room.send('@a Follow-up', first.id);
  adapters[3]!.release!();
  await idle(room);
  expect(room.session.agents.a!.contextThrough).toBe(1);
  expect(room.session.checkpoints?.at(-1)?.through).toBe(1);
  await room.continue();
  await tick();
  const input = adapters[3]!.inputs[0]!;
  expect(input.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  expect(JSON.parse(turnPrompt(input)).replyTargets[0].text).toBe('Original question');
});
it('holds the committed replacement reference after a restart without replaying the swap', async () => {
  let saved: Session | undefined;
  const first = setup({
    save: (s) => {
      if (s.checkpoints?.length) saved = structuredClone(s);
    },
  });
  await first.room.start();
  first.room.pause();
  first.room.send('@a Work');
  first.room.compact('a');
  await idle(first.room);
  const reference = saved!.agents.a!.sessionId;
  const next = setup({ session: saved });
  await next.room.start();
  await tick();
  expect(next.room.session.agents.a!.sessionId).toBe(reference);
  expect(next.room.session.checkpoints).toHaveLength(1);
  expect(next.adapters.flatMap((a) => a.maintenanceInputs)).toEqual([]);
});
it('records a confirmed no-op for an empty transcript without touching a provider', async () => {
  const { room, adapters } = setup({ native: true });
  await room.start();
  room.compact('a');
  await idle(room);
  expect(room.session.agents.a!.maintenance?.status).toBe('nothing-to-compact');
  expect(adapters[0]!.maintenanceInputs).toEqual([]);
  expect(room.session.messages).toEqual([]);
});

it.each(['provider error', 'timed out', 'cancelled'])(
  'holds uncertain native state after %s without attempting a replacement',
  async (failure) => {
    const { room, adapters } = setup({ native: true });
    await room.start();
    room.pause();
    room.send('@a Pending');
    const state = room.session.agents.a!;
    state.contextUsage = { usedTokens: 72000, updatedAt: new Date().toISOString() };
    const old = state.sessionId;
    const deliveries = structuredClone(room.session.messages);
    const exchanges = structuredClone(room.session.exchanges);
    adapters[0]!.holdMaintenance = failure === 'cancelled';
    adapters[0]!.compactError = failure;
    room.compact('a');
    await tick();
    if (failure === 'cancelled') {
      expect(state.maintenance?.status).toBe('running');
      await room.stop('a');
    }
    await idle(room);
    expect(state).toMatchObject({
      sessionId: old,
      connection: 'unavailable',
      recoveryRequired: true,
      maintenance: { status: failure === 'cancelled' ? 'cancelled' : 'failed' },
    });
    expect(state.contextUsage).toBeUndefined();
    expect(room.session.messages).toEqual(deliveries);
    expect(room.session.exchanges).toEqual(exchanges);
    expect(adapters).toHaveLength(2);
    expect(adapters[0]!.closed).toBe(true);
    expect(adapters[0]!.compactCalls).toBe(1);
    expect(adapters.flatMap((a) => a.maintenanceInputs)).toEqual([]);
    expect(() => room.compact('a')).toThrow(/Reconnect|stopped/i);
    await room.reconnect('a');
    expect(room.session.agents.a!.connection).toBe('ready');
    expect(room.session.agents.a!.recoveryRequired).toBeUndefined();
    expect(room.session.messages).toEqual(deliveries);
  },
);
it('dispatches a later large exact reply target after compaction', async () => {
  const { room, adapters } = setup();
  await room.start();
  room.pause();
  room.send('@a First');
  room.compact('a');
  await idle(room);
  await room.continue();
  await idle(room);
  room.pause('a');
  const text = 'Evidence '.repeat(18000);
  adapters[1]!.run = async (input) => ({
    outcomes: [
      { kind: 'reply', text, messageIds: input.messages.map((m) => m.id), recipients: ['human'] },
    ],
  });
  room.send('@b Give evidence');
  await tick();
  await idle(room);
  const parent = room.session.messages.at(-1)!;
  expect(parent.author).toBe('b');
  room.send('@a Inspect the evidence', parent.id);
  await room.continue('a');
  await idle(room);
  const input = adapters.flatMap((a) => a.inputs).at(-1)!;
  expect(JSON.parse(turnPrompt(input)).replyTargets[0].text).toBe(text);
  expect(Buffer.byteLength(turnPrompt(input))).toBeGreaterThan(contextBudgets.nextTurn);
  expect(room.session.agents.a!.connection).toBe('ready');
  expect(room.session.messages.at(-1)!.deliveries.a?.status).toBe('passed');
});
it.each([false, true])(
  'keeps a completed source session usable after seed failure; invalid note=%s',
  async (invalid) => {
    const { room, adapters } = setup({
      configure: (a, index) => {
        a.failSeed = index >= 2;
      },
    });
    await room.start();
    room.pause();
    room.send('@a Pending');
    const source = adapters[0]!;
    source.sourceHandoff = true;
    source.maintain = async () => {
      if (invalid)
        throw new MaintenanceOutputError('Maintenance output exceeds its 4096-byte budget');
      return { text: 'Unfinished check', sessionId: source.sessionId };
    };
    const state = room.session.agents.a!;
    const old = state.sessionId;
    state.contextUsage = { usedTokens: 72000, updatedAt: new Date().toISOString() };
    room.compact('a');
    await idle(room);
    expect(state).toMatchObject({
      sessionId: old,
      connection: 'ready',
      maintenance: { status: 'failed', detail: 'Seed refused' },
    });
    expect(state.recoveryRequired).toBeUndefined();
    expect(state.contextUsage).toBeUndefined();
    expect(source.closed).toBe(false);
    await room.continue();
    await idle(room);
    expect(source.inputs).toHaveLength(1);
  },
);
it('reconstructs a missing native session from public history when no checkpoint exists', async () => {
  const first = setup();
  await first.room.start();
  first.room.pause();
  first.room.send('@a Saved obligation');
  const saved = structuredClone(first.room.session);
  const next = setup({
    session: saved,
    configure: (a) => {
      a.restored = true;
    },
  });
  await next.room.start();
  await idle(next.room);
  expect(next.room.session.checkpoints).toHaveLength(1);
  expect(next.room.session.agents.a!.checkpointVersion).toBe(1);
  expect(next.adapters[0]!.maintenanceInputs.map((r) => r.kind)).toEqual(['seed']);
  expect(next.adapters[0]!.inputs).toHaveLength(1);
  expect(next.adapters[0]!.inputs[0]!.context).toEqual([]);
  expect(next.room.session.messages[0]!.deliveries.a?.status).toBe('passed');
});
it('explains a room-wide recovery hold and reconnects all skipped agents with continue', async () => {
  const first = setup();
  await first.room.start();
  first.room.pause();
  first.room.send('Saved obligation');
  const saved = structuredClone(first.room.session);
  saved.recoveryRequired = true;
  saved.agents.a!.recoveryRequired = true;
  const next = setup({ session: saved });
  await next.room.start();
  expect(next.adapters).toHaveLength(0);
  expect(Object.values(next.room.session.agents).every((s) => s.stopped)).toBe(true);
  expect(
    next.room.session.notices.some((n) => /Room-wide recovery hold.*\/continue/.test(n.text)),
  ).toBe(true);
  await next.room.continue();
  await idle(next.room);
  expect(next.adapters).toHaveLength(2);
  expect(next.room.session.recoveryRequired).toBeUndefined();
  expect(Object.values(next.room.session.agents).every((s) => s.connection === 'ready')).toBe(true);
  expect(
    Object.values(next.room.session.messages[0]!.deliveries).every((d) => d.status === 'passed'),
  ).toBe(true);
});

it.each(['new', 'removed'])(
  'recovers a room hold with a %s configured roster member',
  async (change) => {
    const first = setup();
    await first.room.start();
    first.room.pause();
    first.room.send('@a Pending');
    const saved = structuredClone(first.room.session);
    saved.recoveryRequired = true;
    if (change === 'new') {
      delete saved.agents.b;
      saved.agents.a!.recoveryRequired = true;
    } else {
      saved.agents.removed = { ...saved.agents.a!, id: 'removed', recoveryRequired: true };
    }
    const next = setup({ session: saved });
    await next.room.start();
    expect(next.adapters).toHaveLength(0);
    expect(next.room.session.agents.b!.stopped).toBe(true);
    await next.room.continue();
    await idle(next.room);
    expect(next.adapters).toHaveLength(2);
    expect(next.room.session.recoveryRequired).toBeUndefined();
    expect(next.room.session.agents.b!.connection).toBe('ready');
    expect(next.room.session.messages[0]!.deliveries.a?.status).toBe('passed');
  },
);
it('fails oversized saved reconstruction visibly before swapping, including on explicit retry', async () => {
  const first = setup();
  await first.room.start();
  const response = 'Evidence '.repeat(15000);
  first.adapters[0]!.run = async (input) => ({
    outcomes: [
      {
        kind: 'reply',
        text: response,
        messageIds: input.messages.map((m) => m.id),
        recipients: ['human'],
      },
    ],
  });
  first.room.send('@a Give evidence');
  await tick();
  await idle(first.room);
  const parent = first.room.session.messages.at(-1)!;
  expect(parent.author).toBe('a');
  first.room.pause();
  first.room.send('@a Inspect this evidence', parent.id);
  const saved = structuredClone(first.room.session);
  const next = setup({
    session: saved,
    configure: (a) => {
      a.restored = true;
    },
  });
  await next.room.start();
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = next.room.session.agents.a!;
    expect(state.connection).toBe('unavailable');
    expect(state.error).toContain('exceeds checkpoint input budget');
    expect(state.sessionId).toBe(saved.agents.a!.sessionId);
    expect(state.contextThrough).toBe(saved.agents.a!.contextThrough);
    expect(state.contextUsage).toBeUndefined();
    expect(next.room.session.messages).toEqual(saved.messages);
    expect(next.room.session.checkpoints).toBeUndefined();
    expect(
      next.adapters.every((a) => a.closed && !a.inputs.length && !a.maintenanceInputs.length),
    ).toBe(true);
    if (!attempt) await next.room.reconnect('a');
  }
});

it('broadcasts compaction focus only to capable adapters and preserves command whitespace', async () => {
  const { room, config, adapters } = setup({
    native: true,
    configure: (a, _i, id) => {
      a.nativeCompactionInstructions = id === 'a';
    },
  });
  const controller = new RoomController(config, {} as any, undefined, {
    help: '',
    quit: async () => {},
    createRoom: () => room,
  });
  await room.start();
  room.pause();
  room.send('Keep the epic and ticket details');
  await controller.submit('/compact remember  the epic\nand ticket details');
  await idle(room);
  expect(adapters[0]!.compactInstructions).toEqual(['remember  the epic\nand ticket details']);
  expect(adapters[1]!.compactInstructions).toEqual([undefined]);
  for (const id of ['a', 'b']) {
    expect(room.session.agents[id]!.maintenance?.purpose).toBe('compaction');
    expect(room.session.agents[id]!.maintenance?.status).toBe('completed');
    expect(room.session.agents[id]!.maintenance?.instructionsSupported).toBe(id === 'a');
    expect(room.session.messages[0]!.deliveries[id]?.status).toBe('queued');
  }
  await controller.submit('/compact');
  await idle(room);
  expect(adapters.map((a) => a.compactCalls)).toEqual([2, 2]);
  await controller.submit('/compact @a just the ticket');
  await idle(room);
  expect(adapters[0]!.compactInstructions.at(-1)).toBe('just the ticket');
  expect(adapters[1]!.compactCalls).toBe(2);
  await controller.submit('/participants');
  expect(room.session.notices.at(-1)?.text).toContain('custom focus requested');
});

it('compacts eligible agents while reporting skipped targets without reconnecting them', async () => {
  const { room, adapters, config } = setup({ native: true });
  config.agents.disabled = { ...config.agents.a!, id: 'disabled', enabled: false };
  await room.start();
  room.pause();
  room.send('Work');
  await room.stop('a');
  room.compactAll('Remember work');
  await idle(room);
  expect(adapters.map((a) => a.compactCalls)).toEqual([0, 1]);
  expect(room.session.notices.at(-1)?.text).toContain('Skipped @a');
  expect(room.session.notices.at(-1)?.text).not.toContain('@disabled');
  expect(room.session.agents.a!.stopped).toBe(true);
});

it('keeps failures independent during all-agent compaction and rejects changed focus while pending', async () => {
  const { room, adapters } = setup({ native: true });
  await room.start();
  room.pause();
  room.send('Work');
  adapters[0]!.compactError = 'Provider rejected';
  adapters[1]!.holdMaintenance = true;
  room.compactAll('Epic details');
  expect(() => room.compact('b', 'Ticket details')).toThrow('different instructions');
  await tick();
  expect(room.session.agents.a!.maintenance?.status).toBe('failed');
  expect(room.session.agents.b!.maintenance?.status).toBe('running');
  adapters[1]!.release!();
  await idle(room);
  expect(room.session.agents.b!.maintenance?.status).toBe('completed');
});

it('rejects oversized focus before registering any all-agent operation', async () => {
  const { room, adapters } = setup({ native: true });
  await room.start();
  expect(() => room.compactAll('🙂'.repeat(1025))).toThrow('Compaction instructions');
  expect(adapters.every((a) => a.compactCalls === 0)).toBe(true);
  expect(Object.values(room.session.agents).every((a) => !a.maintenance)).toBe(true);
});

it('stops every pending all-agent compaction and retains queued work', async () => {
  const { room } = setup({
    native: true,
    configure: (a) => {
      a.holdMaintenance = true;
    },
  });
  await room.start();
  room.pause();
  room.send('Pending work');
  room.compactAll('Keep this');
  await tick();
  await room.stop();
  for (const id of ['a', 'b']) {
    expect(room.session.agents[id]!.maintenance?.status).toBe('cancelled');
    expect(room.session.agents[id]!.stopped).toBe(true);
    expect(room.session.messages[0]!.deliveries[id]?.status).toBe('queued');
  }
});

it('rejects bare configured agent names before broadcasting but accepts an explicit focus separator', async () => {
  const { room, config, adapters } = setup({ native: true });
  const controller = new RoomController(config, {} as any, undefined, {
    help: '',
    quit: async () => {},
    createRoom: () => room,
  });
  await room.start();
  room.pause();
  room.send('Work');
  for (const name of ['a', 'b', 'human'])
    await expect(controller.submit(`/compact ${name}`)).rejects.toThrow('Use /compact @');
  expect(adapters.every((a) => a.compactCalls === 0)).toBe(true);
  await controller.submit('/compact -- a');
  await idle(room);
  expect(adapters.map((a) => a.compactCalls)).toEqual([1, 1]);
  expect(room.session.agents.a!.maintenance?.instructions).toBe('a');
});

it('keeps old attachment metadata in full public history after actual replacement excludes it from context and seed', async () => {
  const { room, adapters } = setup();
  await room.start();
  room.send('@human Saved image reference');
  const metadata = {
    id: `att-${'a'.repeat(32)}`,
    filename: 'fixture.png',
    mediaType: 'image/png' as const,
    byteSize: 70,
    width: 1,
    height: 1,
  };
  room.session.messages[0]!.attachments = [metadata];
  for (let i = 0; i < 24; i++)
    room.send('@human ' + `Note ${i}. ` + 'No pending task. '.repeat(70));
  const last = room.session.messages.at(-1)!;
  room.session.checkpoints = [
    {
      version: 1,
      createdAt: new Date().toISOString(),
      sourceAgent: 'a',
      through: last.sequence,
      messageId: last.id,
      entries: [
        {
          category: 'objective',
          text: 'The later background notes have no pending task.',
          sources: [{ messageId: last.id, author: last.author }],
        },
      ],
    },
  ];
  expect(parseCheckpoint(room.session.checkpoints[0], room.session.messages)).toEqual(
    room.session.checkpoints[0],
  );
  room.compact('a');
  await idle(room);
  expect(room.session.agents.a!.contextThrough).toBe(last.sequence);
  const replacement = adapters.at(-1)!;
  const seed = replacement.maintenanceInputs.find((x) => x.kind === 'seed')!;
  expect(seed.prompt).not.toContain(metadata.id);
  expect(seed.prompt).toContain('read_conversation');
  room.send('@a Inspect the older visual reference');
  await tick();
  await idle(room);
  const input = replacement.inputs.at(-1)!;
  expect(input.history![0]!.attachments).toEqual([metadata]);
  expect(turnPrompt(input)).not.toContain(metadata.id);
  expect(input.messages.every((x) => !x.attachments?.length && !x.replyTo.length)).toBe(true);
});

// Adapter contract caller obligations. These fixtures exercise Room's public
// methods; the transport conformance body lives in adapter-contract.test.ts.
it.each([false, true])(
  'adapter contract: restored=%s controls recovery with prior public messages',
  async (restored) => {
    const first = setup();
    first.config.agents.b!.enabled = false;
    await first.room.start();
    first.room.pause();
    first.room.send('@a Prior context');
    const saved = structuredClone(first.room.session);
    await first.room.close();
    const next = setup({
      session: saved,
      configure: (a) => {
        a.restored = restored;
      },
    });
    next.config.agents.b!.enabled = false;
    await next.room.start();
    await idle(next.room);
    const requests = next.adapters.flatMap((a) => a.maintenanceInputs);
    expect(requests.some((r) => r.kind === 'seed')).toBe(restored);
    expect(next.room.session.agents.a!.maintenance?.purpose).toBe(
      restored ? 'recovery' : undefined,
    );
  },
);

it.each(['nativeCompaction', 'compact'] as const)(
  'adapter contract: absent %s selects replacement',
  async (member) => {
    const { room, config, adapters } = setup({
      native: true,
      configure: (a, index) => {
        if (index === 0) Object.assign(a, { [member]: undefined });
      },
    });
    config.agents.b!.enabled = false;
    await room.start();
    room.pause();
    room.send('@a Context');
    room.compact('a');
    expect(room.session.agents.a!.maintenance?.route).toBe('replacement');
    await idle(room);
    expect(room.session.agents.a!.maintenance?.status).toBe('completed');
    expect(adapters[0]!.compactCalls).toBe(0);
  },
);

it('adapter contract: absent native instruction support passes undefined', async () => {
  const { room, config, adapters } = setup({
    native: true,
    configure: (a) => Object.assign(a, { nativeCompactionInstructions: undefined }),
  });
  config.agents.b!.enabled = false;
  await room.start();
  room.pause();
  room.send('@a Context');
  room.compact('a', 'Keep this');
  await idle(room);
  expect(room.session.agents.a!.maintenance?.instructionsSupported).toBe(false);
  expect(adapters[0]!.compactInstructions).toEqual([undefined]);
});

it.each(['sourceHandoff', 'maintain'] as const)(
  'adapter contract: absent live %s leaves continuation unavailable',
  async (member) => {
    const { room, config, adapters } = setup({
      configure: (a, index) => {
        a.sourceHandoff = true;
        if (index === 0) Object.assign(a, { [member]: undefined });
      },
    });
    config.agents.b!.enabled = false;
    await room.start();
    room.pause();
    room.send('@a Context');
    room.compact('a');
    await idle(room);
    expect(room.session.agents.a!.maintenance?.status).toBe('completed');
    expect(adapters[0]!.maintenanceInputs).toEqual([]);
    expect(Object.values(room.session.handoffs ?? {}).at(-1)).toMatchObject({
      available: false,
      text: 'Continuation note unavailable',
    });
  },
);

it('adapter contract: a factory adapter without maintain fails replacement', async () => {
  const { room, config } = setup({
    configure: (a, index) => {
      if (index > 0) Object.assign(a, { maintain: undefined });
    },
  });
  config.agents.b!.enabled = false;
  await room.start();
  room.pause();
  room.send('@a Context');
  room.compact('a');
  await idle(room);
  expect(room.session.agents.a!.maintenance).toMatchObject({
    status: 'failed',
    detail: '@a does not support safe checkpoint replacement',
  });
});

it('adapter contract: drops retired callbacks and outcomes resolved after abort', async () => {
  let callback!: (event: import('../src/types.js').AdapterEvent) => void;
  let release!: () => void;
  let signal!: AbortSignal;
  const { room, config } = setup({
    configure: (a, index) => {
      if (index !== 0) return;
      a.run = async (input, event, abort) => {
        callback = event as typeof callback;
        signal = abort;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          outcomes: input.messages.map((m) => ({
            kind: 'reply',
            text: 'Too late',
            recipients: ['human'],
            messageIds: [m.id],
          })),
        };
      };
    },
  });
  config.agents.b!.enabled = false;
  await room.start();
  const message = room.send('@a Work');
  await tick();
  callback({ type: 'text', text: 'Active draft' });
  expect(room.session.agents.a!.draft).toBe('Active draft');
  const stopping = room.stop('a');
  expect(signal.aborted).toBe(true);
  release();
  await stopping;
  expect(message.deliveries.a!.status).toBe('interrupted');
  expect(room.session.messages.map((m) => m.text)).not.toContain('Too late');
  const before = structuredClone(room.session.agents.a!);
  callback({ type: 'text', text: 'Retired draft' });
  callback({ type: 'activity', activity: 'working', detail: 'Retired activity' });
  expect(room.session.agents.a).toEqual(before);
});

it('compacts an agreement at admitted capacity and restores the exact plan on subsequent turns', async () => {
  const { room, adapters } = setup();
  await room.start();
  room.pause();
  room.planAction({
    kind: 'add',
    category: 'approach',
    markdown: 'x',
    sourceIds: [],
  });
  const probe = structuredClone(room.session.plan!);
  let low = 1,
    high = 65536;
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    probe.entries[0]!.markdown = 'x'.repeat(size);
    try {
      checkPlanCapacity(probe, room.session.messages);
      low = size;
    } catch {
      high = size - 1;
    }
  }
  probe.entries[0]!.markdown = 'x'.repeat(low);
  expect(
    Buffer.byteLength(JSON.stringify(planView(probe, room.session.messages))) + planReserve(probe),
  ).toBe(65536);
  room.planAction({
    kind: 'edit',
    entryId: 'p1',
    revision: 1,
    markdown: 'x'.repeat(low),
    sourceIds: [],
  });
  room.planAction({ kind: 'agree-all', revision: room.session.plan!.revision });
  const plan = structuredClone(room.session.plan);
  const agreement = structuredClone(room.session.messages.at(-1));
  room.compact('a');
  await idle(room);
  expect(room.session.agents.a!.maintenance?.status).toBe('completed');
  expect(room.session.plan).toEqual(plan);
  expect(room.session.messages[2]).toEqual(agreement);
  room.send('@a Continue discussion');
  await room.continue();
  await tick();
  await idle(room);
  const input = adapters.flatMap((a) => a.inputs).at(-1)!;
  expect(input.plan!.entries[0]!.markdown).toBe('x'.repeat(low));
  expect(input.plan!.agreement?.current).toBe(true);
  expect(checkpointChunks(room.session.messages.slice(0, 3), []).flat()).toHaveLength(3);
});

it.each([false, true])(
  'refuses a recovery prompt above the limit (non-plan alone: %s) and retains prior state',
  async (nonPlanOverflow) => {
    const { room, adapters } = setup({
      configure: (a, i) => {
        if (i === 3) a.holdMaintenance = true;
      },
    });
    await room.start();
    room.pause();
    room.planAction({
      kind: 'add',
      category: 'approach',
      markdown: 'x'.repeat(58000),
      sourceIds: [],
    });
    const plan = structuredClone(room.session.plan);
    const reference = room.session.agents.a!.sessionId;
    room.compact('a');
    await tick();
    room.send('@a ' + 'y'.repeat(45000));
    room.send('@a ' + 'z'.repeat(45000));
    if (nonPlanOverflow) room.send('@a ' + 'w'.repeat(45000));
    adapters[3]!.release!();
    await idle(room);
    expect(room.session.agents.a!.maintenance?.status).toBe('failed');
    expect(room.session.agents.a!.maintenance?.detail).toContain('total');
    expect(room.session.agents.a!.maintenance?.detail).toContain('plan');
    expect(room.session.agents.a!.maintenance?.detail).toContain(
      nonPlanOverflow
        ? 'Non-plan input already exceeds the limit; shrinking the plan alone cannot fix this.'
        : 'Shorten live entries or explicitly reject proposals/withdraw entries',
    );
    expect(room.session.plan).toEqual(plan);
    expect(room.session.agents.a!.sessionId).toBe(reference);
  },
);
