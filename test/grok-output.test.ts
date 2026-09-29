import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { GrokAdapter, grokOutput, grokStopMessage } from '../src/adapters/grok.js';
import type { RoomConfig } from '../src/types.js';

function setup() {
  const adapter = new GrokAdapter(
    { id: 'grok', provider: 'grok', enabled: true, instructions: '', fingerprint: 'grok' },
    {} as RoomConfig,
  );
  const calls: any[] = [],
    gates: boolean[] = [];
  const wire = Object.assign(new EventEmitter(), {
    text: '',
    result: { stopReason: 'end_turn' } as any,
    closed: false,
    async rpc(method: string, params: any) {
      calls.push({ method, params });
      wire.emit('message', {
        method: 'session/update',
        params: {
          sessionId: 'session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: this.text },
          },
        },
      });
      return this.result;
    },
    async close() {
      this.closed = true;
    },
  });
  Object.assign(adapter, {
    proc: wire,
    sessionId: 'session',
    runtime: {
      tools: {
        setHistory() {},
        beginTurn() {},
        endTurn() {},
        setMaintenance(value: boolean) {
          gates.push(value);
        },
        interrupt() {},
      },
      close() {},
    },
  });
  return { adapter, wire, calls, gates };
}
const reply = {
  outcomes: [
    {
      messageIds: ['m1'],
      recipients: [],
      kind: 'reply',
      text: 'Done',
      awaitingHuman: false,
      question: null,
    },
  ],
};
const signal = () => new AbortController().signal;
const input = { messages: [], context: [], participants: [] };

it('accepts a known terminal marker without repairing or extracting partial JSON', async () => {
  const x = setup();
  x.wire.text = JSON.stringify(reply) + '<|eos|>\n';
  expect((await x.adapter.run(input, () => {}, signal())).outcomes[0]!.text).toBe('Done');
  expect(x.calls[0].params._meta.outputSchema).toBeUndefined();
  expect(grokOutput('{"text":"<|eos|>"}<|eos|>')).toBe('{"text":"<|eos|>"}');
  for (const text of [
    '{"outcomes":[{"text":"unfinished',
    JSON.stringify(reply) + ' unexpected commentary',
  ]) {
    x.wire.text = text;
    await expect(x.adapter.run(input, () => {}, signal())).rejects.toThrow(
      'incomplete or invalid JSON; no reply was published',
    );
  }
});

it('uses native structured output only for maintenance and keeps the normal turn tool-capable', async () => {
  const x = setup();
  x.wire.result._meta = {
    structuredOutput: { maintenance: { operationId: 'seed', text: 'seed accepted' } },
  };
  const result = await x.adapter.maintain(
    { id: 'seed', kind: 'seed', prompt: 'Restore context' },
    signal(),
  );
  expect(result.text).toBe('seed accepted');
  expect(x.calls[0].params._meta.outputSchema.required).toEqual(['maintenance']);
  expect(x.gates).toEqual([true, false]);
  x.wire.result = { stopReason: 'end_turn' };
  x.wire.text = JSON.stringify(reply);
  await x.adapter.run(input, () => {}, signal());
  expect(x.calls[1].params._meta.outputSchema).toBeUndefined();
  x.wire.result._meta = { structuredOutputError: 'invalid output' };
  await expect(
    x.adapter.maintain({ id: 'seed', kind: 'seed', prompt: 'Restore context' }, signal()),
  ).rejects.toThrow('valid context summary');
  expect(x.wire.closed).toBe(true);
});

it('reports cancellation metadata and never publishes a partial reply from a cancelled turn', async () => {
  const x = setup();
  x.wire.text = JSON.stringify(reply);
  x.wire.result = {
    stopReason: 'cancelled',
    _meta: {
      cancellationCategory: 'PermissionCancelled',
      cancellationContext: { tool_name: 'native_shell', reason: 'Permission denied' },
    },
  };
  await expect(x.adapter.run(input, () => {}, signal())).rejects.toThrow(
    'PermissionCancelled; Permission denied; tool: native_shell',
  );
  expect(x.wire.closed).toBe(true);
  expect(grokStopMessage({ stopReason: 'cancelled' })).toContain(
    'provider supplied no further reason',
  );
  expect(grokStopMessage({ stopReason: 'cancelled' }, 'native_shell')).toContain(
    'room policy denied tool native_shell',
  );
});

it.each(['Schema mismatch\n\u001b' + 'x'.repeat(500), { reason: 'Schema mismatch', limit: 12 }])(
  'retains a bounded provider structured-output diagnostic: %j',
  async (diagnostic) => {
    const x = setup();
    x.wire.result._meta = { structuredOutputError: diagnostic };
    const error = await x.adapter
      .maintain({ id: 'seed', kind: 'seed', prompt: 'Restore context' }, signal())
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Schema mismatch');
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(message.length).toBeLessThan(480);
    if (typeof diagnostic === 'object') expect(message).toContain('"limit":12');
    expect(x.wire.closed).toBe(true);
  },
);
