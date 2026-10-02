import {
  claudeImageSupport,
  codexImageSupport,
  grokImageSupport,
  unavailableImageSupport,
  legacyRestrictedGrokBuild,
} from '../src/image-support.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolService, toolInputs, toolSpecs } from '../src/tools.js';
import { AttachmentStore, FileAttachmentResolver, attachmentLimits } from '../src/attachments.js';
import { AttachmentResult, codexToolResult, mcpToolResult } from '../src/attachment-result.js';
import { turnPrompt } from '../src/protocol.js';
import { providerEventBytes } from '../src/process.js';
import {
  checkpointChunks,
  checkpointPrompt,
  publicMessage,
  reconstructionPrompt,
  contextBudgets,
} from '../src/checkpoint.js';
import { tinyPng, paddedPng } from './image-fixture.js';
import type { AttachmentMetadata, Message } from '../src/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let root: string;
let store: AttachmentStore;
let session: string;
let tools: ToolService;
let metadata: AttachmentMetadata;
const policy = { edits: false, commands: false, network: false };
const message = (
  id: string,
  attachments?: AttachmentMetadata[],
  text = 'Public image',
): Message => ({
  id,
  sequence: Number(id.slice(1)),
  author: 'human',
  recipients: ['another-agent'],
  text,
  replyTo: [],
  roots: [],
  createdAt: new Date().toISOString(),
  deliveries: {},
  ...(attachments ? { attachments } : {}),
});
const query = () => ({ attachment_id: metadata.id });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'retrieval-test-'));
  mkdirSync(join(root, 'workspace'));
  store = new AttachmentStore(join(root, 'state'));
  session = randomUUID();
  metadata = store.stage({
    sessionId: session,
    operationId: randomUUID(),
    filename: 'fixture.png',
    mediaType: 'image/png',
    bytes: tinyPng(),
  });
  tools = new ToolService(
    join(root, 'workspace'),
    policy,
    undefined,
    [],
    undefined,
    undefined,
    store.access(session),
  );
  tools.registerRetrievalBridge({
    key: 'grok-mcp-image',
    report: grokImageSupport({
      cliVersion: legacyRestrictedGrokBuild,
      requestedModel: 'provider default',
      observedModel: 'grok-4.6',
      permissions: policy,
      skillsEnabled: false,
      nativeInventoryVerified: true,
    }),
  });
  tools.setHistory([message('m1', [metadata])]);
  tools.beginTurn();
});
afterEach(() => {
  tools.close();
  rmSync(root, { recursive: true, force: true });
});

