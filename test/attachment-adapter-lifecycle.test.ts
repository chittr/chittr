import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  openSync,
  closeSync,
  writeSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AttachmentStore } from '../src/attachments.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { GrokAdapter } from '../src/adapters/grok.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { roomToolNames } from '../src/adapters/isolated.js';
import { tinyPng } from './image-fixture.js';
import type { AgentAdapter, RoomConfig, TurnInput } from '../src/types.js';

const wires = vi.hoisted(() => [] as any[]);
// Only the external provider transport is deterministic. ToolService, attachment
// storage/resolver, adapter lifecycle and the separate MCP process are real.
vi.mock('../src/process.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/process.js')>();
  const { EventEmitter } = await import('node:events');
  class Wire extends EventEmitter {
    closed = false;
    sessionId: string = randomUUID();
    promptId = 0;
    sent: any[] = [];
    servers: any[] = [];
    settings: Record<string, string> = {};
    profile = '';
    resolve?: (value: unknown) => void;
    reject?: (error: Error) => void;
    constructor(
      public command: string,
      args: string[] = [],
    ) {
      super();
      for (let i = 0; i < args.length; i++)
        if (args[i] === '-c') {
          const setting = args[++i]!;
          this.settings[setting.slice(0, setting.indexOf('='))] = setting.slice(
            setting.indexOf('=') + 1,
          );
        }
      this.profile =
        Object.keys(this.settings)
          .find((key) => key.startsWith('permissions.') && key.endsWith('.filesystem'))
          ?.split('.')[1] ?? '';
      if (command === 'claude') {
        this.sessionId = args[args.indexOf('--session-id') + 1]!;
        this.servers = [JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.chittr];
      }
      wires.push(this);
    }
    send(value: any, validate?: (serialized: string) => void) {
      const serialized = JSON.stringify(value);
      validate?.(serialized);
      this.sent.push(JSON.parse(serialized));
      if (this.command === 'claude' && value.request?.subtype === 'initialize')
        queueMicrotask(() =>
          this.emit('message', {
            type: 'control_response',
            response: {
              request_id: value.request_id,
              subtype: 'success',
              response: {
                models: [
                  {
                    value: 'opus',
                    resolvedModel: 'claude-opus-5',
                    supportedEffortLevels: ['xhigh'],
                  },
                ],
              },
            },
          }),
        );
      if (this.command === 'claude' && value.type === 'user')
        this.emit('message', {
          type: 'system',
          subtype: 'init',
          session_id: this.sessionId,
          tools: ['StructuredOutput', ...roomToolNames.map((x) => `mcp__chittr__${x}`)],
        });
    }
    async rpc(
      method: string,
      params: any = {},
      _timeout?: number,
      validate?: (serialized: string) => void,
    ) {
      if (method === 'authenticate') return { _meta: { auth_mode: 'Oidc' } };
      if (method === 'session/new') {
        this.servers = params.mcpServers;
        this.emit('message', {
          method: 'session/update',
          params: { update: { _meta: { tools: ['search_tool', 'use_tool'] } } },
        });
        return { sessionId: this.sessionId, models: { currentModelId: 'grok-4.6' } };
      }
      if (method === '_x.ai/mcp/list')
        return {
          result: {
            servers: [
              {
                name: 'chittr',
                session: {
                  status: 'ready',
                  tools: roomToolNames.map((name) => ({ name, enabled: true })),
                },
              },
            ],
          },
        };
      if (method === 'session/prompt')
        return new Promise((resolve, reject) => {
          this.resolve = resolve;
          this.reject = reject;
        });
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'config/read')
        return {
          config: {
            features: Object.fromEntries(
              Object.entries(this.settings)
                .filter(([key]) => key.startsWith('features.'))
                .map(([key, value]) => [key.slice(9), JSON.parse(value)]),
            ),
            web_search: 'disabled',
            mcp_servers: {},
            permissions: {
              [this.profile]: {
                extends: null,
                network: { enabled: false },
                filesystem: JSON.parse(
                  this.settings[`permissions.${this.profile}.filesystem`]!.replaceAll(' = ', ': '),
                ),
              },
            },
          },
        };
      if (method === 'thread/start')
        return {
          thread: { id: this.sessionId, environments: [] },
          model: 'gpt-6-astra',
          reasoningEffort: 'xhigh',
          cwd: params.cwd,
          activePermissionProfile: { id: this.profile, extends: null },
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly', networkAccess: false },
          runtimeWorkspaceRoots: [],
        };
      if (method === 'model/list')
        return {
          data: [
            { model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] },
          ],
        };
      if (method === 'turn/start') {
        this.send({ id: `request-${this.promptId + 1}`, method, params }, validate);
        return { turn: { id: `turn-${++this.promptId}` } };
      }
      return {};
    }
    complete() {
      const text = JSON.stringify({
        outcomes: [{ kind: 'pass', text: 'Done', recipients: [], messageIds: ['m2'] }],
      });
      if (this.command === 'claude') {
        this.emit('message', {
          type: 'assistant',
          session_id: this.sessionId,
          message: { model: 'claude-opus-5' },
        });
        this.emit('message', {
          type: 'result',
          subtype: 'success',
          session_id: this.sessionId,
          structured_output: JSON.parse(text),
        });
      } else if (this.command === 'grok') {
        this.emit('message', {
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          },
        });
        this.resolve?.({ stopReason: 'end_turn' });
      } else {
        this.emit('message', {
          method: 'item/completed',
          params: { threadId: this.sessionId, item: { type: 'agentMessage', text } },
        });
        this.emit('message', {
          method: 'turn/completed',
          params: {
            threadId: this.sessionId,
            turn: { id: `turn-${this.promptId}`, status: 'completed' },
          },
        });
      }
    }
    async close() {
      this.closed = true;
      this.reject?.(new Error('Provider closed'));
      this.emit('disconnect', new Error('Provider closed'));
    }
  }
  return {
    ...original,
    JsonLinesProcess: Wire,
    runProcess: async (command: string, args: string[], options: any) => {
      if (command === 'grok')
        return {
          code: 0,
          stderr: '',
          stdout: args.includes('--version')
            ? 'grok 1.0.30 (04b7ffed98c6) [stable]'
            : '--agent-profile --reasoning-effort stdio',
        };
      if (command === 'claude')
        return {
          code: 0,
          stderr: '',
          stdout:
            args[0] === '--version'
              ? // An unlisted build: these lifecycle paths run on a CLI with no
                // catalog entry, exactly as a managed upgrade leaves the host.
                '2.1.278 (Claude Code)'
              : args[0] === '--help'
                ? '--restricted --replay-user-messages --include-partial-messages --strict-mcp-config --tools --disallowedTools --allowedTools --permission-mode --setting-sources --settings --mcp-config --json-schema --no-chrome --effort'
                : JSON.stringify({ loggedIn: true, authMethod: 'oauth' }),
        };
      // Unlisted here too, for the same reason.
      if (command === 'codex') return { code: 0, stderr: '', stdout: 'codex-cli 0.155.1' };
      return original.runProcess(command, args, options);
    },
  };
});
let root: string, config: RoomConfig, store: AttachmentStore;
const adapters: AgentAdapter[] = [],
  clients: Client[] = [];
