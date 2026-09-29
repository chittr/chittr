import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonLinesProcess } from '../src/process.js';
import { observeRoster } from '../scripts/live-image-selection.js';

// Codex hands `send` a final validator that rechecks authority, support and frame
// size on the serialized bytes, for its initial images (through `rpc`) and for
// its retrieval results. A mixed room composes every provider's observer on the
// one shared prototype, so each wrapper must pass that validator on. If one drops
// it, the observed run is no longer the product's guarded path.
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
function temporary() {
  const path = mkdtempSync(join(tmpdir(), 'integrated-observers-'));
  scratch.push(path);
  return path;
}
/** A process with no child: only `send`, `rpc` and the stdin write are exercised. */
function fakeProcess(Process: any) {
  const write = vi.fn();
  const proc = Object.create(Process.prototype);
  Object.assign(proc, {
    closed: false,
    nextId: 0,
    pending: new Map(),
    child: { stdin: { write } },
  });
  return { proc, write };
}
const initialImage = {
  threadId: '019d1c5e-5b1c-7a41-9d0e-0a6f5f1c2b3d',
  input: [{ type: 'text', text: 'Look.' }],
};
const retrievalResult = { id: 7, result: { success: true, contentItems: [] } };

async function guardedPathsStillGuarded(Process: any) {
  const refuse = () => {
    throw new Error('revoked before the transport write');
  };
  // Initial image: Codex sends turn/start through rpc with its validator.
  let { proc, write } = fakeProcess(Process);
  await expect(proc.rpc('turn/start', initialImage, 1000, refuse)).rejects.toThrow('revoked');
  expect(write).not.toHaveBeenCalled();
  // Retrieval result: Codex sends the tool response with its validator.
  ({ proc, write } = fakeProcess(Process));
  expect(() => proc.send(retrievalResult, refuse)).toThrow('revoked');
  expect(write).not.toHaveBeenCalled();
  // An accepting validator sees the exact serialized frame, once, before the one write.
  ({ proc, write } = fakeProcess(Process));
  const accept = vi.fn();
  proc.send(retrievalResult, accept);
  expect(accept).toHaveBeenCalledExactlyOnceWith(JSON.stringify(retrievalResult));
  expect(write).toHaveBeenCalledExactlyOnceWith(JSON.stringify(retrievalResult) + '\n');
}

it('keeps the final validator in force under the composed TypeScript observers', async () => {
  const original = JsonLinesProcess.prototype.send;
  const events: object[] = [];
  const restore = observeRoster(temporary(), ['codex', 'claude', 'grok'], () => 'initial', events);
  try {
    expect(JsonLinesProcess.prototype.send).not.toBe(original);
    await guardedPathsStillGuarded(JsonLinesProcess);
    // The observers still observed: the accepted frames were seen, the refused ones were not.
    expect(events.every((event: any) => event.observer)).toBe(true);
  } finally {
    restore();
  }
  expect(JsonLinesProcess.prototype.send).toBe(original);
});

it('keeps the final validator in force under the composed built-CLI preload', async () => {
  const observation = temporary();
  writeFileSync(
    join(observation, 'private-control.json'),
    JSON.stringify({ phase: 'initial', hiddenId: '', oracles: [] }),
  );
  process.env.CHITTR_IMAGE_OBSERVATION = observation;
  process.env.CHITTR_IMAGE_OBSERVERS = 'codex,claude,grok';
  await import('../scripts/integrated-terminal-observer.mjs');
  // The private location never stays in the environment a provider would inherit.
  expect(process.env.CHITTR_IMAGE_OBSERVATION).toBeUndefined();
  expect(process.env.CHITTR_IMAGE_OBSERVERS).toBeUndefined();
  const built = await import('../dist/process.js');
  await guardedPathsStillGuarded(built.JsonLinesProcess);
});
