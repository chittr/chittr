import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  TurnInput,
  TurnResult,
  AdapterEvent,
  RoomConfig,
  Outcome,
} from '../src/types.js';
import { Room, parseAddress } from '../src/room.js';
import { transcript } from '../src/ui/terminal.js';
import { projectRoom } from '../src/snapshot.js';
import { cleanText } from '../src/ui/input.js';
import { loadConfig, writeStarter } from '../src/config.js';
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
class Fake implements AgentAdapter {
  inputs: TurnInput[] = [];
  events?: (e: AdapterEvent) => void;
  pending?: { resolve: (r: TurnResult) => void; reject: (e: Error) => void };
  starts: (string | undefined)[] = [];
  async start(id?: string) {
    this.starts.push(id);
    return { sessionId: id ?? 'native-session', restored: false };
  }
  run(
    input: TurnInput,
    event: (e: AdapterEvent) => void,
    signal: AbortSignal,
  ): Promise<TurnResult> {
    this.inputs.push(input);
    this.events = event;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
    });
  }
  finish(outcomes?: Outcome[]) {
    const input = this.inputs.at(-1)!;
    this.pending!.resolve({
      outcomes:
        outcomes ??
        input.messages.map((m) => ({
          messageIds: [m.id],
          kind: 'pass',
          text: 'Nothing to add',
          recipients: [],
        })),
      sessionId: 'native-session',
    });
    this.pending = undefined;
  }
  async interrupt() {
    this.pending?.reject(new Error('Interrupted'));
  }
  async close() {
    await this.interrupt();
  }
}

it.each(['resume', 'fresh', 'changed-session', 'changed-config'])(
  'saves context per participant and handles %s without stale readings',
  async (mode) => {
    const { room, adapters, config, getSaved } = setup();
    await room.start();
    room.send('Discuss');
    await tick();
    const usage = { usedTokens: 72000, maxTokens: 200000, updatedAt: new Date().toISOString() };
    adapters.codex!.events!({ type: 'context', usage });
    expect(room.session.agents.codex!.contextUsage).toEqual(usage);
    expect(room.session.agents.claude!.contextUsage).toBeUndefined();
    expect(getSaved().agents.codex.contextUsage).toEqual(usage);
    adapters.codex!.finish();
    adapters.claude!.finish();
    await tick();
    const staleEvent = adapters.codex!.events!;
    staleEvent({ type: 'context', usage: { ...usage, usedTokens: 999 } });
    expect(room.session.agents.codex!.contextUsage).toEqual(usage);
    const saved = getSaved();
    await room.close();
    const next = structuredClone(config);
    if (mode === 'changed-config') next.agents.codex!.fingerprint = 'new-model';
    const restored = new Room(next, { save() {} }, saved, () => {
      const adapter = new Fake();
      adapter.start = async (id) => ({
        sessionId: mode === 'changed-session' ? 'different-session' : (id ?? 'new-session'),
        restored: mode === 'fresh',
      });
      return adapter;
    });
    try {
      await restored.start();
      expect(restored.session.agents.codex!.contextUsage).toEqual(
        mode === 'resume' ? usage : undefined,
      );
    } finally {
      await restored.close();
    }
  },
);

it('pins completed agent replies without dispatching another turn', async () => {
  const { room, adapters, getSaved } = setup();
  try {
    await room.start();
    room.send('@codex Discuss');
    await tick();
    room.setPinned('#m1', true);
    adapters.codex!.finish([
      { messageIds: ['m1'], kind: 'reply', text: 'A decision to keep', recipients: ['human'] },
    ]);
    await tick();
    const before = structuredClone(room.session);
    room.setPinned('#m2', true);
    await tick();
    expect(room.pinnedMessages().map((message) => message.author)).toEqual(['human', 'codex']);
    expect(getSaved().pinnedMessageIds).toEqual(['m1', 'm2']);
    expect(adapters.codex!.inputs).toHaveLength(1);
    expect(adapters.claude!.inputs).toHaveLength(0);
    expect(room.session.messages).toEqual(before.messages);
    expect(room.session.exchanges).toEqual(before.exchanges);
  } finally {
    await room.close();
  }
});

