import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import type { RoomConfig } from '../src/types.js';
class Wire extends EventEmitter {
  sent: any[] = [];
  send(message: any) {
    this.sent.push(message);
  }
  async close() {}
}
const adapters: ClaudeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close();
});
function setup() {
  const config: RoomConfig = {
    workspace: '/workspace',
    permissions: { edits: false, commands: false, network: false },
    followUpTurns: 1,
    agents: {},
    sources: [],
    provenance: {},
  };
  const adapter = new ClaudeAdapter(
    { id: 'a', provider: 'claude', enabled: true, instructions: '', fingerprint: 'a' },
    config,
  );
  const wire = new Wire();
  Object.assign(adapter, {
    proc: wire,
    sessionId: 'session',
    historyTools: {
      setMaintenance() {},
      setHistory() {},
      registerRetrievalBridge() {},
      beginTurn() {},
      endTurn() {},
      close() {},
      interrupt() {},
    },
  });
  adapters.push(adapter);
  return { adapter, wire };
}
it.each(['single', 'array'])(
  'requires matching Claude maintenance request UUID via %s field',
  async (field) => {
    const { adapter, wire } = setup();
    let settled = false;
    const pending = adapter
      .maintain(
        { id: 'operation', kind: 'seed', prompt: 'Accept seed' },
        new AbortController().signal,
      )
      .then((value) => {
        settled = true;
        return value;
      });
    const uuid = wire.sent[0].uuid;
    const result = {
      type: 'result',
      session_id: 'session',
      structured_output: { maintenance: { operationId: 'operation', text: 'seed accepted' } },
    };
    wire.emit('message', { ...result, user_message_uuid: 'foreign' });
    await Promise.resolve();
    expect(settled).toBe(false);
    wire.emit('message', {
      ...result,
      ...(field === 'single'
        ? { user_message_uuid: uuid }
        : { user_message_uuids: ['foreign', uuid] }),
    });
    await expect(pending).resolves.toEqual({ text: 'seed accepted', sessionId: 'session' });
    expect(wire.listenerCount('message')).toBe(0);
  },
);
it('fails promptly with an explicit protocol error when a maintenance result has no UUID', async () => {
  const { adapter, wire } = setup();
  const pending = adapter.maintain(
    { id: 'operation', kind: 'seed', prompt: 'Accept seed' },
    new AbortController().signal,
  );
  wire.emit('message', { type: 'result', session_id: 'session', result: '{}' });
  await expect(pending).rejects.toThrow('lacks user-message UUID correlation');
  expect(wire.listenerCount('message')).toBe(0);
});

const refusalExplanation =
  "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.";
const turnInput = { messages: [], context: [], participants: ['a'] };
const turnOutput = {
  outcomes: [
    {
      messageIds: ['m1'],
      recipients: [],
      kind: 'pass' as const,
      text: 'Done',
      awaitingHuman: false,
    },
  ],
};
function request(adapter: ClaudeAdapter, kind: 'run' | 'maintain') {
  return kind === 'run'
    ? adapter.run(turnInput, () => {}, new AbortController().signal)
    : adapter.maintain(
        { id: 'operation', kind: 'checkpoint', prompt: 'Summarize' },
        new AbortController().signal,
      );
}
function refusal(form: 'system' | 'assistant', uuid?: string) {
  return form === 'system'
    ? {
        type: 'system',
        subtype: 'model_refusal_no_fallback',
        session_id: 'session',
        api_refusal_category: 'reasoning_extraction',
        api_refusal_explanation: refusalExplanation,
        ...(uuid ? { refused_user_message_uuid: uuid } : {}),
      }
    : {
        type: 'assistant',
        session_id: 'session',
        parent_tool_use_id: null,
        is_api_error_message: true,
        message: {
          model: '<synthetic>',
          stop_reason: 'refusal',
          stop_details: {
            type: 'refusal',
            category: 'reasoning_extraction',
            explanation: refusalExplanation,
          },
          content: [{ type: 'text', text: 'Provider refusal' }],
        },
      };
}