it('registers strict identity-only retrieval in every derived inventory', () => {
  expect(toolSpecs().find((x) => x.name === 'read_attachment')).toBeDefined();
  for (const bad of [
    { path: '/etc/passwd' },
    { attachment_id: '../image' },
    { ...query(), url: 'https://example.com' },
    { ...query(), path: 'file' },
    { ...query(), bridge: 'grok-mcp-image' },
  ])
    expect(toolInputs.read_attachment.safeParse(bad).success).toBe(false);
});
it('authorizes directed public messages, preserves image identity, and refuses ordinary serialization', async () => {
  const result = await tools.call('read_attachment', query());
  expect(result).toBeInstanceOf(AttachmentResult);
  expect(() => JSON.stringify(result)).toThrow('cannot be serialized');
  const native = mcpToolResult(result);
  expect(native.content[1]).toEqual({
    type: 'image',
    mimeType: 'image/png',
    data: tinyPng().toString('base64'),
  });
  expect(JSON.parse((native.content[0] as any).text)).toMatchObject({
    messageId: 'm1',
    attachment: metadata,
    sha256: store.access(session).resolve(metadata.id).sha256,
  });
  expect(JSON.stringify(codexToolResult(result))).not.toContain(tinyPng().toString('base64'));
  expect(codexToolResult({ text: 'legacy' })).toEqual({
    success: true,
    contentItems: [{ type: 'inputText', text: '{"text":"legacy"}' }],
  });
  expect(mcpToolResult({ text: 'legacy' })).toEqual({
    content: [{ type: 'text', text: '{"text":"legacy"}' }],
  });
});
it('denies unknown, cross-session, staged-only, and summary-invented IDs without bytes', async () => {
  const other = store.stage({
    sessionId: randomUUID(),
    operationId: randomUUID(),
    filename: 'fixture.png',
    mediaType: 'image/png',
    bytes: tinyPng(),
  });
  for (const id of [`att-${'f'.repeat(32)}`, other.id]) {
    tools.setHistory([message('m1', [{ ...other, id }])]);
    tools.beginTurn();
    const result = await tools.call('read_attachment', { attachment_id: id });
    expect(result).not.toBeInstanceOf(AttachmentResult);
    expect(JSON.stringify(result)).not.toContain(tinyPng().toString('base64'));
  }
  tools.setHistory([message('m2', undefined, `Summary claims attachment ${metadata.id}`)]);
  tools.beginTurn();
  expect(await tools.call('read_attachment', query())).toMatchObject({
    error: 'attachment-not-found',
  });
});
it.each(['completion', 'interrupt', 'maintenance', 'close', 'replacement', 'snapshot', 'session'])(
  'revokes an already resolved result and late calls on %s',
  async (kind) => {
    const result = await tools.call('read_attachment', query());
    if (kind === 'completion') tools.endTurn();
    if (kind === 'interrupt') tools.interrupt();
    if (kind === 'maintenance') tools.setMaintenance(true);
    if (kind === 'close') tools.close();
    if (kind === 'replacement') {
      tools.setHistory([message('m1', [metadata])]);
      tools.beginTurn();
    }
    if (kind === 'snapshot') writeFileSync(tools.historyFile, '[]');
    if (kind === 'session') tools.attachmentAccess!.settings.sessionId = randomUUID();
    expect(() => mcpToolResult(result)).toThrow();
    if (!['replacement', 'close', 'maintenance'].includes(kind))
      expect(await tools.call('read_attachment', query())).not.toBeInstanceOf(AttachmentResult);
    if (kind === 'replacement')
      expect(await tools.call('read_attachment', query())).toBeInstanceOf(AttachmentResult);
  },
);
it('rechecks external cancellation at native serialization and cancellation inside the resolver', async () => {
  const abort = new AbortController();
  const result = await tools.call('read_attachment', query(), abort.signal);
  abort.abort();
  expect(() => mcpToolResult(result)).toThrow();
  const resolve = tools.attachmentAccess!.resolve;
  tools.attachmentAccess!.resolve = (id) => {
    const value = resolve(id);
    tools.interrupt();
    return value;
  };
  expect(await tools.call('read_attachment', query())).not.toBeInstanceOf(AttachmentResult);
});
it('fails byte-free on unverified bridges, corrupt/missing content, resolver failures and native limits', async () => {
  tools.registerRetrievalBridge({ key: 'unavailable', report: grokImageSupport() });
  tools.beginTurn();
  expect(await tools.call('read_attachment', query())).toMatchObject({
    error: 'attachment-unavailable',
  });
  tools.registerRetrievalBridge({
    key: 'grok-mcp-image',
    report: grokImageSupport({
      cliVersion: legacyRestrictedGrokBuild,
      requestedModel: 'provider default',
      observedModel: 'grok-4.6',
      permissions: policy,
      skillsEnabled: false,
      nativeInventoryVerified: true,
    }),
  });
  tools.beginTurn();
  const resolved = store.access(session).resolve(metadata.id);
  tools.attachmentAccess!.resolve = () => {
    throw new Error(`private path and ${tinyPng().toString('base64')}`);
  };
  expect(JSON.stringify(await tools.call('read_attachment', query()))).not.toContain(
    tinyPng().toString('base64'),
  );
  expect(() =>
    mcpToolResult(new AttachmentResult('x'.repeat(providerEventBytes), resolved, () => {})),
  ).toThrow('transport limit');
  for (const bytes of [Buffer.from('corrupt'), paddedPng(attachmentLimits.perImageBytes + 1)]) {
    tools.attachmentAccess!.resolve = () => ({ ...resolved, bytes });
    expect(() =>
      mcpToolResult(new AttachmentResult('m1', { ...resolved, bytes }, () => {})),
    ).toThrow();
  }
  rmSync(join(root, 'state', session, 'attachments', 'blobs'), { recursive: true });
  tools.attachmentAccess!.resolve = (id) => store.access(session).resolve(id);
  expect(await tools.call('read_attachment', query())).toMatchObject({
    error: 'attachment-corrupt',
  });
});
it('exposes exact and paginated metadata at call time without bytes, including legacy history', async () => {
  const first = await tools.call('read_conversation', { message_id: 'm1' });
  expect(first).toMatchObject({ id: 'm1', attachments: [metadata] });
  tools.setHistory([message('m0'), message('m1', [metadata])]);
  tools.beginTurn();
  expect(await tools.call('read_conversation', { offset: 1, limit: 1 })).toMatchObject({
    messages: [first],
    total: 2,
    nextOffset: null,
  });
  expect(readFileSync(tools.historyFile, 'utf8')).not.toContain(tinyPng().toString('base64'));
});
it('preserves ordered references in context, required/reply/consultation messages, digests and bounded seeds', () => {
  const second = { ...metadata, id: `att-${'b'.repeat(32)}` };
  const old = message('m1', [metadata, second]);
  const required = {
    ...message('m2', [second]),
    replyTo: ['m1'],
    consultation: { questionId: 'm1', roundId: randomUUID() },
  };
  const parsed = JSON.parse(
    turnPrompt({
      messages: [required],
      context: [old],
      history: [old, required],
      participants: ['a'],
    }),
  );
  for (const value of [
    parsed.context[0],
    parsed.replyTargets[0],
    parsed.consultationContext[0].question[0],
    publicMessage(old),
  ])
    expect(value.attachments).toEqual([metadata, second]);
  expect(parsed.requiredMessages[0].attachments).toEqual([second]);
  const history = [
    old,
    ...Array.from({ length: 40 }, (_, n) => message(`m${n + 2}`, undefined, 'x'.repeat(3000))),
  ];
  const digest = JSON.parse(turnPrompt({ messages: [], context: history, participants: [] }));
  expect(digest.restoredHistorySummary.messages[0].attachments).toEqual([metadata, second]);
  const huge = [
    old,
    ...Array.from({ length: 400 }, (_, n) => message(`m${n + 2}`, undefined, 'x'.repeat(500))),
  ];
  const fallback = JSON.parse(turnPrompt({ messages: [], context: huge, participants: [] }));
  expect(fallback.restoredHistorySummary.label).toContain('pagination');
  expect(JSON.stringify(fallback)).not.toContain(metadata.id);
  const chunks = checkpointChunks(history, []);
  expect(JSON.parse(checkpointPrompt([], chunks[0]!)).messages[0].attachments).toEqual([
    metadata,
    second,
  ]);
  const checkpoint = {
    version: 1,
    sourceAgent: 'a',
    createdAt: new Date().toISOString(),
    through: 41,
    messageId: 'm41',
    entries: [],
  };
  const handoff = { agent: 'a', fingerprint: 'a', through: 41, text: '', available: false };
  const seed = reconstructionPrompt(checkpoint, handoff, history);
  expect(Buffer.byteLength(seed)).toBeLessThanOrEqual(contextBudgets.seed);
  expect(seed).not.toContain(metadata.id);
  expect(seed).toContain('read_conversation');
  expect(reconstructionPrompt(checkpoint, handoff, [old])).toContain(metadata.id);
  for (const value of [
    seed,
    JSON.stringify(parsed),
    JSON.stringify(digest),
    JSON.stringify(fallback),
    checkpointPrompt([], chunks[0]!),
  ])
    expect(value).not.toContain(tinyPng().toString('base64'));
});

