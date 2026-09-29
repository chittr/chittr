import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAdapter } from '../src/adapters/index.js';
import { AttachmentStore } from '../src/attachments.js';
import {
  AttachmentResult,
  retrievalUnavailable,
  attachmentFailure,
} from '../src/attachment-result.js';
import { ToolService } from '../src/tools.js';
import type {
  AgentAdapter,
  AdapterEvent,
  Provider,
  RoomConfig,
  TurnInput,
  TurnResult,
} from '../src/types.js';
import { tinyPng } from './image-fixture.js';
import { wires, script, type Wire } from './adapter-contract-wire.js';

vi.mock('../src/process.js', async (original) => ({
  ...(await original<typeof import('../src/process.js')>()),
  ...(await import('./adapter-contract-wire.js')),
  JsonLinesProcess: (await import('./adapter-contract-wire.js')).Wire,
}));

let root: string, config: RoomConfig, store: AttachmentStore;
const adapters: AgentAdapter[] = [],
  clients: Client[] = [],
  services: ToolService[] = [];
const providers: Provider[] = [
  'codex',
  'claude',
  'grok',
  ...(process.platform === 'darwin' ? ['antigravity' as const] : []),
];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adapter-contract-'));
  mkdirSync(join(root, 'bin'));
  // Discovery only; runProcess and JsonLinesProcess never execute this link.
  symlinkSync(process.execPath, join(root, 'bin/codex'));
  vi.stubEnv('PATH', `${join(root, 'bin')}:${process.env.PATH}`);
  wires.length = 0;
  services.length = 0;
  script.resumeError = '';
  config = {
    workspace: root,
    permissions: { edits: false, commands: false, network: false },
    skills: { enabled: false },
    followUpTurns: 1,
    agents: {},
    sources: [],
    provenance: {},
  };
  store = new AttachmentStore(join(root, 'state'));
  // Observe the public service boundary without replacing its behavior.
  const check = ToolService.prototype.check;
  vi.spyOn(ToolService.prototype, 'check').mockImplementation(function (this: ToolService) {
    services.push(this);
    return check.call(this);
  });
});
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close();
  for (const c of clients.splice(0)) await c.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const sessionId = randomUUID();
  const metadata = store.stage({
    sessionId,
    operationId: randomUUID(),
    filename: 'fixture.png',
    mediaType: 'image/png',
    bytes: tinyPng(),
  });
  const message = {
    id: 'm2',
    sequence: 2,
    author: 'human',
    recipients: [],
    replyTo: [],
    roots: [],
    text: 'Read earlier image',
    createdAt: '',
    deliveries: {},
  };
  const input: TurnInput = {
    messages: [message],
    context: [],
    participants: ['agent'],
    history: [{ ...message, id: 'm1', sequence: 1, attachments: [metadata] }, message],
  };
  return { sessionId, metadata, input };
}
type Fixture = ReturnType<typeof fixture>;
function make(provider: Provider, f: Fixture) {
  const adapter = createAdapter(
    {
      id: 'agent',
      provider,
      enabled: true,
      instructions: '',
      fingerprint: 'contract',
      ...(provider === 'codex'
        ? { model: 'gpt-6-astra', effort: 'xhigh' }
        : provider === 'claude'
          ? { model: 'opus', effort: 'xhigh' }
          : provider === 'grok'
            ? { effort: 'high' }
            : {}),
    },
    provider === 'grok'
      ? {
          ...config,
          permissions: { edits: true, commands: true, network: true },
          skills: { enabled: true },
          commandAccess: { mode: 'sandboxed', blockedBy: [] },
        }
      : config,
    {},
    store.access(f.sessionId),
  );
  adapters.push(adapter);
  return adapter;
}
it.each(['codex', 'grok'] as const)(
  'reports the installed package version to %s',
  async (provider) => {
    const adapter = make(provider, fixture());
    await adapter.start();
    const initialize = wires.at(-1)!.sent.find((message) => message.method === 'initialize');
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(initialize.params.clientInfo).toMatchObject({
      name: 'chittr',
      version: manifest.version,
    });
    expect(typeof initialize.params.clientInfo.version).toBe('string');
  },
);
interface Driver {
  receipt(): void;
  activity(stale?: boolean): void;
  complete(): void;
}
// This is the shared lifecycle assertion body, also used by the fake/mutation check.
async function lifecycle(
  adapter: AgentAdapter,
  driver: () => Driver,
  input: TurnInput,
  afterAbort = () => {},
) {
  expect(await adapter.start()).toEqual({ sessionId: expect.any(String), restored: false });
  const events: AdapterEvent[] = [];
  const event = (e: AdapterEvent) => events.push(e);
  const first = adapter.run(input, event, new AbortController().signal);
  await vi.waitFor(() => {
    driver().receipt();
    expect(events).toContainEqual({ type: 'received' });
  });
  driver().activity();
  expect(events).toContainEqual({
    type: 'activity',
    activity: 'working',
    detail: 'contract-marker',
  });
  driver().complete();
  expect((await first).outcomes).toMatchObject([
    { kind: 'pass', text: 'Done', recipients: [], messageIds: ['m2'] },
  ]);
  const count = events.length;
  driver().activity();
  expect(events).toHaveLength(count);
  const second = adapter.run(input, event, new AbortController().signal);
  await vi.waitFor(() => {
    driver().receipt();
    expect(events.slice(count)).toContainEqual({ type: 'received' });
  });
  const current = events.length;
  driver().activity(true);
  expect(events).toHaveLength(current);
  driver().complete();
  expect((await second).outcomes).toHaveLength(1);
  const abort = new AbortController();
  const beforeAbortRun = events.length;
  const interrupted = adapter.run(input, event, abort.signal);
  const rejection = expect(interrupted).rejects.toThrow('Interrupted');
  await vi.waitFor(() => {
    driver().receipt();
    expect(events.slice(beforeAbortRun)).toContainEqual({ type: 'received' });
  });
  abort.abort();
  await rejection;
  afterAbort();
  await adapter.close();
  await adapter.close();
}
async function warm(adapter: AgentAdapter, wire: Wire, input: TurnInput) {
  const run = adapter.run(input, () => {}, new AbortController().signal);
  await Promise.resolve();
  wire.complete();
  await run;
}
async function connected(provider: Provider, f: Fixture) {
  const adapter = make(provider, f);
  await adapter.start();
  const wire = wires.at(-1)!;
  const tools = services.at(-1)!;
  if (provider === 'claude') await warm(adapter, wire, f.input);
  return { adapter, wire, tools };
}
async function mcp(wire: Wire) {
  const server = wire.servers[0];
  const client = new Client({ name: 'adapter-contract', version: '1' });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  await client.connect(transport);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(client.getServerVersion()).toEqual({ name: 'chittr-tools', version: manifest.version });
  return client;
}
const noBytes = (value: unknown) =>
  expect(JSON.stringify(value)).not.toContain(tinyPng().toString('base64'));
