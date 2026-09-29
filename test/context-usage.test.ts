import { EventEmitter } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { GrokAdapter } from '../src/adapters/grok.js';
import { contextUsage, contextPercent, formatContextUsage } from '../src/context-usage.js';
import type { AdapterEvent, AgentAdapter, AgentConfig, RoomConfig } from '../src/types.js';

const config: RoomConfig = {
  workspace: '/workspace',
  permissions: { edits: false, commands: false, network: false },
  followUpTurns: 8,
  agents: {},
  sources: [],
  provenance: {},
  skills: { enabled: false },
};
const input = { messages: [], context: [], participants: ['agent'] };
const output = { outcomes: [{ messageIds: ['m1'], recipients: [], kind: 'pass', text: 'Done' }] };
const adapters: AgentAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
});

class Wire extends EventEmitter {
  closed = false;
  send() {}
  async rpc() {
    return { turn: { id: 'turn' } };
  }
  async close() {
    this.closed = true;
  }
}
function setup(provider: 'codex' | 'claude' | 'grok') {
  const agent: AgentConfig = {
    id: 'agent',
    provider,
    enabled: true,
    instructions: '',
    fingerprint: provider,
  };
  const adapter =
    provider === 'codex'
      ? new CodexAdapter(agent, config)
      : provider === 'claude'
        ? new ClaudeAdapter(agent, config)
        : new GrokAdapter(agent, config);
  const wire = new Wire();
  const tools = {
    setHistory() {},
    beginTurn() {},
    registerRetrievalBridge() {},
    endTurn() {},
    close() {},
    interrupt() {},
  };
  Object.assign(adapter, {
    proc: wire,
    threadId: 'session',
    sessionId: 'session',
    historyTools: tools,
    runtime: { tools, close() {} },
  });
  adapters.push(adapter);
  const events: AdapterEvent[] = [];
  const run = () => adapter.run(input, (event) => events.push(event), new AbortController().signal);
  const readings = () => events.filter((event) => event.type === 'context');
  return { wire, run, readings };
}

it('keeps unknown, zero, and over-limit context readings distinct', () => {
  expect(formatContextUsage()).toBe('unavailable');
  expect(formatContextUsage(contextUsage(0, 200000))).toBe('0 / 200,000 tokens · 0.0% used');
  expect(formatContextUsage(contextUsage(72000, 200000))).toBe(
    '72,000 / 200,000 tokens · 36.0% used',
  );
  expect(formatContextUsage(contextUsage(72000, 0))).toBe('72,000 tokens · limit unavailable');
  expect(contextPercent(contextUsage(220000, 200000))).toBeCloseTo(110);
  for (const value of [NaN, Infinity, -1, 0.5, '12', null, undefined])
    expect(contextUsage(value)).toBeUndefined();
});

it('reads Codex latest usage without adding cached tokens or cumulative turn totals', async () => {
  const { wire, run, readings } = setup('codex');
  const pending = run();
  await Promise.resolve();
  const report = (threadId: string, totalTokens: unknown, modelContextWindow: unknown = 200000) =>
    wire.emit('message', {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId: 'turn',
        tokenUsage: {
          last: { totalTokens, inputTokens: 70000, cachedInputTokens: 60000 },
          total: { totalTokens: 980000 },
          modelContextWindow,
        },
      },
    });
  report('another-session', 100);
  report('session', -1);
  expect(readings()).toHaveLength(0);
  report('session', 72000);
  expect(readings().at(-1)?.usage).toMatchObject({ usedTokens: 72000, maxTokens: 200000 });
  wire.emit('message', {
    method: 'item/started',
    params: { threadId: 'session', item: { type: 'contextCompaction' } },
  });
  expect(readings().at(-1)?.usage).toBeUndefined();
  report('session', 12000, null);
  expect(readings().at(-1)?.usage).toMatchObject({ usedTokens: 12000 });
  expect(readings().at(-1)?.usage?.maxTokens).toBeUndefined();
  wire.emit('message', {
    method: 'item/completed',
    params: { item: { type: 'agentMessage', text: JSON.stringify(output) } },
  });
  wire.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await pending;
});