it('uses the real separate MCP process for native results and cross-process turn revocation', async () => {
  const settings = await tools.mcpSettings('a');
  const client = new Client({ name: 'retrieval-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'dist/mcp.js'), JSON.stringify(settings)],
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((x) => x.name)).toContain('read_attachment');
    const read = () => client.callTool({ name: 'read_attachment', arguments: query() });
    for (const extra of [
      { ['x'.repeat(200000)]: 'secret' },
      Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['key' + i, 'secret'])),
    ]) {
      const rejected = await client.callTool({
        name: 'read_attachment',
        arguments: { ...query(), ...extra },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected).length).toBeLessThan(500);
      expect(JSON.stringify(rejected)).not.toContain('secret');
    }

    expect((await read()).content).toEqual(
      mcpToolResult(await tools.call('read_attachment', query())).content,
    );
    tools.interrupt();
    expect(JSON.stringify(await read())).not.toContain(tinyPng().toString('base64'));
    tools.setHistory([message('m1', [metadata])]);
    tools.beginTurn();
    expect((await read()).content).toMatchObject([{ type: 'text' }, { type: 'image' }]);
    tools.endTurn();
    expect(JSON.stringify(await read())).not.toContain(tinyPng().toString('base64'));
    tools.setMaintenance(true);
    expect((await read()).isError).toBe(true);
    tools.setMaintenance(false);
    tools.beginTurn();
    writeFileSync(tools.historyFile, '[]');
    expect(JSON.stringify(await read())).not.toContain(tinyPng().toString('base64'));
    tools.setHistory([message('m1', [metadata])]);
    tools.registerRetrievalBridge({ key: 'unavailable', report: grokImageSupport() });
    tools.beginTurn();
    expect(JSON.stringify(await read())).toContain('attachment-unavailable');
    tools.registerRetrievalBridge({
      key: 'grok-mcp-image',
      report: grokImageSupport({
        cliVersion: legacyRestrictedGrokBuild,
        requestedModel: 'provider default',
        observedModel: 'grok-4.6',
        permissions: policy,
        skillsEnabled: false,
        nativeInventoryVerified: true,
      }),
    });
    tools.beginTurn();
    const state = JSON.parse(readFileSync(tools.attachmentTurnFile, 'utf8'));
    writeFileSync(tools.attachmentTurnFile, JSON.stringify({ ...state, sessionId: randomUUID() }));
    expect(JSON.stringify(await read())).not.toContain(tinyPng().toString('base64'));
    tools.close();
    expect((await read()).isError).toBe(true);
  } finally {
    await client.close();
  }
}, 20000);

