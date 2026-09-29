import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex.js';
import type { RoomConfig } from '../src/types.js';
class Wire extends EventEmitter {
  closed = false;
  calls: { method: string; params: any }[] = [];
  async rpc(method: string, params: any) {
    this.calls.push({ method, params });
    return {};
  }
  async close() {
    this.closed = true;
    this.emit('disconnect', new Error('closed'));
  }
}
const config: RoomConfig = {
  workspace: '/workspace',
  permissions: { edits: false, commands: false, network: false },
  followUpTurns: 1,
  agents: {},
  sources: [],
  provenance: {},
};
const adapters: CodexAdapter[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const a of adapters.splice(0)) await a.close();
});
function setup() {
  const a = new CodexAdapter(
    { id: 'a', provider: 'codex', enabled: true, instructions: '', fingerprint: 'a' },
    config,
  );
  const wire = new Wire();
  Object.assign(a, { proc: wire, threadId: 'thread' });
  adapters.push(a);
  const send = (method: string, data: any = {}) =>
    wire.emit('message', { method, params: { threadId: 'thread', ...data } });
  const start = () => {
    send('turn/started', { turn: { id: 'compact' } });
    send('item/started', { turnId: 'compact', item: { id: 'item', type: 'contextCompaction' } });
  };
  const complete = () => {
    send('item/completed', { turnId: 'compact', item: { id: 'item', type: 'contextCompaction' } });
    send('turn/completed', { turn: { id: 'compact', status: 'completed' } });
  };
  return { a, wire, send, start, complete };
}
it('requires matching compaction item and turn completion, ignoring other threads and unrelated completions', async () => {
  const { a, wire, send, start, complete } = setup();
  let done = false;
  const pending = a.compact('operation', new AbortController().signal).then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(wire.calls[0]?.method).toBe('thread/compact/start');
  expect(done).toBe(false);
  send('turn/started', { threadId: 'other', turn: { id: 'other-turn' } });
  start();
  send('turn/completed', { turn: { id: 'ordinary', status: 'completed' } });
  send('item/completed', { turnId: 'wrong', item: { id: 'item', type: 'contextCompaction' } });
  await Promise.resolve();
  expect(done).toBe(false);
  complete();
  await pending;
  expect(done).toBe(true);
  expect(wire.listenerCount('message')).toBe(0);
});
it('interrupts the captured maintenance turn and closes uncertain state on cancellation', async () => {
  const { a, wire, start } = setup();
  const controller = new AbortController();
  const pending = a.compact('operation', controller.signal);
  start();
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  await Promise.resolve();
  expect(wire.calls).toContainEqual({
    method: 'turn/interrupt',
    params: { threadId: 'thread', turnId: 'compact' },
  });
  expect(wire.closed).toBe(true);
  expect(wire.listenerCount('message')).toBe(0);
});
it('cancels before a turn ID exists without sending an invented interrupt', async () => {
  const { a, wire } = setup();
  const controller = new AbortController();
  const pending = a.compact('operation', controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(wire.closed).toBe(true);
  expect(wire.calls.map((call) => call.method)).toEqual(['thread/compact/start']);
});
it('rejects provider errors and does not mistake missing completion for a no-op', async () => {
  const { a, send } = setup();
  const pending = a.compact('operation', new AbortController().signal);
  send('turn/started', { turn: { id: 'compact' } });
  send('turn/completed', { turn: { id: 'compact', status: 'completed' } });
  await expect(pending).rejects.toThrow('did not confirm');
  const next = a.compact('next', new AbortController().signal);
  send('turn/started', { turn: { id: 'next-compact' } });
  send('turn/completed', {
    turn: { id: 'next-compact', status: 'failed', error: { message: 'Provider rejected' } },
  });
  await expect(next).rejects.toThrow('Provider rejected');
});
// #105: the native route is attempted on every build. A CLI that lacks the
// method answers with an error, which is a bounded failure, not a completion.
it('treats an unknown-method reply to thread/compact/start as a failed native operation', async () => {
  const { a, wire } = setup();
  wire.rpc = async (method: string, params: any) => {
    wire.calls.push({ method, params });
    throw new Error('Method not found: thread/compact/start');
  };
  const pending = a.compact('operation', new AbortController().signal);
  await expect(pending).rejects.toThrow('Method not found: thread/compact/start');
  expect(wire.calls.map((call) => call.method)).toEqual(['thread/compact/start']);
  expect(wire.listenerCount('message')).toBe(0);
  // The next operation is a fresh attempt, never an assumed completion.
  const { a: next, send } = setup();
  const second = next.compact('operation', new AbortController().signal);
  send('turn/started', { turn: { id: 'compact' } });
  send('turn/completed', { turn: { id: 'compact', status: 'completed' } });
  await expect(second).rejects.toThrow('did not confirm');
});
it('bounds waits and cleans listeners after timeout', async () => {
  vi.useFakeTimers();
  const { a, wire } = setup();
  const pending = a.compact('operation', new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(120000);
  await rejected;
  expect(wire.closed).toBe(true);
  expect(wire.listenerCount('message')).toBe(0);
});

it('denies task tools across the shared MCP maintenance gate, then restores ordinary history access', async () => {
  const { ToolService } = await import('../src/tools.js');
  const parent = new ToolService('/workspace', { edits: true, commands: true, network: true });
  const child = new ToolService(
    '/workspace',
    { edits: true, commands: true, network: true },
    parent.historyFile,
    [],
    undefined,
    parent.maintenanceFile,
  );
  try {
    parent.setMaintenance(true);
    for (const [name, args] of [
      ['read_file', { path: 'any' }],
      ['run_command', { command: 'echo should-not-run' }],
      ['read_conversation', {}],
    ] as const)
      await expect(child.call(name, args)).rejects.toThrow('denied during context maintenance');
    parent.setMaintenance(false);
    await expect(child.call('read_conversation', {})).resolves.toMatchObject({ total: 0 });
  } finally {
    child.close();
    parent.close();
  }
});

it('parses a separate maintenance response without ordinary outcomes and rejects oversized input before registering listeners', async () => {
  const { a, wire, send } = setup();
  wire.rpc = async (method, params) => {
    wire.calls.push({ method, params });
    return { turn: { id: 'source' } };
  };
  const pending = a.maintain(
    { id: 'handoff', kind: 'handoff', prompt: 'State unfinished checks' },
    new AbortController().signal,
  );
  await Promise.resolve();
  expect(wire.calls[0]?.params.outputSchema.required).toEqual(['maintenance']);
  send('item/completed', {
    turnId: 'source',
    item: {
      type: 'agentMessage',
      text: JSON.stringify({
        maintenance: { operationId: 'handoff', text: 'Unfinished backup check' },
      }),
    },
  });
  send('turn/completed', { turn: { id: 'source', status: 'completed' } });
  await expect(pending).resolves.toEqual({ text: 'Unfinished backup check', sessionId: 'thread' });
  await expect(
    a.maintain(
      { id: 'large', kind: 'seed', prompt: 'x'.repeat(65536) },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Complete maintenance prompt');
  expect(wire.listenerCount('message')).toBe(0);
});

it('ignores replayed start and completion events from a retired compact turn', async () => {
  const { a, send, start, complete } = setup();
  const first = a.compact('first', new AbortController().signal);
  start();
  complete();
  await first;
  let settled = false;
  const second = a.compact('second', new AbortController().signal).then(() => {
    settled = true;
  });
  start();
  complete();
  await Promise.resolve();
  expect(settled).toBe(false);
  send('turn/started', { turn: { id: 'new-compact' } });
  send('item/started', {
    turnId: 'new-compact',
    item: { id: 'new-item', type: 'contextCompaction' },
  });
  send('item/completed', {
    turnId: 'new-compact',
    item: { id: 'new-item', type: 'contextCompaction' },
  });
  send('turn/completed', { turn: { id: 'new-compact', status: 'completed' } });
  await second;
  expect(settled).toBe(true);
});

it('preserves completed invalid maintenance output errors and restores the task-tool gate', async () => {
  const { a, wire, send } = setup();
  const { MaintenanceOutputError } = await import('../src/protocol.js');
  const gates: boolean[] = [];
  const service = (a as any).tools;
  const setMaintenance = service.setMaintenance.bind(service);
  service.setMaintenance = (active: boolean) => {
    gates.push(active);
    setMaintenance(active);
  };
  wire.rpc = async () => ({ turn: { id: 'source' } });
  const pending = a.maintain(
    { id: 'handoff', kind: 'handoff', prompt: 'Unfinished checks' },
    new AbortController().signal,
  );
  await Promise.resolve();
  send('item/completed', {
    turnId: 'source',
    item: {
      type: 'agentMessage',
      text: JSON.stringify({ maintenance: { operationId: 'handoff', text: 'x'.repeat(4097) } }),
    },
  });
  send('turn/completed', { turn: { id: 'source', status: 'completed' } });
  await expect(pending).rejects.toBeInstanceOf(MaintenanceOutputError);
  await expect(pending).rejects.toThrow('4096-byte budget');
  expect(gates).toEqual([true, false]);
  expect(wire.closed).toBe(false);
});