it('uses Claude latest input plus cache counts and the matching model limit, never result totals', async () => {
  const { wire, run, readings } = setup('claude');
  const pending = run();
  const assistant = (usage: unknown, extra = {}) =>
    wire.emit('message', {
      type: 'assistant',
      session_id: 'session',
      message: { model: 'resolved-model', usage, content: [] },
      ...extra,
    });
  assistant({ input_tokens: 100 }, { session_id: 'other' });
  assistant({ input_tokens: 100 }, { parent_tool_use_id: 'child' });
  assistant({ input_tokens: '100' });
  assistant({ input_tokens: 0 }, { message: { model: '<synthetic>', usage: { input_tokens: 0 } } });
  assistant({ input_tokens: 0 }, { isApiErrorMessage: true });
  expect(readings()).toHaveLength(0);
  assistant({
    input_tokens: 2000,
    cache_read_input_tokens: 60000,
    cache_creation_input_tokens: 10000,
    output_tokens: 9000,
  });
  assistant({
    input_tokens: 2000,
    cache_read_input_tokens: 60000,
    cache_creation_input_tokens: 10000,
  });
  expect(readings().at(-1)?.usage?.usedTokens).toBe(72000);
  expect(readings().at(-1)?.usage?.maxTokens).toBeUndefined();
  wire.emit('message', {
    type: 'result',
    structured_output: output,
    usage: { input_tokens: 900000 },
    modelUsage: {
      'other-model': { contextWindow: 1000000, inputTokens: 900000 },
      'resolved-model[1m]': { contextWindow: 200000, inputTokens: 800000 },
    },
  });
  await pending;
  expect(readings().at(-1)?.usage).toMatchObject({ usedTokens: 72000, maxTokens: 200000 });
  const second = run();
  wire.emit('message', { type: 'system', subtype: 'compact_boundary' });
  expect(readings().at(-1)?.usage).toBeUndefined();
  assistant({ input_tokens: 1000, cache_read_input_tokens: 9000 });
  expect(readings().at(-1)?.usage).toMatchObject({ usedTokens: 10000, maxTokens: 200000 });
  wire.emit('message', { type: 'result', structured_output: output });
  await second;
});

it('does not guess Claude context from a different model or aggregate-only result', async () => {
  const { wire, run, readings } = setup('claude');
  let pending = run();
  wire.emit('message', {
    type: 'result',
    structured_output: output,
    usage: { input_tokens: 50000 },
    modelUsage: { model: { contextWindow: 200000 } },
  });
  await pending;
  expect(readings()).toHaveLength(0);
  pending = run();
  wire.emit('message', {
    type: 'assistant',
    message: { model: 'actual-model', usage: { input_tokens: 1000 } },
  });
  wire.emit('message', {
    type: 'result',
    structured_output: output,
    modelUsage: { model: { contextWindow: 200000 } },
  });
  await pending;
  expect(readings().at(-1)?.usage?.maxTokens).toBeUndefined();
});

it('drops an ambiguous Claude limit and preserves the last reading on a synthetic API error', async () => {
  const { wire, run, readings } = setup('claude');
  let pending = run();
  wire.emit('message', {
    type: 'assistant',
    message: { model: 'model', usage: { input_tokens: 72000 } },
  });
  wire.emit('message', {
    type: 'result',
    structured_output: output,
    modelUsage: { model: { contextWindow: 200000 }, 'model[1m]': { contextWindow: 1000000 } },
  });
  await pending;
  const latest = readings().at(-1)?.usage;
  expect(latest?.usedTokens).toBe(72000);
  expect(latest?.maxTokens).toBeUndefined();
  pending = run();
  wire.emit('message', {
    type: 'assistant',
    message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
  });
  wire.emit('message', { type: 'result', is_error: true, errors: ['Provider error'] });
  await expect(pending).rejects.toThrow('Provider error');
  expect(readings().at(-1)?.usage).toEqual(latest);
});

it('accepts Grok ACP context updates only for the active session with a valid limit', async () => {
  const { wire, run, readings } = setup('grok');
  wire.rpc = async () => {
    for (const [sessionId, used, size] of [
      ['other', 50, 100],
      ['session', 50, null],
      ['session', 53000, 200000],
    ])
      wire.emit('message', {
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'usage_update', used, size } },
      });
    wire.emit('message', {
      method: 'session/update',
      params: {
        sessionId: 'session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: JSON.stringify(output) },
        },
      },
    });
    return { stopReason: 'end_turn' } as any;
  };
  await run();
  expect(readings()).toHaveLength(1);
  expect(readings()[0]?.usage).toMatchObject({ usedTokens: 53000, maxTokens: 200000 });
});