it('replaces context readings after compaction, without accumulating previous calls', async () => {
  const { room, adapters } = setup();
  try {
    await room.start();
    room.send('@codex Discuss');
    await tick();
    const event = adapters.codex!.events!;
    const usage = { usedTokens: 180000, maxTokens: 200000, updatedAt: new Date().toISOString() };
    event({ type: 'context', usage });
    event({ type: 'context' });
    expect(room.session.agents.codex!.contextUsage).toBeUndefined();
    event({ type: 'context', usage: { ...usage, usedTokens: 12000 } });
    expect(room.session.agents.codex!.contextUsage?.usedTokens).toBe(12000);
    await room.stop('codex');
    event({ type: 'context', usage });
    expect(room.session.agents.codex!.contextUsage?.usedTokens).toBe(12000);
  } finally {
    await room.close();
  }
});
function setup(turns = 8, previous?: any) {
  const config: RoomConfig = {
    workspace: '/workspace',
    permissions: { edits: false, commands: false, network: false },
    followUpTurns: turns,
    sources: [],
    provenance: {},
    agents: Object.fromEntries(
      ['codex', 'claude'].map((id) => [
        id,
        {
          id,
          provider: id as 'codex' | 'claude',
          enabled: true,
          instructions: '',
          fingerprint: id,
        },
      ]),
    ),
  };
  const adapters: Record<string, Fake> = {};
  let saved: any;
  const room = new Room(
    config,
    {
      save: (s) => {
        saved = structuredClone(s);
      },
    },
    previous,
    (agent) => (adapters[agent.id] = new Fake()),
  );
  return { room, config, adapters, getSaved: () => saved };
}
const reply = (id: string, text = 'A contribution', recipients: string[] = []): Outcome => ({
  messageIds: [id],
  recipients,
  kind: 'reply',
  text,
});
describe('room scheduling', () => {
  it('routes a human reply to its author and gives it a fresh exchange, preserving the link on resume', async () => {
    const { room, adapters, getSaved } = setup(1);
    try {
      await room.start();
      const original = room.send('@codex Question');
      await tick();
      adapters.codex!.finish([reply(original.id, 'Which option?', ['human'])]);
      await tick();
      const parent = room.session.messages.at(-1)!;
      room.session.exchanges[original.id]!.used = 1;
      const answer = room.send('The second option.\nPlease continue.', parent.id);
      expect(answer).toMatchObject({
        replyTo: [parent.id],
        recipients: ['codex'],
        roots: [answer.id],
        text: 'The second option.\nPlease continue.',
      });
      expect(Object.keys(answer.deliveries)).toEqual(['codex']);
      expect(room.session.exchanges[answer.id]).toEqual({ used: 0, allowance: 1 });
      await tick();
      expect(adapters.codex!.inputs.at(-1)!.messages[0]!.replyTo).toEqual([parent.id]);
      expect(adapters.claude!.inputs).toHaveLength(0);
      const restored = setup(1, getSaved());
      expect(restored.room.message(answer.id)!.replyTo).toEqual([parent.id]);
      await restored.room.close();
    } finally {
      await room.close();
    }
  });
  it('keeps the recipients of human messages and accepts explicit reply recipients', async () => {
    const { room } = setup();
    try {
      const directed = room.send('@codex Original');
      expect(room.send('Follow-up', directed.id).recipients).toEqual(['codex']);
      const override = room.send('@claude @human Check @codex here', directed.id);
      expect(override.recipients).toEqual(['claude', 'human']);
      expect(override.replyTo).toEqual([directed.id]);
      expect(override.text).toBe('Check @codex here');
      const broadcast = room.send('For everyone');
      expect(room.send('More detail', broadcast.id).recipients).toEqual([]);
    } finally {
      await room.close();
    }
  });
  it('rejects unknown targets, blank text and disabled default recipients without sending', async () => {
    const { room, config } = setup();
    try {
      const parent = room.send('@codex Original');
      expect(() => room.send('Answer', 'm999')).toThrow('Unknown reply target');
      expect(() => room.send('  ', parent.id)).toThrow('Enter a message');
      config.agents.codex!.enabled = false;
      expect(() => room.send('Answer', parent.id)).toThrow('no longer enabled');
      expect(room.session.messages).toHaveLength(1);
      expect(room.send('@claude Answer', parent.id).recipients).toEqual(['claude']);
    } finally {
      await room.close();
    }
  });
  it('routes only leading names and rejects unknown recipients without a broadcast', () => {
    expect(parseAddress('@codex @claude hello @reference', ['codex', 'claude'])).toEqual({
      recipients: ['codex', 'claude'],
      text: 'hello @reference',
    });
    expect(parseAddress('hello @codex', ['codex'])).toEqual({
      recipients: [],
      text: 'hello @codex',
    });
    expect(() => parseAddress('@wrong hello', ['codex'])).toThrow('Unknown');
    expect(() => parseAddress('@codex, hello', ['codex'])).toThrow();
  });
  it('runs agents concurrently, streams only to the human, and passes never activate peers', async () => {
    const { room, adapters } = setup();
    await room.start();
    room.send('Discuss');
    await tick();
    expect(adapters.codex!.inputs).toHaveLength(1);
    expect(adapters.claude!.inputs).toHaveLength(1);
    adapters.codex!.events!({ type: 'text', text: 'partial' });
    expect(room.session.messages).toHaveLength(1);
    adapters.codex!.finish();
    adapters.claude!.finish();
    await tick();
    expect(room.session.messages[0]!.deliveries.codex!.status).toBe('passed');
    expect(adapters.codex!.inputs).toHaveLength(1);
    await room.close();
  });
  it('batches pending human and peer messages in arrival order without human priority', async () => {
    const { room, adapters } = setup();
    await room.start();
    room.send('first');
    await tick();
    room.send('@codex second');
    adapters.claude!.finish([reply('m1')]);
    await tick();
    room.send('@codex fourth');
    adapters.codex!.finish();
    await tick();
    expect(adapters.codex!.inputs[1]!.messages.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
    adapters.codex!.finish();
    await tick();
    expect(
      room.session.messages.slice(1).every((m) => m.deliveries.codex?.status === 'passed'),
    ).toBe(true);
    await room.close();
  });
  it('makes directed exchanges public context without activating non-recipients or the author', async () => {
    const { room, adapters } = setup();
    await room.start();
    room.send('@codex inspect');
    await tick();
    adapters.codex!.finish([reply('m1', 'For human', ['human'])]);
    await tick();
    expect(adapters.claude!.inputs).toHaveLength(0);
    expect(adapters.codex!.inputs).toHaveLength(1);
    room.send('@claude now review');
    await tick();
    expect(adapters.claude!.inputs[0]!.context.map((m) => m.text)).toContain('For human');
    await room.close();
  });
  it('reserves the shared cap before concurrent follow-ups and parks only exhausted work', async () => {
    const { room, adapters } = setup(2);
    await room.start();
    room.send('Discuss');
    await tick();
    expect(room.session.exchanges.m1!.used).toBe(0);
    adapters.codex!.finish([reply('m1')]);
    adapters.claude!.finish([reply('m1')]);
    await tick();
    expect(room.session.exchanges.m1!.used).toBe(2);
    for (const a of Object.values(adapters)) a.finish([reply(a.inputs.at(-1)!.messages[0]!.id)]);
    await tick();
    expect(adapters.codex!.inputs).toHaveLength(2);
    expect(room.pending('codex').capped).toBe(1);
    room.send('Independent human message');
    await tick();
    expect(adapters.codex!.inputs.at(-1)!.messages.map((m) => m.id)).toEqual(['m6']);
    for (const a of Object.values(adapters)) a.finish();
    await tick();
    expect(room.session.exchanges.m1!.used).toBe(2);
    await room.continue('#m1');
    await tick();
    expect(room.session.exchanges.m1!.used).toBe(4);
    await room.close();
  });
  it('charges a batched follow-up once to every represented initiating exchange', async () => {
    const { room, adapters } = setup();
    await room.start();
    room.pause();
    room.send('@codex one');
    room.send('@codex two');
    await room.continue();
    await tick();
    adapters.codex!.finish([
      { messageIds: ['m1', 'm2'], kind: 'reply', text: 'Both', recipients: ['claude'] },
    ]);
    await tick();
    expect(room.session.exchanges.m1!.used).toBe(1);
    expect(room.session.exchanges.m2!.used).toBe(1);
    await room.close();
  });
  it('validates all outcomes before committing any; one failure does not stop peers', async () => {
    const { room, adapters } = setup();
    await room.start();
    room.send('one');
    await tick();
    adapters.codex!.finish([reply('m1'), reply('m1')]);
    await tick();
    expect(room.session.messages).toHaveLength(1);
    expect(room.session.agents.codex!.connection).toBe('unavailable');
    expect(room.session.messages[0]!.deliveries.codex!.status).toBe('failed');
    adapters.claude!.finish([reply('m1', 'Still working', ['human'])]);
    await tick();
    expect(room.session.messages).toHaveLength(2);
    await room.close();
  });
  it.each(['room', 'participant', 'stopped'])(
    'resumes a saved %s pause with queued and new messages active immediately',
    async (hold) => {
      const { room, adapters, getSaved } = setup();
      await room.start();
      if (hold === 'stopped') await room.stop('codex');
      else room.pause(hold === 'participant' ? 'codex' : undefined);
      room.send('@codex queued before closing');
      await tick();
      expect(adapters.codex!.inputs).toHaveLength(0);
      await room.close();
      const snapshot = getSaved();
      expect(snapshot.paused).toBe(true);
      const resumed = setup(8, snapshot);
      try {
        await resumed.room.start();
        await tick();
        expect(resumed.room.session.paused).toBe(false);
        expect(resumed.room.session.agents.codex).toMatchObject({
          paused: false,
          stopped: false,
          connection: 'ready',
        });
        expect(resumed.adapters.codex!.inputs[0]!.messages.map((message) => message.id)).toEqual([
          'm1',
        ]);
        resumed.adapters.codex!.finish();
        await tick();
        resumed.room.send('@codex new message after resume');
        await tick();
        expect(resumed.adapters.codex!.inputs[1]!.messages.map((message) => message.id)).toEqual([
          'm2',
        ]);
        expect(resumed.room.message('m1')!.deliveries.codex!.status).toBe('passed');
        expect(snapshot.paused).toBe(true); // Loading does not mutate the supplied snapshot.
      } finally {
        await resumed.room.close();
      }
    },
  );
  it.each(['capped', 'disabled'])(
    'keeps %s queued work held when a saved conversation resumes active',
    async (reason) => {
      const { room, adapters, getSaved } = setup(1);
      await room.start();
      room.pause('claude');
      room.send('@codex discuss');
      await tick();
      adapters.codex!.finish([reply('m1', 'Please review', ['claude'])]);
      await tick();
      if (reason === 'capped') room.session.exchanges.m1!.used = 1;
      await room.close();
      const resumed = setup(1, getSaved());
      if (reason === 'disabled') resumed.config.agents.claude!.enabled = false;
      try {
        await resumed.room.start();
        await tick();
        expect(resumed.room.session.paused).toBe(false);
        expect(resumed.adapters.claude?.inputs ?? []).toHaveLength(0);
        expect(resumed.room.message('m2')!.deliveries.claude!.status).toBe('queued');
        expect(resumed.room.session.exchanges.m1!.used).toBe(reason === 'capped' ? 1 : 0);
      } finally {
        await resumed.room.close();
      }
    },
  );
  it('pause finishes turns; stop preserves incomplete output; active resume never retries implicitly', async () => {
    const { room, adapters, getSaved } = setup();
    await room.start();
    room.send('@codex first');
    await tick();
    room.pause();
    room.send('@codex second');
    adapters.codex!.finish();
    await tick();
    expect(adapters.codex!.inputs).toHaveLength(1);
    await room.continue();
    await tick();
    adapters.codex!.events!({ type: 'text', text: 'partial result' });
    await room.stop('codex');
    expect(room.message('m2')!.deliveries.codex!.status).toBe('interrupted');
    expect(room.session.agents.codex!.draft).toBe('partial result');
    await room.continue('codex');
    await tick();
    expect(adapters.codex!.inputs).toHaveLength(0);
    room.retry('m2', 'codex');
    await tick();
    expect(adapters.codex!.inputs).toHaveLength(1);
    const snapshot = getSaved();
    await room.close();
    const resumed = setup(8, snapshot);
    await resumed.room.start();
    await tick();
    expect(resumed.room.session.paused).toBe(false);
    expect(resumed.room.session.agents.codex!.paused).toBe(false);
    expect(resumed.adapters.codex!.inputs).toHaveLength(0);
    expect(resumed.room.message('m2')!.deliveries.codex!.status).toBe('interrupted');
    await resumed.room.close();
  });
  it('applies reload only while idle and resets only changed agent identities', async () => {
    const { room, adapters, config } = setup();
    await room.start();
    room.send('@codex first');
    await tick();
    await expect(room.reload(config)).rejects.toThrow('idle');
    adapters.codex!.finish();
    await tick();
    const claude = adapters.claude;
    const changed = structuredClone(config);
    changed.agents.codex!.fingerprint = 'new';
    changed.agents.codex!.instructions = 'new instruction';
    await room.reload(changed);
    expect(adapters.codex!.starts).toEqual([undefined]);
    expect(adapters.claude).toBe(claude);
    expect(room.session.notices.some((n) => n.text.includes('fresh provider'))).toBe(true);
    await room.close();
  });
});

describe('recovery and lifecycle boundaries', () => {
  it('shows an explicit human question as waiting, without blocking later independent work', async () => {
    const { room, adapters } = setup();
    await room.start();
    room.send('@codex inspect');
    await tick();
    adapters.codex!.finish([
      {
        ...reply('m1', 'Which case should I inspect?', ['human']),
        awaitingHuman: true,
        question: { prompt: 'What should I inspect?', intent: 'free-text', choices: [] },
      },
    ]);
    await tick();
    expect(room.session.agents.codex!.activity).toBe('waiting');
    room.send('@codex zero');
    await tick();
    expect(room.session.agents.codex!.activity).toBe('considering');
    await room.close();
  });
  it('preserves all unresolved obligations when a byte-limited queue is split into batches', async () => {
    const { room, adapters } = setup();
    await room.start();
    room.pause();
    room.send('@codex ' + 'a'.repeat(40000));
    room.send('@codex ' + 'b'.repeat(40000));
    await room.continue();
    await tick();
    expect(adapters.codex!.inputs[0]!.messages.map((m) => m.id)).toEqual(['m1']);
    adapters.codex!.finish();
    await tick();
    expect(adapters.codex!.inputs[1]!.messages.map((m) => m.id)).toEqual(['m2']);
    await room.close();
  });
  it('does not dispatch when the durable pre-dispatch save fails', async () => {
    const { config } = setup();
    const adapter = new Fake();
    let writable = true;
    const room = new Room(
      config,
      {
        save() {
          if (!writable) throw new Error('Disk full');
        },
      },
      undefined,
      () => adapter,
    );
    await room.start();
    room.pause();
    room.send('@codex work');
    writable = false;
    await room.continue();
    await tick();
    expect(adapter.inputs).toHaveLength(0);
    expect(room.fatal).toContain('Disk full');
    await room.close();
  });
  it('waits for connecting adapters to close, so shutdown cannot leave a late child process', async () => {
    const { config } = setup();
    config.agents.claude!.enabled = false;
    let release!: () => void;
    let running = false;
    let closeCount = 0;
    const adapter: AgentAdapter = {
      async start() {
        await new Promise<void>((r) => {
          release = r;
        });
        running = true;
        return { restored: false };
      },
      async run() {
        throw new Error('Not expected');
      },
      async interrupt() {},
      async close() {
        running = false;
        closeCount++;
      },
    };
    const room = new Room(config, { save() {} }, undefined, () => adapter);
    const starting = room.start();
    let finished = false;
    const closing = room.close().then(() => {
      finished = true;
    });
    await tick();
    expect(finished).toBe(false);
    release();
    await starting;
    await closing;
    expect(running).toBe(false);
    expect(closeCount).toBeGreaterThanOrEqual(2);
  });
  it('restarts every participant before releasing work after a room permission change', async () => {
    const { room, adapters, config } = setup();
    await room.start();
    room.pause();
    room.send('queued');
    const old = Object.values(adapters);
    const next = structuredClone(config);
    next.permissions.edits = true;
    await room.reload(next);
    expect(Object.values(adapters).every((a) => !old.includes(a))).toBe(true);
    expect(Object.values(adapters).every((a) => a.inputs.length === 0)).toBe(true);
    await room.continue();
    await tick();
    expect(Object.values(adapters).every((a) => a.inputs.length === 1)).toBe(true);
    await room.close();
  });
});
it('applies a changed human name on the next turn without restarting agents or replaying history', async () => {
  const { room, adapters, config } = setup();
  config.humanName = 'Bill';
  await room.start();
  room.send('@codex first');
  await tick();
  const codex = adapters.codex!;
  expect(codex.inputs[0]!.humanName).toBe('Bill');
  codex.finish();
  await tick();
  await room.reload({ ...config, humanName: 'William' });
  expect(adapters.codex).toBe(codex);
  room.send('@codex second');
  await tick();
  expect(codex.inputs[1]!.humanName).toBe('William');
  expect(codex.inputs[1]!.messages.map((message) => message.id)).toEqual(['m2']);
  expect(room.message('m1')!.deliveries.codex!.status).toBe('passed');
  expect(room.session.messages.every((message) => message.author === 'human')).toBe(true);
  await room.close();
});
it('uses agent keys for two Codex participants in routing, labels and turn context', async () => {
  const { room, adapters, config } = setup();
  config.agents = Object.fromEntries(
    [
      ['astra', 'gpt-6-astra'],
      ['sol', 'gpt-5.6-sol'],
    ].map(([id, model]) => [
      id!,
      {
        id: id!,
        model,
        provider: 'codex' as const,
        enabled: true,
        instructions: '',
        fingerprint: id!,
      },
    ]),
  );
  await room.start();
  try {
    room.send('@astra first');
    await tick();
    const astra = adapters.astra!;
    const sol = adapters.sol!;
    expect(astra.inputs[0]!.participants).toEqual(['astra', 'sol']);
    expect(sol.inputs).toHaveLength(0);
    astra.finish([reply('m1', 'A question for Sol', ['sol'])]);
    await tick();
    expect(sol.inputs[0]!.messages[0]).toMatchObject({ author: 'astra', recipients: ['sol'] });
    sol.finish();
    await tick();
    const text = transcript(projectRoom(room), 160)
      .map((line) => cleanText(line.text))
      .join('\n');
    expect(text).toContain('astra  #m2 → @sol');
    expect(text).toContain('astra: contributed');
    room.send('@astra next');
    await tick();
    expect(astra.inputs[1]!.participants).toEqual(['astra', 'sol']);
    expect(astra.inputs[1]!.messages.map((m) => m.id)).toEqual(['m3']);
    expect(astra.inputs[1]!.context.map((m) => m.id)).toEqual(['m2']);
    expect(room.message('m2')).toMatchObject({ author: 'astra', recipients: ['sol'] });
  } finally {
    await room.close();
  }
});

it('reloads effort changes and removal for one participant while preserving public history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chittr-effort-'));
  const project = join(root, 'project');
  mkdirSync(join(project, '.agents'), { recursive: true });
  const write = (effort?: string) =>
    writeFileSync(
      join(project, '.agents/chittr.yaml'),
      `version: 1
skills: {enabled: false}
agents:
  astra: {provider: codex, model: gpt-6-astra${effort ? `, effort: ${effort}` : ''}}
  sol: {provider: codex, model: gpt-5.6-sol, effort: medium}
`,
    );
  write('high');
  const adapters: Record<string, Fake> = {};
  const room = new Room(
    loadConfig(project, root)!,
    { save() {} },
    undefined,
    (agent) => (adapters[agent.id] = new Fake()),
  );
  try {
    await room.start();
    room.send('@astra first');
    await tick();
    adapters.astra!.finish([reply('m1', 'Remember this answer', ['human'])]);
    await tick();
    const sol = adapters.sol;
    for (const effort of ['xhigh', undefined]) {
      const previous = adapters.astra;
      write(effort);
      await room.reload(loadConfig(project, root)!);
      expect(room.config.agents.astra!.effort).toBe(effort);
      expect(adapters.astra).not.toBe(previous);
      expect(adapters.astra!.starts).toEqual([undefined]);
      expect(adapters.sol).toBe(sol);
      room.send('@astra recall');
      await tick();
      expect(
        adapters.astra!.inputs[0]!.context.some((m) => m.text === 'Remember this answer'),
      ).toBe(true);
      adapters.astra!.finish();
      await tick();
    }
    const config = room.config;
    const astra = adapters.astra;
    write('hihg');
    await expect((async () => room.reload(loadConfig(project, root)!))()).rejects.toThrow(
      'Unsupported effort',
    );
    expect(room.config).toBe(config);
    expect(adapters.astra).toBe(astra);
    expect(adapters.sol).toBe(sol);
  } finally {
    await room.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('replaces the running fallback roster on reload and keeps the current config after an empty roster error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chittr-roster-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(project, '.agents'), { recursive: true });
  writeStarter(['codex', 'claude'], home);
  const adapters: Record<string, Fake> = {};
  const room = new Room(
    loadConfig(project, home)!,
    { save() {} },
    undefined,
    (agent) => (adapters[agent.id] = new Fake()),
  );
  try {
    await room.start();
    expect(room.enabledNames()).toEqual(['codex', 'claude']);
    writeFileSync(
      join(project, '.agents/chittr.yaml'),
      `version: 1
agents:
  astra: {provider: codex, model: gpt-6-astra}
  sol: {provider: codex, model: gpt-5.6-sol}
`,
    );
    await room.reload(loadConfig(project, home)!);
    expect(room.enabledNames()).toEqual(['astra', 'sol']);
    expect(room.session.agents.codex).toMatchObject({
      connection: 'unavailable',
      paused: true,
      detail: 'Removed from config',
    });
    room.send('Discuss this project');
    await tick();
    expect(adapters.codex!.inputs).toHaveLength(0);
    expect(adapters.claude!.inputs).toHaveLength(0);
    expect(adapters.astra!.inputs).toHaveLength(1);
    expect(adapters.sol!.inputs).toHaveLength(1);
    adapters.astra!.finish();
    adapters.sol!.finish();
    await tick();
    const current = room.config;
    writeFileSync(join(project, '.agents/chittr.yaml'), 'version: 1\nagents: {}\n');
    await expect((async () => room.reload(loadConfig(project, home)!))()).rejects.toThrow(
      'agents is empty',
    );
    expect(room.config).toBe(current);
    expect(room.enabledNames()).toEqual(['astra', 'sol']);
  } finally {
    await room.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps explicit questions open until a final human submission', async () => {
  const { room, adapters, getSaved } = setup();
  try {
    await room.start();
    room.send('@claude inspect');
    await tick();
    adapters.claude!.finish([
      {
        ...reply('m1', 'Probe first or paste and send?'),
        awaitingHuman: true,
        question: { prompt: 'What should I inspect?', intent: 'free-text', choices: [] },
      },
    ]);
    await tick();
    const question = room.message('m2')!;
    expect(question).toMatchObject({
      recipients: ['human'],
      question: { prompt: 'What should I inspect?', intent: 'free-text', choices: [] },
      deliveries: {},
    });
    expect(room.session.agents.claude!.connection).toBe('ready');
    expect(room.session.agents.claude!.activity).toBe('waiting');
    expect(adapters.codex!.inputs).toHaveLength(0);
    expect(getSaved().messages[1].question).toEqual({
      prompt: 'What should I inspect?',
      intent: 'free-text',
      choices: [],
    });

    room.send('@claude Independent work');
    await tick();
    expect(getSaved().agents.claude.awaitingHuman).toBe(true);
    adapters.claude!.finish();
    await tick();
    expect(room.unansweredQuestions().map((m) => m.id)).toEqual(['m2']);
    expect(room.session.agents.claude!.activity).toBe('waiting');
    room.send('@codex This is about something else', 'm2');
    await tick();
    adapters.codex!.finish();
    await tick();
    expect(room.unansweredQuestions().map((m) => m.id)).toEqual(['m2']);
    room.send('Just discussion', 'm2');
    expect(room.unansweredQuestions().map((m) => m.id)).toEqual(['m2']);
    const answer = room.answer('m2', 'Start with the probe');
    expect(answer.recipients).toEqual(['claude']);
    expect(room.unansweredQuestions()).toEqual([]);
    expect(room.session.agents.claude!.awaitingHuman).toBe(false);
    await tick();
    expect(adapters.claude!.inputs.at(-1)!.messages[0]!.replyTo).toEqual(['m2']);
    expect(adapters.claude!.inputs.at(-1)!.history!.find((m) => m.id === 'm2')!.question).toEqual({
      prompt: 'What should I inspect?',
      intent: 'free-text',
      choices: [],
    });
  } finally {
    await room.close();
  }
});

it('retains earlier questions when another question is answered, including after resume', async () => {
  const { room, adapters, getSaved } = setup();
  await room.start();
  for (const text of ['First task', 'Second task']) {
    const message = room.send('@codex ' + text);
    await tick();
    adapters.codex!.finish([
      {
        ...reply(message.id, 'Which option?', ['human']),
        question: {
          prompt: 'Which implementation should we start with?',
          intent: 'decision',
          choices: ['Keep', 'Remove'],
        },
      },
    ]);
    await tick();
  }
  const saved = getSaved();
  await room.close();
  const resumed = setup(8, saved);
  try {
    await resumed.room.start();
    expect(resumed.room.unansweredQuestions().map((m) => m.id)).toEqual(['m2', 'm4']);
    resumed.room.pause('codex');
    const answer = resumed.room.choose('m4', 2);
    expect(answer).toMatchObject({
      text: 'Remove',
      replyTo: ['m4'],
      recipients: ['codex'],
      roots: [answer.id],
    });
    expect(answer.deliveries.codex!.status).toBe('queued');
    expect(resumed.room.session.agents.codex!.paused).toBe(true);
    expect(resumed.room.session.agents.codex!.activity).toBe('waiting');
    expect(resumed.room.unansweredQuestions().map((m) => m.id)).toEqual(['m2']);
    expect(() => resumed.room.choose('m4', 1)).toThrow('already been answered');
    expect(resumed.room.session.permissions).toEqual(saved.permissions);
  } finally {
    await resumed.room.close();
  }
});

it.each([
  { kind: 'pass' as const, recipients: [] },
  { kind: 'reply' as const, recipients: ['codex'] },
  { kind: 'reply' as const, recipients: ['human', 'codex'] },
])(
  'rejects conflicting question routing without partially publishing the batch: %j',
  async (invalid) => {
    const { room, adapters } = setup();
    try {
      await room.start();
      room.pause('claude');
      room.send('@claude First');
      room.send('@claude Second');
      await room.continue('claude');
      await tick();
      adapters.claude!.finish([
        reply('m1', 'A valid contribution'),
        {
          ...reply('m2', 'Question'),
          ...invalid,
          awaitingHuman: true,
          question: { prompt: 'What should I inspect?', intent: 'free-text', choices: [] },
        },
      ]);
      await tick();
      expect(room.session.messages).toHaveLength(2);
      expect(room.session.messages.map((m) => m.deliveries.claude!.status)).toEqual([
        'failed',
        'failed',
      ]);
      expect(room.session.notices.at(-1)!.text).toContain('/retry #m1 @claude');
      expect(room.session.notices.at(-1)!.text).toContain('/continue @claude');
      expect(room.session.notices.at(-1)!.text).toContain('If the room is paused');
    } finally {
      await room.close();
    }
  },
);

async function consultationSetup(askerAdvice = false) {
  const setupResult = setup();
  const { room, adapters } = setupResult;
  await room.start();
  room.send('@claude inspect');
  await tick();
  adapters.claude!.finish([
    {
      ...reply('m1', 'Context for the decision', ['human']),
      question: { prompt: 'Which approach?', intent: 'decision', choices: ['Keep', 'Change'] },
      ...(askerAdvice
        ? { recommendation: { questionId: 'self', answer: 'Keep', reasoning: 'Smallest change' } }
        : {}),
    },
  ]);
  await tick();
  return setupResult;
}
const opinion = (requestId: string, answer = '/pause @claude\n  literal'): Outcome => ({
  messageIds: [requestId],
  recipients: ['human'],
  kind: 'reply',
  text: 'My advice',
  recommendation: {
    questionId: 'm2',
    requestId,
    answer,
    reasoning: 'Because this keeps the scope small',
  },
});

it('gathers human-only opinions, allows submission during active and paused deliveries, and restores without replay', async () => {
  const { room, adapters, getSaved } = await consultationSetup();
  try {
    room.pause('codex');
    const round = room.askRoom('m2')!;
    expect(round.recipients).toEqual(['codex', 'claude']);
    expect(() => room.askRoom('m2')).toThrow('already pending');
    await tick();
    expect(round.deliveries.claude!.status).toBe('sent');
    expect(round.deliveries.codex!.status).toBe('queued');
    expect(
      transcript(projectRoom(room), 160)
        .map((r) => r.text)
        .join('\n'),
    ).toContain('queued · paused');
    const answer = room.answer('m2', '  @human /stop\nKeep literal  ');
    adapters.claude!.finish([opinion(round.id)]);
    await tick();
    expect(room.unansweredQuestions()).toEqual([]);
    expect(
      room.session.messages.find((m) => m.recommendation?.requestId === round.id),
    ).toMatchObject({ author: 'claude', recipients: ['human'], deliveries: {} });
    expect(room.session.messages.filter((m) => m.finalAnswer)).toEqual([answer]);
    expect(
      transcript(projectRoom(room), 160)
        .map((r) => r.text)
        .join('\n'),
    ).toContain('received after submission');
    expect(() => room.askRoom('m2')).toThrow('already been answered');
    adapters.claude!.finish(); // final answer delivery
    await tick();
    await room.continue('codex');
    await tick();
    adapters.codex!.finish([opinion(round.id, 'Change')]);
    await tick();
    expect(Object.values(room.session.exchanges).every((exchange) => exchange.used === 0)).toBe(
      true,
    );
    const saved = getSaved();
    await room.close();
    const restored = setup(8, saved);
    await restored.room.start();
    await tick();
    expect(restored.adapters.codex!.inputs).toHaveLength(0);
    expect(restored.adapters.claude!.inputs).toHaveLength(0);
    expect(restored.room.unansweredQuestions()).toEqual([]);
    await restored.room.close();
  } finally {
    await room.close();
  }
});

it('retains asker advice, excludes that asker, supports pass and explicit retry, and prevents old-round revival', async () => {
  const { room, adapters } = await consultationSetup(true);
  try {
    room.session.agents.codex!.connection = 'unavailable';
    const round = room.askRoom('m2')!;
    expect(round.recipients).toEqual(['codex']);
    await tick();
    expect(round.deliveries.codex!.status).toBe('queued');
    await room.reconnect('codex');
    await room.continue('codex');
    await tick();
    await room.stop('codex');
    expect(round.deliveries.codex!.status).toBe('interrupted');
    await room.continue('codex');
    room.retry(round.id, 'codex');
    await tick();
    adapters.codex!.finish([
      { messageIds: [round.id], recipients: ['human'], kind: 'pass', text: 'Need more evidence' },
    ]);
    await tick();
    expect(round.deliveries.codex).toMatchObject({
      status: 'passed',
      rationale: 'Need more evidence',
    });
    expect(() => room.retry(round.id, 'codex')).toThrow('Only an interrupted');
    const second = room.askRoom('m2')!;
    await tick();
    await room.stop('codex');
    const third = room.askRoom('m2')!;
    await room.continue('codex');
    expect(() => room.retry(second.id, 'codex')).toThrow('older opinion round');
    await tick();
    adapters.codex!.finish([opinion(third.id)]);
    await tick();
    room.retry(second.id, 'codex');
    await tick();
    adapters.codex!.finish([opinion(second.id)]);
    await tick();
    expect(second.deliveries.codex!.status).toBe('contributed');
    expect(room.unansweredQuestions()).toHaveLength(1);
    room.config.agents.codex!.enabled = false;
    const count = room.session.messages.length;
    expect(room.askRoom('m2')).toBeUndefined();
    expect(room.session.messages).toHaveLength(count);
    expect(room.session.notices.at(-1)!.text).toContain('No eligible agents');
  } finally {
    await room.close();
  }
});

it.each([
  'mixed',
  'fanout',
  'wrong-target',
  'forged-human',
  'forged-consultation',
  'claimed-author',
  'missing-recommendation',
])('rejects %s consultation outcomes atomically without partial publication', async (mode) => {
  const { room, adapters } = await consultationSetup(true);
  try {
    room.pause('codex');
    const round = room.askRoom('m2')!;
    const ordinary = room.send('@codex ordinary work');
    await room.continue('codex');
    await tick();
    const advice = opinion(round.id) as Outcome & Record<string, unknown>;
    if (mode === 'mixed') advice.messageIds.push(ordinary.id);
    if (mode === 'fanout') advice.recipients = [];
    if (mode === 'wrong-target') advice.recommendation!.questionId = ordinary.id;
    if (mode === 'forged-human') advice.finalAnswer = { questionId: 'm2' };
    if (mode === 'forged-consultation') advice.consultation = { questionId: 'm2' };
    if (mode === 'claimed-author') advice.author = 'human';
    if (mode === 'missing-recommendation') delete advice.recommendation;
    const before = room.session.messages.length;
    adapters.codex!.finish(
      mode === 'mixed' ? [advice] : [reply(ordinary.id, 'Would publish first', ['human']), advice],
    );
    await tick();
    expect(room.session.messages).toHaveLength(before);
    expect(round.deliveries.codex!.status).toBe('failed');
    expect(ordinary.deliveries.codex!.status).toBe('failed');
    expect(room.unansweredQuestions()).toHaveLength(1);
  } finally {
    await room.close();
  }
});

it('accepts separate consultation and ordinary outcomes in a batched turn and supplies old context', async () => {
  const { room, adapters } = await consultationSetup(true);
  try {
    room.pause('codex');
    const round = room.askRoom('m2')!;
    const ordinary = room.send('@codex ordinary work');
    await room.continue('codex');
    await tick();
    const input = adapters.codex!.inputs.at(-1)!;
    expect(input.messages.map((m) => m.id)).toEqual([round.id, ordinary.id]);
    const { turnPrompt } = await import('../src/protocol.js');
    const envelope = JSON.parse(turnPrompt({ ...input, context: [] }));
    expect(envelope.consultationContext[0]).toMatchObject({
      requestId: round.id,
      question: [{ id: 'm2', question: { prompt: 'Which approach?' } }],
      recommendations: [{ author: 'claude', recommendation: { questionId: 'm2', answer: 'Keep' } }],
    });
    adapters.codex!.finish([
      opinion(round.id),
      { messageIds: [ordinary.id], recipients: [], kind: 'pass', text: 'Noted' },
    ]);
    await tick();
    expect(round.deliveries.codex!.status).toBe('contributed');
    expect(ordinary.deliveries.codex!.status).toBe('passed');
    expect(room.unansweredQuestions()).toHaveLength(1);
  } finally {
    await room.close();
  }
});

it('interrupts disabled queued consultation recipients on reload and resume without replay or permanent round lockout', async () => {
  const { room, adapters, getSaved } = await consultationSetup(true);
  try {
    room.pause('codex');
    const round = room.askRoom('m2')!;
    const queuedSnapshot = getSaved();
    const disabledConfig = structuredClone(room.config);
    disabledConfig.agents.codex!.enabled = false;
    await room.reload(disabledConfig);
    expect(round.deliveries.codex).toMatchObject({
      status: 'interrupted',
      rationale: expect.stringContaining('no longer enabled'),
    });
    expect(() => room.retry(round.id, 'codex')).toThrow('Re-enable');
    expect(room.askRoom('m2')).toBeUndefined();
    expect(room.session.notices.at(-1)!.text).toContain('No eligible agents');
    const restored = new Room(disabledConfig, { save() {} }, queuedSnapshot, () => new Fake());
    expect(restored.message(round.id)?.deliveries.codex!.status).toBe('interrupted');
    await restored.close();
    const enabledConfig = structuredClone(disabledConfig);
    enabledConfig.agents.codex!.enabled = true;
    await room.reload(enabledConfig);
    const next = room.askRoom('m2')!;
    await room.continue('codex');
    await tick();
    expect(adapters.codex!.inputs.at(-1)!.messages.map((m) => m.id)).toEqual([next.id]);
    adapters.codex!.finish([opinion(next.id)]);
    await tick();
  } finally {
    await room.close();
  }
});