async function dynamic(wire: Wire, tool: string, args: unknown, overrides = {}) {
  const id = randomUUID();
  wire.emit('message', {
    id,
    method: 'item/tool/call',
    params: {
      threadId: wire.sessionId,
      turnId: `turn-${wire.promptId}`,
      tool,
      arguments: args,
      ...overrides,
    },
  });
  await vi.waitFor(() => expect(wire.sent.find((v) => v.id === id)).toBeDefined());
  return wire.sent.find((v) => v.id === id).result;
}

describe.each(providers)('%s adapter contract', (provider) => {
  it('conforms to fresh start, receipt, completion, stale-frame isolation and abort ordering', async () => {
    const f = fixture(),
      adapter = make(provider, f);
    await lifecycle(
      adapter,
      () => wires.at(-1)!,
      f.input,
      () => {
        const wire = wires.at(-1)!;
        if (provider === 'codex')
          expect(wire.sent).toContainEqual({
            method: 'turn/interrupt',
            params: { threadId: wire.sessionId, turnId: 'turn-3' },
          });
        if (provider === 'claude')
          expect(wire.sent).toContainEqual(
            expect.objectContaining({ request: { subtype: 'interrupt' } }),
          );
        expect(wire.closed).toBe(provider === 'grok' || provider === 'antigravity');
      },
    );
    expect(wires.at(-1)!.closed).toBe(true);
  });
  it.each(['retained', 'missing', 'other error'])(
    'reports previous-session context: %s',
    async (mode) => {
      const adapter = make(provider, fixture());
      script.resumeError =
        mode === 'missing'
          ? 'session not found; thread not found'
          : mode === 'other error'
            ? 'transport unavailable'
            : '';
      if (['codex', 'claude'].includes(provider) && mode === 'other error') {
        await expect(adapter.start('previous')).rejects.toThrow('transport unavailable');
        return;
      }
      const result = await adapter.start('previous');
      expect(result.restored).toBe(!['codex', 'claude'].includes(provider) || mode === 'missing');
      expect(result.sessionId).toEqual(expect.any(String));
      if (provider === 'codex') {
        expect(wires[0]!.sent.some((v) => v.method === 'thread/resume')).toBe(true);
        expect(wires[0]!.sent.some((v) => v.method === 'thread/start')).toBe(mode === 'missing');
      }
      if (provider === 'claude') expect(wires).toHaveLength(mode === 'missing' ? 2 : 1);
      if (['codex', 'claude'].includes(provider) && mode === 'retained')
        expect(result.sessionId).toBe('previous');
    },
  );
  it('denies task tools during maintain through the parent and native tool boundary', async () => {
    const f = fixture(),
      x = await connected(provider, f);
    const client = provider === 'codex' ? undefined : await mcp(x.wire);
    const request = { id: 'maintenance-1', kind: 'seed' as const, prompt: 'Seed context' };
    const maintenance = x.adapter.maintain!(request, new AbortController().signal);
    await expect(x.tools.call('read_conversation', {})).rejects.toThrow(
      'Task tools are denied during context maintenance',
    );
    if (client) {
      const result = await client.callTool({ name: 'read_conversation', arguments: {} });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain('Task tools are denied during context maintenance');
    } else {
      const result = await dynamic(x.wire, 'read_attachment', { attachment_id: f.metadata.id });
      expect(result.success).toBe(false);
      expect(JSON.parse(result.contentItems[0].text)).toEqual(attachmentFailure(undefined));
      noBytes(result);
    }
    x.wire.complete({ maintenance: { operationId: request.id, text: 'seed accepted' } } as any);
    expect(await maintenance).toEqual({ text: 'seed accepted', sessionId: expect.any(String) });
  });
  it.each(['interrupt', 'close', 'maintenance', 'replacement'] as const)(
    'revokes old turn authority after %s',
    async (action) => {
      const f = fixture(),
        x = await connected(provider, f);
      const client = provider === 'codex' ? undefined : await mcp(x.wire);
      const abort = new AbortController();
      const turn = x.adapter.run(f.input, () => {}, abort.signal).catch(() => undefined);
      await Promise.resolve();
      const read = () => x.tools.call('read_attachment', { attachment_id: f.metadata.id });
      const result = await read();
      if (provider === 'antigravity')
        expect(result).toMatchObject({
          error: 'attachment-unavailable',
          message: expect.stringContaining(retrievalUnavailable.message),
        });
      else {
        expect(result).toBeInstanceOf(AttachmentResult);
        expect((result as AttachmentResult).mcp().content[1]!.type).toBe('image');
      }
      if (client) {
        const active = await client.callTool({
          name: 'read_attachment',
          arguments: { attachment_id: f.metadata.id },
        });
        if (provider === 'antigravity') {
          expect(active.isError).toBeUndefined();
          expect(active.content).toEqual([
            { type: 'text', text: expect.stringContaining(retrievalUnavailable.message) },
          ]);
        } else
          expect(active.content).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
          );
      }
      if (action === 'interrupt') await x.adapter.interrupt();
      else if (action === 'maintenance') x.tools.setMaintenance(true);
      else await x.adapter.close();
      if (provider !== 'antigravity') expect(() => (result as AttachmentResult).mcp()).toThrow();
      if (action === 'close' || action === 'replacement')
        await expect(read()).rejects.toThrow('Tool service closed');
      else if (action === 'maintenance')
        await expect(read()).rejects.toThrow('Task tools are denied during context maintenance');
      else expect(await read()).toEqual(attachmentFailure(undefined));
      if (client && action !== 'close' && action !== 'replacement') {
        const refused = await client.callTool({
          name: 'read_attachment',
          arguments: { attachment_id: f.metadata.id },
        });
        noBytes(refused);
        expect(refused.isError).toBe(action === 'maintenance' ? true : undefined);
        if (action === 'interrupt')
          expect(refused.content).toEqual([
            { type: 'text', text: JSON.stringify(attachmentFailure(undefined)) },
          ]);
      }
      abort.abort();
      await turn;
      if (action === 'replacement') {
        const next = await connected(provider, f);
        const nextTurn = next.adapter.run(f.input, () => {}, new AbortController().signal);
        await Promise.resolve();
        const fresh = await next.tools.call('read_attachment', { attachment_id: f.metadata.id });
        if (provider === 'antigravity')
          expect(fresh).toMatchObject({
            error: 'attachment-unavailable',
            message: expect.stringContaining(retrievalUnavailable.message),
          });
        else {
          expect((fresh as AttachmentResult).mcp().content[1]!.type).toBe('image');
          expect(() => (result as AttachmentResult).mcp()).toThrow();
        }
        if (client)
          noBytes(
            await client.callTool({
              name: 'read_attachment',
              arguments: { attachment_id: f.metadata.id },
            }),
          );
        await expect(read()).rejects.toThrow('Tool service closed');
        if (provider === 'codex') {
          for (const overrides of [{ turnId: 'obsolete' }, { threadId: x.wire.sessionId }]) {
            const refused = await dynamic(
              next.wire,
              'read_attachment',
              { attachment_id: f.metadata.id },
              overrides,
            );
            expect(refused.success).toBe(false);
            expect(JSON.parse(refused.contentItems[0].text)).toEqual(attachmentFailure(undefined));
            noBytes(refused);
          }
        }
        next.wire.complete();
        await nextTurn;
      }
    },
  );
  it('separates direct interruption, abort and close reports, then observes a fresh connection', async () => {
    const f = fixture(),
      x = await connected(provider, f);
    const before = x.adapter.imageSupport!();
    expect(before.initial.available).toBe(provider !== 'antigravity');
    expect(before.retrieval.available).toBe(provider !== 'antigravity');
    await x.adapter.interrupt();
    if (provider === 'codex' || provider === 'claude')
      expect(x.adapter.imageSupport!()).toEqual(before);
    else
      expect(x.adapter.imageSupport!()).toMatchObject({
        initial: { available: false },
        retrieval: { available: false },
      });
    if (provider === 'claude') {
      const abort = new AbortController();
      const run = x.adapter.run(f.input, () => {}, abort.signal);
      abort.abort();
      await expect(run).rejects.toThrow('Interrupted');
      expect(x.adapter.imageSupport!()).toMatchObject({
        initial: { status: 'not_observed' },
        retrieval: { status: 'not_observed' },
      });
    }
    await x.adapter.close();
    expect(x.adapter.imageSupport!()).toMatchObject({
      initial: {
        available: false,
        status:
          provider === 'antigravity'
            ? 'unsupported'
            : provider === 'claude'
              ? expect.stringMatching(/^(unsupported|not_observed)$/)
              : 'not_observed',
      },
      retrieval: { available: false },
    });
    const register = vi.spyOn(ToolService.prototype, 'registerRetrievalBridge');
    const next = make(provider, f);
    expect(next.imageSupport!().initial.available).toBe(false);
    await next.start();
    const wire = wires.at(-1)!;
    if (provider === 'claude') {
      expect(next.imageSupport!().initial.status).toBe('not_observed');
      await warm(next, wire, f.input);
    }
    expect(next.imageSupport!().initial.available).toBe(provider !== 'antigravity');
    expect(register).toHaveBeenCalled();
    const turn = next.run(f.input, () => {}, new AbortController().signal);
    await Promise.resolve();
    const result = await services.at(-1)!.call('read_attachment', { attachment_id: f.metadata.id });
    if (provider === 'antigravity')
      expect(result).toMatchObject({
        error: 'attachment-unavailable',
        message: expect.stringContaining(retrievalUnavailable.message),
      });
    else expect((result as AttachmentResult).mcp().content[1]!.type).toBe('image');
    wire.complete();
    await turn;
  });
});

