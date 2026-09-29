import { afterEach, expect, it } from 'vitest';
import { GrokAdapter } from '../src/adapters/grok.js';
import type { RoomConfig } from '../src/types.js';
const adapters: GrokAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close();
});
function setup() {
  const adapter = new GrokAdapter(
    { id: 'a', provider: 'grok', enabled: true, instructions: '', fingerprint: 'a' },
    {} as RoomConfig,
  );
  const calls: any[] = [],
    sent: any[] = [],
    gates: boolean[] = [];
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const wire = {
    closed: false,
    rpc(method: string, params: unknown, timeout: number) {
      calls.push({ method, params, timeout });
      return new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    send(value: unknown) {
      sent.push(value);
    },
    async close() {
      this.closed = true;
      reject?.(new Error('CLI closed'));
    },
  };
  Object.assign(adapter, {
    proc: wire,
    sessionId: 'session',
    nativeCompaction: true,
    runtime: {
      tools: {
        setMaintenance(value: boolean) {
          gates.push(value);
        },
        interrupt() {},
      },
      close() {},
    },
  });
  adapters.push(adapter);
  return {
    adapter,
    wire,
    calls,
    sent,
    gates,
    resolve: (value: unknown) => resolve(value),
    reject: (error: Error) => reject(error),
  };
}
it.each([undefined, 'Remember epic 42 and ticket 17'])(
  'waits for the Grok native RPC completion and forwards optional context: %s',
  async (focus) => {
    const x = setup();
    let settled = false;
    const pending = x.adapter.compact('op', new AbortController().signal, focus).then((r) => {
      settled = true;
      return r;
    });
    expect(x.calls).toEqual([
      {
        method: '_x.ai/compact_conversation',
        params: { session_id: 'session', ...(focus ? { user_context: focus } : {}) },
        timeout: 120000,
      },
    ]);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(x.gates).toEqual([true]);
    x.resolve({});
    await expect(pending).resolves.toEqual({ status: 'completed' });
    expect(x.gates).toEqual([true, false]);
  },
);
it.each(['provider failed', '_x.ai/compact_conversation timed out'])(
  'closes uncertain Grok state after %s',
  async (failure) => {
    const x = setup();
    const pending = x.adapter.compact('op', new AbortController().signal);
    x.reject(new Error(failure));
    await expect(pending).rejects.toThrow(failure);
    expect(x.wire.closed).toBe(true);
    expect(x.gates).toEqual([true]);
    expect(x.sent).toEqual([
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session' } },
    ]);
  },
);
it('cancels Grok native work and rejects pre-aborted requests before sending', async () => {
  const x = setup();
  const ctrl = new AbortController();
  ctrl.abort();
  await expect(x.adapter.compact('pre', ctrl.signal)).rejects.toThrow();
  expect(x.calls).toEqual([]);
  const next = new AbortController();
  const pending = x.adapter.compact('op', next.signal);
  next.abort();
  await expect(pending).rejects.toThrow('interrupted');
  expect(x.wire.closed).toBe(true);
});
it.each([{ status: 'started' }, null, [], 'done', { ok: true }])(
  'does not treat an unexpected Grok RPC response as completed compaction: %j',
  async (reply) => {
    const x = setup();
    const pending = x.adapter.compact('op', new AbortController().signal);
    x.resolve(reply);
    await expect(pending).rejects.toThrow('unsupported compaction response');
    expect(x.wire.closed).toBe(true);
    expect(x.gates).toEqual([true]);
  },
);
// #105: the native route is attempted on every build; a CLI without the
// extension answers with a method error, which closes the uncertain state.
it('treats an unknown-method reply to _x.ai/compact_conversation as a failed native operation', async () => {
  const x = setup();
  const pending = x.adapter.compact('op', new AbortController().signal);
  x.reject(new Error('Method not found: _x.ai/compact_conversation'));
  await expect(pending).rejects.toThrow('Method not found');
  expect(x.wire.closed).toBe(true);
  expect(x.gates).toEqual([true]);
  expect(x.sent).toEqual([
    { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session' } },
  ]);
});