it.each(['run', 'maintain'] as const)(
  'rejects %s promptly for each captured Claude refusal form',
  async (kind) => {
    for (const form of ['system', 'assistant'] as const) {
      vi.useFakeTimers();
      try {
        const { adapter, wire } = setup();
        const pending = request(adapter, kind);
        const uuid = wire.sent.find((message) => message.type === 'user')!.uuid;
        wire.emit('message', refusal(form, uuid));
        await expect(pending).rejects.toThrow(
          `Claude provider refusal (reasoning_extraction): ${refusalExplanation}`,
        );
        expect(wire.sent.some((message) => message.request?.subtype === 'interrupt')).toBe(true);
        expect(wire.listenerCount('message')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  },
);

it('accepts an absent system refusal UUID but ignores an explicitly foreign UUID', async () => {
  const first = setup();
  const rejected = request(first.adapter, 'run');
  first.wire.emit('message', refusal('system'));
  await expect(rejected).rejects.toThrow('Claude provider refusal');

  const second = setup();
  let settled = false;
  const pending = request(second.adapter, 'run').then((value) => {
    settled = true;
    return value;
  });
  second.wire.emit('message', refusal('system', 'foreign'));
  await Promise.resolve();
  expect(settled).toBe(false);
  second.wire.emit('message', {
    type: 'result',
    session_id: 'session',
    structured_output: turnOutput,
  });
  await expect(pending).resolves.toEqual({ ...turnOutput, sessionId: 'session' });
});

it('does not treat a non-refusal synthetic API error as a provider refusal', async () => {
  const { adapter, wire } = setup();
  const pending = request(adapter, 'run');
  wire.emit('message', {
    ...refusal('assistant'),
    message: {
      stop_reason: 'end_turn',
      stop_details: { type: 'api_error', category: 'overloaded' },
      content: [],
    },
  });
  wire.emit('message', {
    type: 'result',
    session_id: 'session',
    structured_output: turnOutput,
  });
  await expect(pending).resolves.toEqual({ ...turnOutput, sessionId: 'session' });
  expect(wire.sent.some((message) => message.request?.subtype === 'interrupt')).toBe(false);
});

it('rejects later requests on a refused transport without dispatch and a fresh adapter dispatches', async () => {
  const refused = setup();
  const first = request(refused.adapter, 'run');
  const uuid = refused.wire.sent.find((message) => message.type === 'user')!.uuid;
  refused.wire.emit('message', refusal('system', uuid));
  await expect(first).rejects.toThrow('Claude provider refusal');
  const sentBeforeRetry = refused.wire.sent.filter((message) => message.type === 'user').length;
  await expect(request(refused.adapter, 'run')).rejects.toThrow(
    'Claude transport is unavailable after a provider refusal; reconnect first',
  );
  expect(refused.wire.sent.filter((message) => message.type === 'user')).toHaveLength(
    sentBeforeRetry,
  );
  expect(refused.wire.listenerCount('message')).toBe(0);
  refused.wire.emit('message', {
    type: 'result',
    session_id: 'session',
    structured_output: turnOutput,
  });
  expect(refused.wire.sent.filter((message) => message.type === 'user')).toHaveLength(
    sentBeforeRetry,
  );

  const fresh = setup();
  const restored = request(fresh.adapter, 'run');
  fresh.wire.emit('message', {
    type: 'result',
    session_id: 'session',
    structured_output: turnOutput,
  });
  await expect(restored).resolves.toEqual({ ...turnOutput, sessionId: 'session' });
});

function native() {
  const { adapter, wire } = setup();
  adapter.nativeCompaction = true;
  const gates: boolean[] = [];
  Object.assign(adapter, {
    historyTools: {
      setMaintenance(value: boolean) {
        gates.push(value);
      },
      close() {},
      interrupt() {},
    },
  });
  const boundary = (uuid = 'boundary', extra = {}) =>
    wire.emit('message', {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'session',
      uuid,
      compact_metadata: { trigger: 'manual' },
      ...extra,
    });
  const result = (extra = {}) =>
    wire.emit('message', {
      type: 'result',
      subtype: 'success',
      session_id: 'session',
      user_message_uuid: wire.sent.filter((m) => m.type === 'user').at(-1).uuid,
      ...extra,
    });
  return { adapter, wire, gates, boundary, result };
}
it('sends native focus and requires a fresh manual boundary plus the matching result', async () => {
  const { adapter, wire, gates, boundary, result } = native();
  let settled = false;
  const pending = adapter
    .compact('first', new AbortController().signal, 'Remember epic 42\nand ticket 17')
    .then((r) => {
      settled = true;
      return r;
    });
  expect(wire.sent[0].message.content).toBe('/compact Remember epic 42 and ticket 17');
  boundary('foreign', { session_id: 'other' });
  result({ user_message_uuid: 'foreign' });
  await Promise.resolve();
  expect(settled).toBe(false);
  boundary();
  result();
  await expect(pending).resolves.toEqual({ status: 'completed' });
  expect(gates).toEqual([true, false]);
  const second = adapter.compact('second', new AbortController().signal);
  expect(wire.sent.filter((m) => m.type === 'user').at(-1).message.content).toBe('/compact');
  boundary();
  result();
  await expect(second).rejects.toThrow('did not emit');
  expect(wire.listenerCount('message')).toBe(0);
});
it('recognizes only the verified correlated Claude no-op response', async () => {
  const { adapter, result, gates } = native();
  const pending = adapter.compact('noop', new AbortController().signal);
  result({ result: 'Not enough messages to compact.' });
  await expect(pending).resolves.toEqual({ status: 'nothing-to-compact' });
  expect(gates).toEqual([true, false]);
});
it.each([
  { result: "/compact isn't available in this environment." },
  { is_error: true, result: 'Provider failed' },
  { user_message_uuid: undefined },
])('rejects unsupported, failed and uncorrelated Claude native results: %j', async (reply) => {
  const { adapter, result, wire, gates } = native();
  const pending = adapter.compact('bad', new AbortController().signal);
  result(reply);
  await expect(pending).rejects.toThrow();
  expect(gates).toEqual([true]);
  expect(wire.sent.some((m) => m.request?.subtype === 'interrupt')).toBe(true);
  expect(wire.listenerCount('message')).toBe(0);
});
it('interrupts Claude native compaction on cancellation and sends nothing for an already aborted request', async () => {
  const { adapter, wire } = native();
  const ctrl = new AbortController();
  ctrl.abort();
  await expect(adapter.compact('pre', ctrl.signal)).rejects.toThrow();
  expect(wire.sent).toEqual([]);
  const next = new AbortController();
  const pending = adapter.compact('cancel', next.signal);
  next.abort();
  await expect(pending).rejects.toThrow('interrupted');
  expect(wire.sent.some((m) => m.request?.subtype === 'interrupt')).toBe(true);
});

// #105: no build launches with --disable-slash-commands. The live init
// inventory is the per-process check that the launch controls held: a native
// tool in it aborts the turn, and the compaction, before any result is taken.
it.each([['Skill'], ['Agent'], ['Task'], ['Bash', 'Skill']])(
  'aborts an ordinary Claude turn whose live inventory exposes %j',
  async (...unexpected: string[]) => {
    const { adapter, wire } = setup();
    const pending = request(adapter, 'run');
    wire.emit('message', {
      type: 'system',
      subtype: 'init',
      session_id: 'session',
      tools: ['StructuredOutput', 'mcp__chittr__read_conversation', ...unexpected],
    });
    await expect(pending).rejects.toThrow(
      `Unexpected Claude tools would bypass room policy: ${unexpected.join(', ')}`,
    );
    expect(wire.sent.some((m) => m.request?.subtype === 'interrupt')).toBe(true);
    expect(adapter.imageEvidence.nativeInventoryVerified).toBe(false);
  },
);
it('rejects unexpected native tools before Claude compaction can complete', async () => {
  const { adapter, wire } = native();
  const pending = adapter.compact('op', new AbortController().signal);
  wire.emit('message', {
    type: 'system',
    subtype: 'init',
    session_id: 'session',
    tools: ['Skill', 'Bash'],
  });
  await expect(pending).rejects.toThrow('Unexpected Claude tools');
});

it('times out Claude native compaction and closes the uncertain session', async () => {
  vi.useFakeTimers();
  try {
    const { adapter, wire } = native();
    const pending = adapter.compact('op', new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(120000);
    await rejected;
    expect(wire.sent.some((m) => m.request?.subtype === 'interrupt')).toBe(true);
    expect(wire.listenerCount('message')).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('normalizes control whitespace only in the outgoing Claude compact command', async () => {
  const { adapter, wire, result } = native();
  const pending = adapter.compact(
    'op',
    new AbortController().signal,
    'Retain epic\r\n42\tand\u2028ticket\u202917',
  );
  expect(wire.sent[0].message.content).toBe('/compact Retain epic 42 and ticket 17');
  result({ result: 'Not enough messages to compact.' });
  await pending;
});