beforeEach(() => {
  wires.length = 0;
  root = mkdtempSync(join(tmpdir(), 'adapter-retrieval-'));
  mkdirSync(join(root, 'workspace'));
  // Startup resolves the executable even though the provider transport above is
  // deterministic. Supply its runtime path without needing an installed CLI.
  const bin = join(root, 'runtime', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
  config = {
    workspace: join(root, 'workspace'),
    permissions: { edits: false, commands: false, network: false },
    skills: { enabled: false },
    followUpTurns: 1,
    agents: {},
    sources: [],
    provenance: {},
  };
  store = new AttachmentStore(join(root, 'state'));
});
afterEach(async () => {
  try {
    for (const a of adapters.splice(0)) await a.close();
    for (const c of clients.splice(0)) await c.close();
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(sessionId = randomUUID()) {
  const metadata = store.stage({
    sessionId,
    operationId: randomUUID(),
    filename: 'fixture.png',
    mediaType: 'image/png',
    bytes: tinyPng(),
  });
  const base = {
    author: 'human',
    recipients: [],
    replyTo: [],
    roots: [],
    createdAt: new Date().toISOString(),
    deliveries: {},
  };
  const old = {
    ...base,
    id: 'm1',
    sequence: 1,
    text: 'Older public image',
    attachments: [metadata],
  };
  const request = { ...base, id: 'm2', sequence: 2, text: 'Inspect older image' };
  const input: TurnInput = {
    messages: [request],
    context: [],
    history: [old, request],
    participants: ['grok'],
  };
  return {
    sessionId,
    metadata,
    input,
    blob: join(
      root,
      'state',
      sessionId,
      'attachments',
      'blobs',
      store.access(sessionId).resolve(metadata.id).sha256 + '.bin',
    ),
  };
}
async function grok(f: ReturnType<typeof fixture>, provider: 'grok' | 'claude' = 'grok') {
  const Adapter = provider === 'claude' ? ClaudeAdapter : GrokAdapter;
  const adapter = new Adapter(
    {
      id: provider,
      provider,
      enabled: true,
      instructions: '',
      fingerprint: provider,
      ...(provider === 'claude' ? { model: 'opus', effort: 'xhigh' } : { effort: 'high' }),
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
  await adapter.start();
  const wire = wires.at(-1);
  if (provider === 'claude') {
    // A fresh connection still explains the one observation it cannot have yet,
    // on an unlisted build exactly as on a recorded one.
    expect(adapter.imageSupport().initial).toMatchObject({
      available: false,
      status: 'not_observed',
      reason: expect.stringContaining('a successful text turn is required'),
    });
    const warmup = adapter.run(f.input, () => {}, new AbortController().signal);
    wire.complete();
    await warmup;
    expect(adapter.imageSupport().initial.available).toBe(true);
  }
  const server = wire.servers[0];
  const client = new Client({ name: 'adapter-lifecycle-test', version: '1' });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({ command: server.command, args: server.args, stderr: 'pipe' }),
  );
  return {
    adapter,
    wire,
    client,
    read: () =>
      client.callTool({ name: 'read_attachment', arguments: { attachment_id: f.metadata.id } }),
  };
}
async function pendingRead(x: Awaited<ReturnType<typeof grok>>, f: ReturnType<typeof fixture>) {
  // readFileSync in the real MCP resolver blocks on this FIFO. A successful
  // nonblocking writer open proves the reader reached the byte-read boundary.
  unlinkSync(f.blob);
  execFileSync('/usr/bin/mkfifo', [f.blob]);
  const pending = x.read();
  let writer: number | undefined;
  for (let i = 0; i < 300 && writer === undefined; i++) {
    try {
      writer = openSync(f.blob, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENXIO') throw error;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  expect(writer).toBeDefined();
  return {
    pending,
    release: () => {
      writeSync(writer!, tinyPng());
      closeSync(writer!);
    },
  };
}
it.each(
  ['grok', 'claude'].flatMap((provider) =>
    ['completion', 'cancellation', 'replacement', 'session switch'].map(
      (action) => [provider, action] as const,
    ),
  ),
)(
  'revokes a pending real MCP read through actual %s adapter %s and permits a valid new turn',
  async (provider, action) => {
    const f = fixture();
    const x = await grok(f, provider as 'grok' | 'claude');
    const abort = new AbortController();
    const turn = x.adapter
      .run(f.input, () => {}, abort.signal)
      .then(
        () => 'completed',
        () => 'cancelled',
      );
    const held = await pendingRead(x, f);
    if (action === 'completion') x.wire.complete();
    else if (action === 'cancellation') abort.abort();
    else await x.adapter.close();
    await turn;
    held.release();
    const result = await held.pending;
    expect(result.content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
    );
    expect(JSON.stringify(result)).not.toContain(tinyPng().toString('base64'));
    expect(JSON.stringify(await x.read())).not.toContain(tinyPng().toString('base64'));
    unlinkSync(f.blob);
    writeFileSync(f.blob, tinyPng());
    const nextFixture = action === 'session switch' ? fixture() : f;
    const next =
      action === 'completion' ? x : await grok(nextFixture, provider as 'grok' | 'claude');
    const nextTurn = next.adapter.run(nextFixture.input, () => {}, new AbortController().signal);
    expect((await next.read()).content).toMatchObject([{ type: 'text' }, { type: 'image' }]);
    if (action === 'session switch')
      expect(
        JSON.stringify(
          await next.client.callTool({
            name: 'read_attachment',
            arguments: { attachment_id: f.metadata.id },
          }),
        ),
      ).not.toContain(tinyPng().toString('base64'));
    next.wire.complete();
    await nextTurn;
    expect(JSON.stringify(await next.read())).not.toContain(tinyPng().toString('base64'));
  },
  15000,
);

it('returns byte-free unavailable content through the actual Codex dynamic request handler during and after a turn', async () => {
  const f = fixture();
  // #105: a provider-default model no longer closes the paths; a mixed room
  // (restricted permissions with host skills on) still does.
  const adapter = new CodexAdapter(
    { id: 'codex', provider: 'codex', enabled: true, instructions: '', fingerprint: 'codex' },
    { ...config, skills: { enabled: true } },
    {},
    store.access(f.sessionId),
  );
  adapters.push(adapter);
  await adapter.start();
  const wire = wires.at(-1);
  const turn = adapter.run(f.input, () => {}, new AbortController().signal);
  await Promise.resolve();
  async function call(id: number, args: unknown) {
    wire.emit('message', {
      id,
      method: 'item/tool/call',
      params: {
        threadId: wire.sessionId,
        turnId: 'turn-1',
        tool: 'read_attachment',
        arguments: args,
      },
    });
    for (let i = 0; i < 100; i++) {
      const result = wire.sent.find((x: any) => x.id === id);
      if (result) return result;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error('Missing dynamic response');
  }
  const active = await call(1, { attachment_id: f.metadata.id });
  expect(active.result.contentItems[0].type).toBe('inputText');
  expect(active.result.contentItems[0].text).toContain('attachment-unavailable');
  const invalid = await call(2, { attachment_id: f.metadata.id, ['x'.repeat(200000)]: 'secret' });
  expect(JSON.stringify(invalid).length).toBeLessThan(500);
  wire.complete();
  await turn;
  const late = await call(3, { attachment_id: f.metadata.id });
  expect(late.result.success).toBe(false);
  for (const result of [active, invalid, late]) {
    expect(result.result.contentItems.every((item: any) => item.type === 'inputText')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(tinyPng().toString('base64'));
  }
});

it('sends Claude images only from required messages and loses support on ambiguous turn identity', async () => {
  const f = fixture();
  const x = await grok(f, 'claude');
  const ordinary = x.adapter.run(f.input, () => {}, new AbortController().signal);
  expect(x.wire.sent.at(-1).message.content).not.toContain(tinyPng().toString('base64'));
  x.wire.complete();
  await ordinary;
  const delivery = x.adapter.run(
    { ...f.input, messages: [f.input.history![0]!] },
    () => {},
    new AbortController().signal,
  );
  expect(x.wire.sent.at(-1).message.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: tinyPng().toString('base64') },
      }),
    ]),
  );
  x.wire.emit('message', {
    type: 'assistant',
    session_id: x.wire.sessionId,
    message: { model: 'claude-other' },
  });
  expect(JSON.stringify(await x.read())).not.toContain(tinyPng().toString('base64'));
  x.wire.complete();
  await delivery;
  expect(x.adapter.imageSupport().initial.available).toBe(false);
});

it('does not dispatch Claude pixels when the activity observer cancels immediately before send', async () => {
  const f = fixture();
  const x = await grok(f, 'claude');
  const before = x.wire.sent.filter((v: any) => v.type === 'user').length;
  const abort = new AbortController();
  await expect(
    x.adapter.run(
      { ...f.input, messages: [f.input.history![0]!] },
      () => abort.abort(),
      abort.signal,
    ),
  ).rejects.toThrow('Interrupted');
  expect(x.wire.sent.filter((v: any) => v.type === 'user')).toHaveLength(before);
  expect(JSON.stringify(await x.read())).not.toContain(tinyPng().toString('base64'));
});

async function codex(f: ReturnType<typeof fixture>) {
  const adapter = new CodexAdapter(
    {
      id: 'codex',
      provider: 'codex',
      enabled: true,
      instructions: '',
      fingerprint: 'codex',
      model: 'gpt-6-astra',
      effort: 'xhigh',
    },
    config,
    {},
    store.access(f.sessionId),
  );
  adapters.push(adapter);
  await adapter.start();
  const wire = wires.at(-1);
  expect(adapter.imageSupport().initial.available).toBe(true);
  let nextId = 100;
  const call = async (tool: string, args: unknown, overrides = {}) => {
    const id = ++nextId;
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
    for (let i = 0; i < 100; i++) {
      const response = wire.sent.find((value: any) => value.id === id);
      if (response) return response;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('Missing dynamic response');
  };
  return { adapter, wire, call };
}

it('treats a closed Claude process on an unlisted build as unobserved, not unsupported', async () => {
  const x = await grok(fixture(), 'claude');
  expect(x.adapter.imageEvidence.cliVersion).toBe('2.1.278 (Claude Code)');
  expect(x.adapter.imageSupport().initial.available).toBe(true);
  await x.adapter.close();
  const support = x.adapter.imageSupport().initial;
  expect(support).toMatchObject({
    available: false,
    status: 'not_observed',
    reason: expect.stringContaining('actual turn model has not been observed'),
  });
  if (support.available) throw new Error('closed process unexpectedly retained image support');
  // The identity went with the process, so only its bounded diagnostic remains.
  expect(support.reason).toContain('live CLI unknown or unavailable');
});

it('treats a closed Codex process as unobserved rather than a failed native policy check', async () => {
  const x = await codex(fixture());
  await x.adapter.close();
  expect(x.adapter.imageEvidence.nativePolicyVerified).toBeUndefined();
  const support = x.adapter.imageSupport().initial;
  expect(support).toMatchObject({
    available: false,
    status: 'not_observed',
    reason: expect.stringContaining('native policy checks have not completed'),
  });
  if (support.available) throw new Error('closed process unexpectedly retained image support');
  expect(support.reason).not.toContain('policy checks failed');
});

it('delivers current and later Codex images in order without replaying context-only pixels', async () => {
  const f = fixture(),
    x = await codex(f);
  const first = x.adapter.run(
    { ...f.input, messages: [f.input.history![0]!] },
    () => {},
    new AbortController().signal,
  );
  expect(x.wire.sent.at(-1).params.input).toEqual(
    expect.arrayContaining([
      { type: 'text', text: `Chittr image for message #m1, attachment ${f.metadata.id}.` },
      { type: 'image', url: `data:image/png;base64,${tinyPng().toString('base64')}` },
    ]),
  );
  x.wire.complete();
  await first;
  const plain = x.adapter.run(f.input, () => {}, new AbortController().signal);
  expect(x.wire.sent.at(-1).params.input.every((item: any) => item.type === 'text')).toBe(true);
  x.wire.complete();
  await plain;
  const later = x.adapter.run(
    { ...f.input, messages: [{ ...f.input.history![0]!, id: 'later' }] },
    () => {},
    new AbortController().signal,
  );
  expect(x.wire.sent.at(-1).params.input.at(-2).text).toContain('message #later,');
  expect(x.wire.sent.at(-1).params.threadId).toBe(x.wire.sessionId);
  x.wire.complete();
  await later;
});

it('unwraps Codex historical results at the native boundary and rejects obsolete/cross-session calls', async () => {
  const f = fixture(),
    x = await codex(f);
  const turn = x.adapter.run(f.input, () => {}, new AbortController().signal);
  await Promise.resolve();
  const result = await x.call('read_attachment', { attachment_id: f.metadata.id });
  expect(result.result.contentItems[1]).toEqual({
    type: 'inputImage',
    imageUrl: `data:image/png;base64,${tinyPng().toString('base64')}`,
  });
  for (const overrides of [
    { turnId: 'obsolete' },
    { turnId: undefined },
    { threadId: randomUUID() },
  ]) {
    const invalid = await x.call('read_attachment', { attachment_id: f.metadata.id }, overrides);
    expect(invalid.result.success).toBe(false);
    expect(JSON.stringify(invalid)).not.toContain(tinyPng().toString('base64'));
  }
  const history = await x.call('read_conversation', {});
  expect(history.result.contentItems).toHaveLength(1);
  expect(history.result.contentItems[0].type).toBe('inputText');
  x.wire.complete();
  await turn;
  expect((await x.call('read_attachment', { attachment_id: f.metadata.id })).result.success).toBe(
    false,
  );
});

it('returns a bounded Codex failure if serialization is interrupted after resolving pixels', async () => {
  const f = fixture(),
    x = await codex(f),
    abort = new AbortController();
  const turn = x.adapter.run(f.input, () => {}, abort.signal).catch(() => {});
  await Promise.resolve();
  const send = x.wire.send.bind(x.wire);
  x.wire.send = (value: any, validate?: (serialized: string) => void) => {
    if (value.result?.contentItems?.some((item: any) => item.type === 'inputImage')) abort.abort();
    return send(value, validate);
  };
  const result = await x.call('read_attachment', { attachment_id: f.metadata.id });
  expect(result.result.success).toBe(false);
  expect(JSON.stringify(result).length).toBeLessThan(500);
  expect(
    x.wire.sent.every(
      (value: any) => !value.result?.contentItems?.some((item: any) => item.type === 'inputImage'),
    ),
  ).toBe(true);
  await turn;
});

it('keeps stale native turn notifications from authorizing an old image tool call', async () => {
  const f = fixture(),
    x = await codex(f);
  const first = x.adapter.run(f.input, () => {}, new AbortController().signal);
  await Promise.resolve();
  x.wire.complete();
  await first;
  const second = x.adapter.run(f.input, () => {}, new AbortController().signal);
  await Promise.resolve();
  x.wire.emit('message', {
    method: 'turn/started',
    params: { threadId: x.wire.sessionId, turn: { id: 'turn-1' } },
  });
  try {
    const result = await x.call(
      'read_attachment',
      { attachment_id: f.metadata.id },
      { turnId: 'turn-1' },
    );
    expect(result.result.success).toBe(false);
    x.wire.emit('message', {
      method: 'turn/completed',
      params: { threadId: x.wire.sessionId, turn: { id: 'turn-1', status: 'completed' } },
    });
    const current = await x.call('read_attachment', { attachment_id: f.metadata.id });
    expect(current.result.contentItems[1].type).toBe('inputImage');
  } finally {
    x.wire.complete();
    await second;
  }
});

it('rejects image calls before native acceptance and interrupts a late accepted aborted turn', async () => {
  const f = fixture(),
    x = await codex(f),
    abort = new AbortController();
  const rpc = x.wire.rpc.bind(x.wire);
  let acknowledge!: () => void;
  x.wire.rpc = async (method: string, ...args: any[]) => {
    const result = await rpc(method, ...args);
    if (method === 'turn/start')
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
    if (method === 'turn/interrupt') x.wire.sent.push({ method, params: args[0] });
    return result;
  };
  const turn = x.adapter.run(f.input, () => {}, abort.signal);
  await Promise.resolve();
  x.wire.emit('message', {
    method: 'turn/started',
    params: { threadId: x.wire.sessionId, turn: { id: 'turn-1' } },
  });
  for (const overrides of [{}, { turnId: undefined }])
    expect(
      (await x.call('read_attachment', { attachment_id: f.metadata.id }, overrides)).result.success,
    ).toBe(false);
  abort.abort();
  await expect(turn).rejects.toThrow('Interrupted');
  acknowledge();
  await vi.waitFor(() =>
    expect(x.wire.sent).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: x.wire.sessionId, turnId: 'turn-1' },
    }),
  );
});