it('requires an approved mapping and a live report, and revokes already obtained results on registration changes', async () => {
  const accepted = grokImageSupport({
    cliVersion: legacyRestrictedGrokBuild,
    requestedModel: 'provider default',
    observedModel: 'grok-4.6',
    permissions: policy,
    skillsEnabled: false,
    nativeInventoryVerified: true,
  });
  const previous = await tools.call('read_attachment', query());
  tools.registerRetrievalBridge({ key: 'future-native-image', report: accepted });
  expect(() => mcpToolResult(previous)).toThrow(/attachment turn/i);
  tools.beginTurn();
  expect(await tools.call('read_attachment', query())).toEqual({
    error: 'attachment-unavailable',
    message: 'Native image retrieval is unavailable for this provider bridge.',
  });
  tools.registerRetrievalBridge({ key: 'grok-mcp-image', report: grokImageSupport() });
  tools.beginTurn();
  const unavailable = await tools.call('read_attachment', query());
  expect(unavailable).toMatchObject({
    error: 'attachment-unavailable',
    message: expect.stringContaining('retrieval tuple is unknown'),
  });
  expect(mcpToolResult(unavailable).content).toHaveLength(1);
  tools.registerRetrievalBridge({
    key: 'grok-mcp-image',
    report: { ...accepted, provider: 'codex' },
  });
  tools.beginTurn();
  expect(await tools.call('read_attachment', query())).not.toBeInstanceOf(AttachmentResult);
});

it('authorizes retrieval from unlisted Claude and Codex builds without widening key or authority checks', async () => {
  const claude = (patch: Record<string, unknown> = {}) =>
    claudeImageSupport({
      cliVersion: '2.1.278 (Claude Code)',
      requestedModel: 'opus',
      requestedEffort: 'xhigh',
      observedModel: 'claude-opus-5',
      connected: true,
      nativeInventoryVerified: true,
      ...patch,
    });
  const codex = (patch: Record<string, unknown> = {}) =>
    codexImageSupport({
      cliVersion: 'codex-cli 0.155.1',
      requestedModel: 'gpt-6-astra',
      requestedEffort: 'xhigh',
      observedModel: 'gpt-6-astra',
      observedEffort: 'xhigh',
      nativePolicyVerified: true,
      ...patch,
    });
  // An available report on a build with no catalog entry reaches the mapping.
  for (const [key, report] of [
    ['claude-mcp-image', claude()],
    ['codex-dynamic-image', codex()],
  ] as const) {
    tools.registerRetrievalBridge({ key, report });
    tools.beginTurn();
    const result = await tools.call('read_attachment', query());
    expect(result, key).toBeInstanceOf(AttachmentResult);
    expect((mcpToolResult(result).content[1] as any).data).toBe(tinyPng().toString('base64'));
  }
  // Version evidence authorizes no mapping: a wrong-provider or unknown key is
  // still rejected, and so is a genuinely unavailable report on the same build.
  for (const [key, report] of [
    ['codex-dynamic-image', claude()],
    ['claude-mcp-image', codex()],
    ['future-native-image', claude()],
    ['claude-mcp-image', claude({ nativeInventoryVerified: false })],
    ['codex-dynamic-image', codex({ nativePolicyVerified: false })],
  ] as const) {
    tools.registerRetrievalBridge({ key, report });
    tools.beginTurn();
    const response = await tools.call('read_attachment', query());
    expect(response, key).toMatchObject({ error: 'attachment-unavailable' });
    expect(JSON.stringify(mcpToolResult(response))).not.toContain(tinyPng().toString('base64'));
  }
  // Retrieval authority is still revoked by a registration change.
  tools.registerRetrievalBridge({ key: 'claude-mcp-image', report: claude() });
  tools.beginTurn();
  const authorized = await tools.call('read_attachment', query());
  tools.registerRetrievalBridge({ key: 'claude-mcp-image', report: claude() });
  expect(() => mcpToolResult(authorized)).toThrow(/attachment turn/i);
});

