import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { observeCodex, imageProjection } from '../scripts/codex-native-observer.mjs';

it('records only successful native dispatch, preserves final validation and strips private input', () => {
  class Process extends EventEmitter {
    writes: string[] = [];
    send(value: unknown, validate?: (text: string) => void) {
      const text = JSON.stringify(value);
      validate?.(text);
      this.writes.push(text);
    }
  }
  class Tools {
    async call() {}
  }
  const events: any[] = [];
  const stop = observeCodex(
    Process,
    Tools,
    (event: any) => events.push(event),
    () => ({ oracles: ['private answer'] }),
  );
  try {
    const process = new Process();
    const payload = {
      id: 'private request',
      method: 'turn/start',
      params: {
        threadId: 'private path',
        input: [
          { type: 'text', text: 'private answer' },
          { type: 'image', url: 'data:image/png;base64,c2VjcmV0' },
        ],
      },
    };
    expect(() =>
      process.send(payload, () => {
        throw new Error('revoked');
      }),
    ).toThrow('revoked');
    expect(events).toEqual([]);
    expect(process.writes).toEqual([]);
    process.send(payload);
    expect(events[0]).toMatchObject({
      boundary: 'initial-native-request',
      hasOracle: true,
      images: [{ byteSize: 6 }],
    });
    const retained = JSON.stringify(events);
    for (const secret of ['private answer', 'private request', 'private path', 'c2VjcmV0', 'data:'])
      expect(retained).not.toContain(secret);
    process.emit('message', {
      method: 'privateMethod',
      params: { item: { type: 'inputImage', imageUrl: 'data:image/png;base64,c2VjcmV0' } },
    });
    expect(events.at(-1).method).toBe('other');
    expect(imageProjection({ type: 'image', url: 'https://private.example/image' })).toEqual([]);
  } finally {
    stop();
  }
});

it('omits oracle and hidden-id claims when no control fixture is configured', () => {
  class Process extends EventEmitter {
    send(value: unknown, validate?: (text: string) => void) {
      validate?.(JSON.stringify(value));
    }
  }
  class Tools {
    async call() {}
  }
  const events: any[] = [];
  const stop = observeCodex(Process, Tools, (event: any) => events.push(event));
  try {
    new Process().send({ method: 'turn/start', params: { input: [] } });
    expect(events[0]).not.toHaveProperty('hasHiddenId');
    expect(events[0]).not.toHaveProperty('hasOracle');
  } finally {
    stop();
  }
});