class ConformanceFake implements AgentAdapter, Driver {
  event?: (e: AdapterEvent) => void;
  resolve?: (result: TurnResult) => void;
  async start() {
    return { sessionId: 'fake', restored: false };
  }
  run(_input: TurnInput, event: (e: AdapterEvent) => void, signal: AbortSignal) {
    this.event = event;
    return new Promise<TurnResult>((resolve, reject) => {
      const abort = () => {
        this.event = undefined;
        reject(new Error('Interrupted'));
      };
      signal.addEventListener('abort', abort, { once: true });
      this.resolve = (value) => {
        signal.removeEventListener('abort', abort);
        this.event = undefined;
        resolve(value);
      };
    });
  }
  receipt() {
    this.event?.({ type: 'received' });
  }
  activity(stale = false) {
    if (!stale) this.event?.({ type: 'activity', activity: 'working', detail: 'contract-marker' });
  }
  complete() {
    this.resolve!({
      outcomes: [{ kind: 'pass', text: 'Done', recipients: [], messageIds: ['m2'] }],
    });
  }
  async interrupt() {}
  async close() {
    this.event = undefined;
  }
}
it('accepts the conformance fake and rejects a fresh-start restoration mutation with the same body', async () => {
  const fake = new ConformanceFake();
  await lifecycle(fake, () => fake, fixture().input);
  const mutant = new ConformanceFake();
  mutant.start = async () => ({ sessionId: 'fake', restored: true });
  await expect(lifecycle(mutant, () => mutant, fixture().input)).rejects.toThrow();
});