it('does not let an isolated MCP reader register its own mapping', () => {
  const reader = new ToolService(
    tools.workspace,
    policy,
    tools.historyFile,
    [],
    undefined,
    tools.maintenanceFile,
    store.access(session),
    tools.attachmentTurnFile,
  );
  try {
    expect(() =>
      reader.registerRetrievalBridge({ key: 'grok-mcp-image', report: grokImageSupport() }),
    ).toThrow('No active room tool host');
  } finally {
    reader.close();
  }
});

it.each(['codex', 'claude', 'antigravity'] as const)(
  'returns a byte-free %s refusal through the tool boundary',
  async (provider) => {
    tools.registerRetrievalBridge({
      key: provider,
      report: unavailableImageSupport(provider, 'private token and arbitrary diagnostics'),
    });
    tools.beginTurn();
    const response = await tools.call('read_attachment', query());
    expect(response).toMatchObject({ error: 'attachment-unavailable' });
    const native = JSON.stringify(mcpToolResult(response));
    expect(native).toContain(`${provider} image support is unavailable`);
    expect(native).toContain('unknown or unavailable');
    expect(native).not.toContain('private token');
    expect(native).not.toContain(tinyPng().toString('base64'));
  },
);

// The MCP SDK reads at most 10 MiB per inbound message, so the largest legal
// request ID with the largest image is the worst complete response. Claude
// replays MCP image results twice; that doubled response must fit the reader.
it('fits the doubled Claude replay of a maximum image with a maximum legal request ID through real MCP dispatch', async () => {
  const largest = paddedPng(attachmentLimits.perImageBytes);
  const image = store.stage({
    sessionId: session,
    operationId: randomUUID(),
    filename: 'largest.png',
    mediaType: 'image/png',
    bytes: largest,
  });
  tools.setHistory([message('m1', [image])]);
  tools.registerRetrievalBridge({
    key: 'claude-mcp-image',
    report: claudeImageSupport({
      cliVersion: '2.1.268 (Claude Code)',
      requestedModel: 'opus',
      requestedEffort: 'xhigh',
      observedModel: 'claude-opus-5',
      observedEffort: 'xhigh',
      connected: true,
      nativeInventoryVerified: true,
    }),
  });
  tools.beginTurn();
  const settings = await tools.mcpSettings('a');
  const client = new Client({ name: 'dispatch-limit-test', version: '1' });
  // This client stands in for the provider, which reads more than the SDK default.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'dist/mcp.js'), JSON.stringify(settings)],
    stderr: 'pipe',
    maxBufferSize: providerEventBytes,
  });
  try {
    await client.connect(transport);
    const send = transport.send.bind(transport);
    const receive = transport.onmessage!;
    // A legal JSON-RPC string ID just under the SDK's inbound message bound.
    const largestId = 'x'.repeat(10 * 1024 * 1024 - 64 * 1024);
    let clientId: string | number | undefined;
    let responseBytes = 0;
    transport.send = async (request) => {
      if ('method' in request && request.method === 'tools/call' && 'id' in request) {
        clientId = request.id;
        return send({ ...request, id: largestId });
      }
      return send(request);
    };
    transport.onmessage = (response) => {
      if ('id' in response && response.id === largestId) {
        responseBytes = Buffer.byteLength(JSON.stringify(response));
        receive({ ...response, id: clientId! });
      } else receive(response);
    };
    const result = await client.callTool(
      { name: 'read_attachment', arguments: { attachment_id: image.id } },
      undefined,
      { timeout: 10000 },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject([{ type: 'text' }, { type: 'image' }]);
    expect((result.content as any)[1].data).toBe(largest.toString('base64'));
    expect(responseBytes).toBeGreaterThan(largestId.length + largest.length);
    expect(2 * responseBytes + 256 * 1024).toBeLessThan(providerEventBytes);
  } finally {
    await client.close();
  }
}, 20000);
