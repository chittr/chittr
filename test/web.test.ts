import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import { Room } from '../src/room.js';
import { WebUI } from '../src/web.js';
import { complete } from '../src/completion.js';
import type { RoomConfig } from '../src/types.js';
import { alternatePng, paddedPng, tinyPng } from './image-fixture.js';

// These HTTP tests assert response shapes at runtime, including malformed requests.
// JSON.parse keeps the wire payload dynamic instead of claiming a validated server type.
const fetch = async (
  ...args: Parameters<typeof globalThis.fetch>
): Promise<Omit<Response, 'json'> & { json(): Promise<any> }> => {
  const response = await globalThis.fetch(...args);
  return Object.assign(response, { json: async () => JSON.parse(await response.text()) });
};

vi.mock('../src/ui/attachment-input.js', { spy: true });

let base: string,
  origin: string,
  token: string,
  controller: RoomController,
  web: WebUI,
  store: SessionStore;
const post = (path: string, data: unknown, headers: Record<string, string> = {}) =>
  fetch(origin + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
const command = (
  line: string,
  id = randomUUID(),
  sessionId = controller.room.session.id,
  extra = {},
) => post('/api/command', { id, sessionId, line, ...extra });
const upload = (
  bytes = tinyPng(),
  operationId = randomUUID(),
  sessionId = controller.room.session.id,
  mediaType = 'image/png',
  filename = 'fixture.png',
  headers: Record<string, string> = {},
) =>
  fetch(
    `${origin}/api/attachments?sessionId=${encodeURIComponent(sessionId)}&operationId=${encodeURIComponent(operationId)}&filename=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mediaType, ...headers },
      body: bytes,
    },
  );
beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'web-test-')));
  const workspace = join(base, 'project');
  mkdirSync(workspace);
  const assets = join(base, 'assets');
  mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<h1>App</h1>');
  const config: RoomConfig = {
    workspace,
    humanName: 'Bill',
    permissions: { edits: false, commands: false, network: false },
    followUpTurns: 8,
    sources: [],
    provenance: {},
    agents: {},
  };
  store = new SessionStore(workspace, join(base, 'state'));
  store.acquire();
  controller = new RoomController(config, store, undefined, {
    help: 'Commands help',
    quit: async () => {
      await controller.close();
      web.unmount();
    },
    createRoom: (c, s, session) => new Room(c, s, session),
  });
  web = new WebUI(controller, { assets });
  const url = new URL(await web.mount());
  origin = url.origin;
  token = url.hash.slice(1);
  await controller.room.start();
});
afterEach(async () => {
  await controller?.close();
  web?.unmount();
  store?.release();
  if (base) rmSync(base, { recursive: true, force: true });
});

it('shares pins between browser commands, snapshots, and saved sessions', async () => {
  await controller.submit('@human Save this message');
  const id = randomUUID();
  expect((await (await command('/pin #m1', id)).json()).ok).toBe(true);
  expect((await (await command('/pin #m1', id)).json()).ok).toBe(true);
  expect(web.snapshot().session.pinnedMessageIds).toEqual(['m1']);
  expect(store.load()?.pinnedMessageIds).toEqual(['m1']);
  const snapshot = await (await post('/api/connect', {})).json();
  expect(snapshot.session.pinnedMessageIds).toEqual(['m1']);
  expect(snapshot.session.messages).toHaveLength(1);
  expect((await (await command('/unpin #m1')).json()).ok).toBe(true);
  expect(web.snapshot().session.pinnedMessageIds).toEqual([]);
  expect((await (await command('/pin #m999')).json()).error).toContain('Unknown message');
  expect(web.snapshot().session.pinnedMessageIds).toEqual([]);
});

it('shares saved context readings between browser snapshots and /participants', async () => {
  const config = structuredClone(controller.room.config);
  config.agents.codex = {
    id: 'codex',
    provider: 'codex',
    enabled: false,
    instructions: '',
    fingerprint: 'codex',
  };
  await controller.room.reload(config);
  await controller.submit('/participants');
  expect(controller.room.session.notices.at(-1)?.text).toContain('Context: unavailable');
  const usage = { usedTokens: 72000, maxTokens: 200000, updatedAt: '2026-09-08T12:00:00.000Z' };
  controller.room.session.agents.codex!.contextUsage = usage;
  await controller.submit('/participants');
  const snapshot = await (await post('/api/connect', {})).json();
  expect(snapshot.agents[0].contextUsage).toEqual(usage);
  expect(snapshot.session.notices.at(-1).text).toContain(
    'Context: 72,000 / 200,000 tokens · 36.0% used · last reported 2026-09-08T12:00:00.000Z',
  );
  expect(store.load()?.agents.codex!.contextUsage).toEqual(usage);
});

it('shares participant settings between web snapshots and the terminal command, including reloads', async () => {
  const next = structuredClone(controller.room.config);
  next.agents = Object.fromEntries(
    ['astra', 'gemini'].map((id) => [
      id,
      {
        id,
        provider: id === 'gemini' ? ('antigravity' as const) : ('codex' as const),
        ...(id === 'astra' ? { model: 'gpt-6-astra', effort: 'high' } : {}),
        enabled: false,
        instructions: '',
        fingerprint: id,
      },
    ]),
  );
  await controller.room.reload(next);
  const connected = await post('/api/connect', {});
  const snapshot = await connected.json();
  expect(snapshot.agents).toEqual([
    expect.objectContaining({
      id: 'astra',
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      enabled: false,
    }),
    expect.objectContaining({
      id: 'gemini',
      provider: 'antigravity',
      model: 'provider default',
      effort: 'provider default',
      enabled: false,
    }),
  ]);
  expect(controller.configSummary().agents).toEqual([
    expect.objectContaining({ id: 'astra', provider: 'codex', effort: 'high' }),
    expect.objectContaining({ id: 'gemini', provider: 'antigravity', effort: 'provider default' }),
  ]);
  expect(snapshot.agents.every((agent: object) => !('name' in agent))).toBe(true);
  await controller.submit('/participants');
  const details = controller.room.session.notices.at(-1)!.text;
  expect(details).toContain('Bill (@human)');
  expect(details).toContain(
    '@astra · disabled\n  Provider: codex · Model: gpt-6-astra · Effort: high',
  );
  expect(details).toContain(
    '@gemini · disabled\n  Provider: antigravity · Model: provider default · Effort: provider default',
  );
  expect(details).toContain('Detail: Disabled in config');
  expect(controller.room.session.messages).toHaveLength(0);

  const updated = structuredClone(next);
  updated.agents.astra!.model = 'gpt-5.6-sol';
  updated.agents.astra!.effort = 'medium';
  updated.agents.astra!.fingerprint = 'astra-v2';
  delete updated.agents.gemini;
  await controller.room.reload(updated);
  expect(web.snapshot().agents.find((agent) => agent.id === 'astra')).toMatchObject({
    model: 'gpt-5.6-sol',
    effort: 'medium',
  });
  await controller.submit('/participants');
  const refreshed = controller.room.session.notices.at(-1)!.text;
  expect(refreshed).toContain('Model: gpt-5.6-sol · Effort: medium');
  expect(refreshed).not.toContain('@gemini');
  expect(refreshed).not.toContain('gpt-6-astra');
});

it('reports activity, pauses, errors and queues without advancing work or sending a message', async () => {
  const next = structuredClone(controller.room.config);
  next.agents.fixture = {
    id: 'fixture',
    provider: 'codex',
    enabled: false,
    instructions: '',
    fingerprint: 'fixture',
  };
  await controller.room.reload(next);
  // A retained participant can have a paused queue and a failed delivery.
  controller.room.send('@human queued');
  controller.room.send('@human failed');
  controller.room.session.messages[0]!.deliveries.fixture = { status: 'queued' };
  controller.room.session.messages[1]!.deliveries.fixture = { status: 'failed' };
  Object.assign(controller.room.session.agents.fixture!, {
    activity: 'waiting',
    stopped: true,
    error: 'Provider disconnected',
  });
  controller.room.pause();
  const before = structuredClone(controller.room.session);
  const response = await command('/participants');
  expect((await response.json()).ok).toBe(true);
  const details = controller.room.session.notices.at(-1)!.text;
  expect(details).toContain('Participants · room paused');
  expect(details).toContain('Connection: unavailable · Status: Stopped');
  expect(details).toContain('Paused: yes · Stopped: yes');
  expect(details).toContain('Queue: 1 queued · 0 at follow-up limit · 1 unresolved');
  expect(details).toContain('Error: Provider disconnected');
  expect(controller.room.session.messages).toEqual(before.messages);
  expect(controller.room.session.agents).toEqual(before.agents);
  expect(web.snapshot().agents[0]).toMatchObject({
    activity: 'waiting',
    stopped: true,
    error: 'Provider disconnected',
    pending: { queued: 1, capped: 0, unresolved: 1 },
  });
  await expect(controller.submit('/participants extra')).rejects.toThrow('Usage: /participants');
});

it('makes the participant command discoverable and handles rooms without agents', async () => {
  expect(complete(controller.room.config.workspace, [], '/part', 5).suggestions).toEqual([
    '/participants ',
  ]);
  await controller.submit('/participants');
  expect(controller.room.session.notices.at(-1)!.text).toContain('No agents configured.');
});

it('shares /reply between interfaces, persists links and drafts, and recovers one accepted send', async () => {
  await controller.submit('@human Original');
  const sessionId = controller.room.session.id;
  const clientId = randomUUID();
  const draft = '/reply #m1 My answer\nSecond line';
  await post('/api/draft', { clientId, sessionId, version: 1, text: draft });
  await expect.poll(() => store.load(sessionId)!.composerDraft).toBe(draft);
  const id = randomUUID();
  const sent = await command(draft, id, sessionId, { draft: { clientId, version: 2 } });
  expect((await sent.json()).ok).toBe(true);
  await command(draft, id, sessionId, { draft: { clientId, version: 2 } });
  expect(controller.room.session.messages).toHaveLength(2);
  expect(store.load(sessionId)!.messages[1]).toMatchObject({
    replyTo: ['m1'],
    recipients: ['human'],
    text: 'My answer\nSecond line',
  });
  expect(store.load(sessionId)!.composerDraft).toBe('');
  for (const invalid of ['/reply', '/reply #m1', '/reply #m1  ', '/reply #m999 Answer']) {
    expect((await (await command(invalid)).json()).ok).toBe(false);
  }
  const failed = '/reply #m999 Keep my answer';
  await command(failed, randomUUID(), sessionId, { draft: { clientId, version: 3 } });
  await expect.poll(() => store.load(sessionId)!.composerDraft).toBe(failed);
  expect(controller.room.session.messages).toHaveLength(2);
  await command('/new');
  expect((await (await command(draft, randomUUID(), sessionId)).json()).ok).toBe(false);
  expect(controller.room.session.messages).toHaveLength(0);
  expect(complete(controller.room.config.workspace, [], '/rep', 4).suggestions).toEqual([
    '/reply ',
  ]);
});

it('serves app assets but requires launch authentication for room data and actions', async () => {
  expect((await fetch(origin)).status).toBe(200);
  expect((await fetch(origin + '/api/state')).status).toBe(401);
  expect((await post('/api/connect', {}, { Authorization: 'Bearer incorrect' })).status).toBe(401);
  const connected = await post('/api/connect', {});
  expect(connected.status).toBe(200);
  expect(connected.headers.get('set-cookie')).toBeNull();
  expect((await connected.json()).humanName).toBe('Bill');
  expect(
    (
      await fetch(origin + '/api/state', {
        headers: { Cookie: `chittr-${new URL(origin).port}=${token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (await fetch(origin + '/api/state', { headers: { Authorization: `Bearer ${token}` } })).status,
  ).toBe(200);
  expect((await fetch(origin + '/src/config.ts')).status).toBe(404);
  expect(
    (
      await fetch(origin + '/api/state', {
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://attacker.example' },
      })
    ).status,
  ).toBe(403);
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      origin + '/api/state',
      { headers: { Host: 'attacker.example', Authorization: `Bearer ${token}` } },
      (res) => {
        resolve(res.statusCode!);
        res.resume();
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(status).toBe(403);
});
it('applies repeated concurrent requests once and rejects ID reuse with different text', async () => {
  const id = randomUUID();
  const replies = await Promise.all([command('@human hello', id), command('@human hello', id)]);
  expect(await replies[0]!.json()).toEqual(await replies[1]!.json());
  expect(controller.room.session.messages.map((m) => m.text)).toEqual(['hello']);
  expect((await command('@human different', id)).status).toBe(409);
  expect((await command('@human hello', id)).status).toBe(200);
  expect(controller.room.session.messages).toHaveLength(1);
});
it('stages, drafts, sends, reads, and reloads image references through authenticated contracts', async () => {
  const uploadId = randomUUID();
  const firstResponse = await upload(tinyPng(), uploadId);
  expect(firstResponse.status).toBe(201);
  const first = (await firstResponse.json()).attachment;
  expect(first).toMatchObject({
    filename: 'fixture.png',
    mediaType: 'image/png',
    byteSize: tinyPng().length,
    width: 1,
    height: 1,
  });
  expect((await (await upload(tinyPng(), uploadId)).json()).attachment).toEqual(first);
  expect((await upload(alternatePng(), uploadId)).status).toBe(409);

  const clientId = randomUUID();
  const drafted = await post('/api/draft', {
    clientId,
    sessionId: controller.room.session.id,
    version: 1,
    baseRevision: 0,
    text: '',
    attachmentIds: [first.id],
  });
  expect(await drafted.json()).toMatchObject({ ok: true, revision: 1, accepted: true });
  expect(store.load()!.composerAttachments).toEqual([first]);
  const stale = await post('/api/draft', {
    clientId: randomUUID(),
    sessionId: controller.room.session.id,
    version: 1,
    baseRevision: 0,
    text: '',
    attachmentIds: [],
  });
  expect(stale.status).toBe(409);
  expect(store.load()!.composerAttachments).toEqual([first]);

  const sendId = randomUUID();
  const sent = await command('', sendId, controller.room.session.id, {
    attachmentIds: [first.id],
    draft: { clientId, version: 2, baseRevision: 1 },
  });
  expect(await sent.json()).toMatchObject({ ok: true });
  expect(controller.room.session.messages[0]).toMatchObject({
    text: '',
    attachments: [first],
    attachmentOperation: { id: sendId },
  });
  expect(store.load()!.composerAttachments).toEqual([]);
  expect(store.load()!.messages).toHaveLength(1);
  expect(
    (await command('', sendId, controller.room.session.id, { attachmentIds: [first.id] })).status,
  ).toBe(409);

  const image = await fetch(
    `${origin}/api/attachments/${first.id}?sessionId=${controller.room.session.id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(image.status).toBe(200);
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(image.headers.get('cache-control')).toBe('no-store');
  expect(image.headers.get('x-content-type-options')).toBe('nosniff');
  expect(image.headers.get('etag')).toMatch(/^"sha256-/);
  expect(Buffer.from(await image.arrayBuffer())).toEqual(tinyPng());
  const snapshot = JSON.stringify(web.snapshot());
  expect(snapshot).toContain(first.id);
  expect(snapshot).not.toContain(tinyPng().toString('base64'));
  const sessionFile = readFileSync(
    join(store.directory, controller.room.session.id, 'session.json'),
    'utf8',
  );
  expect(sessionFile).toContain(first.id);
  expect(sessionFile).not.toContain(tinyPng().toString('base64'));
});

it('rejects an acknowledged attachment operation after restart when attachmentIds is omitted', async () => {
  const attachment = (await (await upload()).json()).attachment;
  const sessionId = controller.room.session.id;
  const sendId = randomUUID();
  expect(
    await (await command('caption', sendId, sessionId, { attachmentIds: [attachment.id] })).json(),
  ).toMatchObject({ ok: true, sessionId });
  expect(controller.room.session.messages).toHaveLength(1);

  const config = controller.room.config;
  web.unmount();
  await controller.close();
  controller = new RoomController(config, store, store.load(sessionId), {
    help: 'Commands help',
    quit: async () => {
      await controller.close();
      web.unmount();
    },
    createRoom: (roomConfig, persistence, session) => new Room(roomConfig, persistence, session),
  });
  web = new WebUI(controller, { assets: join(base, 'assets') });
  const mounted = new URL(await web.mount());
  origin = mounted.origin;
  token = mounted.hash.slice(1);
  await controller.room.start();

  const clientId = randomUUID();
  expect(
    await (
      await post('/api/draft', {
        clientId,
        sessionId,
        version: 1,
        text: 'keep this draft',
      })
    ).json(),
  ).toMatchObject({ ok: true, revision: 1, accepted: true });
  expect(
    (
      await command('caption', sendId, sessionId, {
        draft: { clientId, version: 2 },
      })
    ).status,
  ).toBe(409);
  expect(controller.room.session.composerDraft).toBe('keep this draft');
  expect(controller.room.session.composerDraftRevision).toBe(1);
  expect(controller.room.session.messages).toHaveLength(1);
  expect(controller.room.session.messages[0]?.attachmentOperation?.id).toBe(sendId);

  web.unmount();
  await controller.close();
  controller = new RoomController(config, store, store.load(sessionId), {
    help: 'Commands help',
    quit: async () => {
      await controller.close();
      web.unmount();
    },
    createRoom: (roomConfig, persistence, session) => new Room(roomConfig, persistence, session),
  });
  web = new WebUI(controller, { assets: join(base, 'assets') });
  const remounted = new URL(await web.mount());
  origin = remounted.origin;
  token = remounted.hash.slice(1);
  await controller.room.start();

  expect((await command('/pause', sendId, sessionId)).status).toBe(409);
  expect(controller.room.session.paused).toBe(false);
  expect(controller.room.session.composerDraft).toBe('keep this draft');
  expect(controller.room.session.messages).toHaveLength(1);
});

it('rejects unauthenticated, cross-session, malformed, mismatched, and oversized image traffic', async () => {
  const sessionId = controller.room.session.id;
  const staged = (await (await upload()).json()).attachment;
  expect(
    (await fetch(`${origin}/api/attachments/${staged.id}?sessionId=${sessionId}`)).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${origin}/api/attachments/${staged.id}?sessionId=${sessionId}`, {
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://attacker.example' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${origin}/api/attachments/${staged.id}?sessionId=${randomUUID()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(404);
  expect((await upload(Buffer.from('broken'))).status).toBe(415);
  expect((await upload(tinyPng().subarray(0, 30))).status).toBe(415);
  expect((await upload(tinyPng(), randomUUID(), sessionId, 'image/jpeg')).status).toBe(415);
  expect(
    (
      await upload(
        Buffer.from('ffd8ffe000104a4649460001ffd9', 'hex'),
        randomUUID(),
        sessionId,
        'image/jpeg',
        'fixture.jpg',
      )
    ).status,
  ).toBe(415);
  const tooLarge = await upload(Buffer.alloc(3 * 1024 * 1024 + 1));
  expect(tooLarge.status).toBe(413);
  expect((await tooLarge.json()).error).toBe('Image exceeds the 3 MiB per-image limit');
  expect((await upload(paddedPng(3 * 1024 * 1024))).status).toBe(201);
  expect(
    (
      await upload(tinyPng(), randomUUID(), sessionId, 'image/png', 'fixture.png', {
        Origin: 'https://attacker.example',
      })
    ).status,
  ).toBe(403);
});

it('leaves no accepted upload operation when the request body is interrupted', async () => {
  const operationId = randomUUID();
  const bytes = tinyPng();
  const target = new URL(
    `${origin}/api/attachments?sessionId=${controller.room.session.id}&operationId=${operationId}&filename=interrupted.png`,
  );
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };
    const request = httpRequest(
      target,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'image/png',
          'Content-Length': bytes.length,
        },
      },
      (response) => {
        response.resume();
        response.on('end', finish);
      },
    );
    request.on('error', finish);
    request.on('close', finish);
    request.flushHeaders();
    request.write(bytes.subarray(0, 12), () => setTimeout(() => request.destroy(), 10));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const retry = await upload(
    bytes,
    operationId,
    controller.room.session.id,
    'image/png',
    'interrupted.png',
  );
  expect(retry.status).toBe(201);
  expect((await retry.json()).attachment.filename).toBe('interrupted.png');
});

it('retains attachment drafts and retries the same HTTP operation after a commit interruption', async () => {
  const attachment = (await (await upload()).json()).attachment;
  const sessionId = controller.room.session.id;
  const clientId = randomUUID();
  await post('/api/draft', {
    clientId,
    sessionId,
    version: 1,
    baseRevision: 0,
    text: '',
    attachmentIds: [attachment.id],
  });
  const rejectedEmpty = await command('', randomUUID(), sessionId, {
    attachmentIds: [],
    draft: { clientId, version: 2, baseRevision: 1 },
  });
  expect(rejectedEmpty.status).toBe(400);
  expect(store.load(sessionId)!.composerAttachments).toEqual([attachment]);

  const sessionFile = join(store.directory, sessionId, 'session.json');
  const sessionBackup = join(store.directory, sessionId, 'session.before-interruption.json');
  renameSync(sessionFile, sessionBackup);
  mkdirSync(sessionFile);
  const sendId = randomUUID();
  let failed: Awaited<ReturnType<typeof fetch>>;
  try {
    failed = await command('', sendId, sessionId, {
      attachmentIds: [attachment.id],
      draft: { clientId, version: 2, baseRevision: 1 },
    });
  } finally {
    rmSync(sessionFile, { recursive: true });
    renameSync(sessionBackup, sessionFile);
    for (const name of readdirSync(join(store.directory, sessionId)).filter((value) =>
      value.endsWith('.tmp'),
    ))
      rmSync(join(store.directory, sessionId, name));
  }
  const failure = await failed!.json();
  expect(failure).toMatchObject({
    ok: false,
    sessionId,
    submission: {
      dispatch: { status: 'failed', failure: 'command-error', error: failure.error },
      commitment: { status: 'uncommitted', operationId: sendId },
      recovery: { status: 'skipped', reason: 'ineligible' },
      sessionId,
    },
  });
  expect(controller.room.session.messages).toHaveLength(0);
  expect(controller.room.session).toMatchObject({
    composerDraft: '',
    composerAttachments: [attachment],
    composerDraftRevision: 1,
    composerDraftVersions: { [clientId]: 1 },
  });
  expect(store.load(sessionId)!.composerAttachments).toEqual([attachment]);

  const retried = await command('', sendId, sessionId, {
    attachmentIds: [attachment.id],
    draft: { clientId, version: 2, baseRevision: 1 },
  });
  expect(await retried.json()).toMatchObject({
    ok: true,
    sessionId,
    submission: {
      dispatch: { status: 'sent' },
      commitment: { status: 'committed', operationId: sendId },
      recovery: { status: 'not-needed' },
    },
  });
  expect(controller.room.session.messages).toHaveLength(1);
  expect(controller.room.session.messages[0]).toMatchObject({
    attachments: [attachment],
    attachmentOperation: { id: sendId },
  });
  expect(controller.room.session).toMatchObject({
    composerDraft: '',
    composerAttachments: [],
    composerDraftRevision: 2,
    composerDraftVersions: { [clientId]: 2 },
  });
});

it.each(['the same session', 'another session'])(
  'keeps a committed attachment failure cached when the room moved on before classification, captured under %s',
  async (selected) => {
    const target = controller.room.session.id;
    const attachment = (await (await upload()).json()).attachment;
    const clientId = randomUUID();
    await post('/api/draft', {
      clientId,
      sessionId: target,
      version: 1,
      baseRevision: 0,
      text: 'A',
      attachmentIds: [attachment.id],
    });
    if (selected === 'another session') await command('/new');
    const submit = controller.submit.bind(controller);
    vi.spyOn(controller, 'submit').mockImplementationOnce(async (...args) => {
      await submit(...args);
      await submit('/new');
      throw new Error('lost acknowledgement');
    });
    const sendId = randomUUID();
    const returning = submit(`/sessions ${target}`);
    const sendA = () =>
      command('A', sendId, target, {
        attachmentIds: [attachment.id],
        draft: { clientId, version: 2, baseRevision: 1 },
      });
    const failure = await (await sendA()).json();
    await returning;
    expect(failure).toMatchObject({
      ok: false,
      error: 'lost acknowledgement',
      submission: {
        commitment: { status: 'committed', operationId: sendId },
        recovery: { status: 'skipped', reason: 'conversation-changed' },
      },
    });
    expect(failure.sessionId).not.toBe(target);
    const submitDraft = vi.spyOn(controller, 'submitDraft');
    expect(await (await sendA()).json()).toEqual(failure);
    expect(submitDraft).not.toHaveBeenCalled();
    expect(store.load(target)!.messages).toHaveLength(1);
    expect(store.load(target)!.messages[0]!.attachmentOperation!.id).toBe(sendId);
  },
);

it('keeps a refused retry of committed work cached as committed, and reopens never-committed work', async () => {
  const target = controller.room.session.id;
  const attachment = (await (await upload()).json()).attachment;
  const committedId = randomUUID();
  // Committed outside this server's request cache, as after a host restart.
  const first = await controller.submitDraft({
    source: 'http',
    line: 'A',
    sessionId: target,
    attachmentIds: [attachment.id],
    operationId: committedId,
  });
  expect(first.commitment).toEqual({ status: 'committed', operationId: committedId });
  await command('/new');
  const submitDraft = vi.spyOn(controller, 'submitDraft');
  const dispatches = (id: string) =>
    submitDraft.mock.calls.filter(([input]) => input.source === 'http' && input.operationId === id);
  const retryA = () => command('A', committedId, target, { attachmentIds: [attachment.id] });
  const refused = await (await retryA()).json();
  expect(refused).toMatchObject({
    ok: false,
    error: 'The conversation changed. Your message has not been sent.',
    submission: {
      commitment: { status: 'committed', operationId: committedId },
      recovery: { status: 'skipped', reason: 'ineligible' },
    },
  });
  expect(await (await retryA()).json()).toEqual(refused);
  expect(dispatches(committedId)).toHaveLength(1);

  const freshId = randomUUID();
  const sendB = () => command('B', freshId, target, { attachmentIds: [attachment.id] });
  const undelivered = await (await sendB()).json();
  expect(undelivered).toMatchObject({
    ok: false,
    submission: { commitment: { status: 'uncommitted', operationId: freshId } },
  });
  await command(`/sessions ${target}`);
  expect(await (await retryA()).json()).toEqual(refused);
  expect(dispatches(committedId)).toHaveLength(1);
  const delivered = await (await sendB()).json();
  expect(delivered).toMatchObject({
    ok: true,
    sessionId: target,
    submission: {
      dispatch: { status: 'sent' },
      commitment: { status: 'committed', operationId: freshId },
    },
  });
  expect(dispatches(freshId)).toHaveLength(2);
  expect(controller.room.session.messages.map((m) => m.attachmentOperation?.id)).toEqual([
    committedId,
    freshId,
  ]);
});

it('does not retain a submission whose saved session could not be read, so the identity recovers', async () => {
  const target = controller.room.session.id;
  const attachment = (await (await upload()).json()).attachment;
  const sendId = randomUUID();
  const sendA = () => command('A', sendId, target, { attachmentIds: [attachment.id] });
  await command('/new');
  const submitDraft = vi.spyOn(controller, 'submitDraft');
  const dispatches = () =>
    submitDraft.mock.calls.filter(
      ([input]) => input.source === 'http' && input.operationId === sendId,
    );
  vi.spyOn(store, 'load').mockImplementationOnce(() => {
    throw new Error('EIO: i/o error, read');
  });
  const failed = await sendA();
  expect(failed.status).toBe(400);
  expect((await failed.json()).error).toBe(
    `Could not read the saved conversation to classify attachment operation ${sendId}: EIO: i/o error, read`,
  );
  expect(dispatches()).toHaveLength(1);
  const refused = await (await sendA()).json();
  expect(refused).toMatchObject({
    ok: false,
    error: 'The conversation changed. Your message has not been sent.',
    submission: { commitment: { status: 'uncommitted', operationId: sendId } },
  });
  expect(dispatches()).toHaveLength(2);
  await command(`/sessions ${target}`);
  const delivered = await (await sendA()).json();
  expect(delivered).toMatchObject({
    ok: true,
    sessionId: target,
    submission: {
      dispatch: { status: 'sent' },
      commitment: { status: 'committed', operationId: sendId },
    },
  });
  expect(dispatches()).toHaveLength(3);
  expect(await (await sendA()).json()).toEqual(delivered);
  expect(dispatches()).toHaveLength(3);
  expect(controller.room.session.messages).toHaveLength(1);
});

it('preserves reply routing for captionless images and rejects empty sends', async () => {
  await controller.submit('@human original');
  const attachment = (await (await upload()).json()).attachment;
  expect((await (await command('/reply #m1')).json()).ok).toBe(false);
  expect((await (await command('')).json()).ok).toBe(false);
  const sent = await command('/reply #m1', randomUUID(), controller.room.session.id, {
    attachmentIds: [attachment.id],
  });
  expect((await sent.json()).ok).toBe(true);
  expect(controller.room.session.messages[1]).toMatchObject({
    text: '',
    replyTo: ['m1'],
    recipients: ['human'],
    attachments: [attachment],
  });
});
it('shares commands, activates restored sessions, and rejects stale conversation submissions', async () => {
  const previous = controller.room.session.id;
  await command('@human original');
  await command('/pause');
  expect(controller.room.session.paused).toBe(true);
  await command('/new');
  expect(controller.room.session.id).not.toBe(previous);
  expect((await (await command('@human stale', randomUUID(), previous)).json()).ok).toBe(false);
  expect(controller.room.session.messages).toHaveLength(0);
  await command('/sessions ' + previous);
  expect(controller.room.session.id).toBe(previous);
  expect(controller.room.session.paused).toBe(false);
  expect(controller.room.session.messages).toHaveLength(1);
  await command('@human resumed message');
  expect(controller.room.session.messages.at(-1)?.text).toBe('resumed message');
});
it('preserves newer drafts and ignores saves that arrive after their message was accepted', async () => {
  const clientId = randomUUID(),
    sessionId = controller.room.session.id;
  await post('/api/draft', { clientId, sessionId, version: 1, text: '@human message' });
  await command('@human message', randomUUID(), sessionId, { draft: { clientId, version: 2 } });
  await post('/api/draft', { clientId, sessionId, version: 1, text: 'stale draft' });
  expect(controller.room.session.composerDraft).toBe('');
  await post('/api/draft', { clientId, sessionId, version: 4, text: 'new thought' });
  await command('@human another', randomUUID(), sessionId, { draft: { clientId, version: 3 } });
  expect(controller.room.session.composerDraft).toBe('new thought');
});
it('sends a fresh SSE snapshot on every connection without executing work', async () => {
  await command('@human before reconnect');
  const read = async () => {
    const response = await fetch(origin + '/api/events', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const data = new TextDecoder().decode(value).split('\ndata: ')[1]!.trim();
    return JSON.parse(data);
  };
  expect((await read()).session.messages).toHaveLength(1);
  await command('@human after reconnect');
  expect((await read()).session.messages).toHaveLength(2);
  expect(controller.room.session.messages).toHaveLength(2);
});
it('limits completion to the workspace and exposes no file-serving route', async () => {
  writeFileSync(join(controller.room.config.workspace, 'sample.ts'), 'sample');
  symlinkSync(base, join(controller.room.config.workspace, 'outside'));
  expect(complete(controller.room.config.workspace, [], 'sam', 3).suggestions).toEqual([
    '`sample.ts` ',
  ]);
  const absolute = 'Inspect ' + join(controller.room.config.workspace, 'sam');
  expect(
    complete(controller.room.config.workspace, [], absolute, absolute.length).suggestions,
  ).toEqual(['`sample.ts` ']);
  expect(complete(controller.room.config.workspace, [], '../', 3).suggestions).toEqual([]);
  expect(complete(controller.room.config.workspace, [], 'out', 3).suggestions).toEqual([]);
  expect((await fetch(origin + '/sample.ts')).status).toBe(404);
});
it('rejects malformed and oversized input and continues accepting valid commands', async () => {
  expect((await post('/api/command', { line: 'no identity' })).status).toBe(400);
  expect((await command('🧪'.repeat(17000))).status).toBe(413);
  expect((await (await command('/does-not-exist')).json()).ok).toBe(false);
  expect((await (await command('@human valid')).json()).ok).toBe(true);
  expect(controller.room.session.messages).toHaveLength(1);
});
it('quit stops and saves without waiting for the HTTP command response to close', async () => {
  const result = await (
    await command('/quit', randomUUID(), controller.room.session.id, {
      draft: { clientId: randomUUID(), version: 1 },
    })
  ).json();
  expect(result.ok).toBe(true);
  expect(store.load()!.paused).toBe(true);
  expect(store.load()!.composerDraft).toBe('');
});
it('clears submitted session commands in the old conversation and restores failed drafts', async () => {
  const sessionId = controller.room.session.id,
    clientId = randomUUID();
  await command('/new', randomUUID(), sessionId, { draft: { clientId, version: 1 } });
  expect(store.load(sessionId)!.composerDraft).toBe('');
  const second = controller.room.session.id;
  const switched = await (
    await command(`/sessions ${sessionId}`, randomUUID(), second, {
      draft: { clientId, version: 2 },
    })
  ).json();
  expect(switched).toMatchObject({ ok: true, sessionId });
  expect(switched.submission).toEqual({
    dispatch: { status: 'sent' },
    commitment: { status: 'not-applicable' },
    recovery: { status: 'not-needed' },
    sessionId,
  });
  expect(store.load(second)!.composerDraft).toBe('');
  const failed = await (
    await command('/unknown', randomUUID(), controller.room.session.id, {
      draft: { clientId, version: 3 },
    })
  ).json();
  expect(controller.room.session.composerDraft).toBe('/unknown');
  expect(failed).toEqual({
    ok: false,
    error: expect.stringContaining('Unknown command /unknown'),
    sessionId,
    submission: {
      dispatch: {
        status: 'failed',
        failure: 'command-error',
        error: expect.stringContaining('Unknown command /unknown'),
      },
      commitment: { status: 'not-applicable' },
      recovery: { status: 'restored' },
      sessionId,
    },
  });
  expect(failed.error).toBe(failed.submission.dispatch.error);
});

it('keeps text failures cached and drops only an uncommitted attachment failure', async () => {
  const sessionId = controller.room.session.id;
  const submitDraft = vi.spyOn(controller, 'submitDraft');
  const textId = randomUUID();
  const failure = await (await command('/unknown', textId, sessionId)).json();
  expect(failure.ok).toBe(false);
  expect(failure.submission.recovery).toEqual({ status: 'skipped', reason: 'ineligible' });
  expect(await (await command('/unknown', textId, sessionId)).json()).toEqual(failure);
  expect(submitDraft).toHaveBeenCalledTimes(1);

  const attachment = (await (await upload()).json()).attachment;
  const clientId = randomUUID();
  await post('/api/draft', {
    clientId,
    sessionId,
    version: 1,
    baseRevision: 0,
    text: '',
    attachmentIds: [attachment.id],
  });
  const sendId = randomUUID();
  const stale = await (
    await command('', sendId, sessionId, {
      attachmentIds: [attachment.id],
      draft: { clientId, version: 2, baseRevision: 0 },
    })
  ).json();
  expect(stale.ok).toBe(false);
  expect(stale.submission.commitment).toEqual({ status: 'uncommitted', operationId: sendId });
  expect(stale.submission.recovery).toEqual({ status: 'skipped', reason: 'ineligible' });
  expect(controller.room.session.messages).toHaveLength(0);
  expect(controller.room.session.composerAttachments).toEqual([attachment]);
  const retried = await (
    await command('', sendId, sessionId, {
      attachmentIds: [attachment.id],
      draft: { clientId, version: 2, baseRevision: 1 },
    })
  ).json();
  expect(retried).toMatchObject({ ok: true, sessionId });
  expect(retried.submission).toEqual({
    dispatch: { status: 'sent' },
    commitment: { status: 'committed', operationId: sendId },
    recovery: { status: 'not-needed' },
    sessionId,
  });
  expect(submitDraft).toHaveBeenCalledTimes(3);
  expect(controller.room.session.messages).toHaveLength(1);
});

it('rejects a reused attachment operation ID with changed input before any draft mutation', async () => {
  const sessionId = controller.room.session.id;
  const attachment = (await (await upload()).json()).attachment;
  const operationId = randomUUID();
  expect(
    (
      await (
        await command('first', operationId, sessionId, { attachmentIds: [attachment.id] })
      ).json()
    ).ok,
  ).toBe(true);
  const clientId = randomUUID();
  await post('/api/draft', { clientId, sessionId, version: 1, text: 'unsent' });
  const before = structuredClone(controller.room.session);
  const rejected = await command('second', operationId, sessionId, {
    attachmentIds: [attachment.id],
    draft: { clientId, version: 2, baseRevision: before.composerDraftRevision },
  });
  expect(rejected.status).toBe(409);
  expect(controller.room.session.composerDraft).toBe('unsent');
  expect(controller.room.session.composerDraftRevision).toBe(before.composerDraftRevision);
  expect(controller.room.session.composerDraftVersions).toEqual(before.composerDraftVersions);
  expect(controller.room.session.messages).toHaveLength(1);
  const rejectedText = await command('third', operationId, sessionId, {
    draft: { clientId, version: 2 },
  });
  expect(rejectedText.status).toBe(409);
  expect(controller.room.session.composerDraft).toBe('unsent');
  expect(controller.room.session.composerDraftRevision).toBe(before.composerDraftRevision);
});

it('reports a qualifying attachment recovery guard as restored without claiming commitment', async () => {
  const sessionId = controller.room.session.id;
  const attachment = (await (await upload()).json()).attachment;
  const clientId = randomUUID();
  await post('/api/draft', {
    clientId,
    sessionId,
    version: 3,
    baseRevision: 0,
    text: 'caption',
    attachmentIds: [attachment.id],
  });
  const sendId = randomUUID();
  const result = await (
    await command('caption', sendId, sessionId, {
      attachmentIds: [attachment.id],
      draft: { clientId, version: 3, baseRevision: 1 },
    })
  ).json();
  expect(result.ok).toBe(false);
  expect(result.error).toContain('stale');
  expect(result.submission.commitment).toEqual({ status: 'uncommitted', operationId: sendId });
  expect(result.submission.recovery).toEqual({ status: 'restored' });
  expect(controller.room.session.messages).toHaveLength(0);
  expect(controller.room.session.composerDraft).toBe('caption');
  expect(controller.room.session.composerAttachments).toEqual([attachment]);
  expect(controller.room.session.composerDraftVersions).toEqual({ [clientId]: 3 });
  expect(controller.room.session.composerDraftRevision).toBe(2);
});

it('reports a failed queued restoration while the cached failure keeps the command error', async () => {
  const sessionId = controller.room.session.id,
    clientId = randomUUID();
  await post('/api/draft', { clientId, sessionId, version: 1, text: '/unknown' });
  const submit = controller.submit.bind(controller);
  vi.spyOn(controller, 'submit').mockImplementationOnce((...args) => {
    const dispatched = submit(...args);
    vi.spyOn(controller.room, 'saveDraft').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    return dispatched;
  });
  const id = randomUUID();
  const result = await (
    await command('/unknown', id, sessionId, { draft: { clientId, version: 2 } })
  ).json();
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Unknown command /unknown');
  expect(result.submission.recovery).toEqual({ status: 'failed', error: 'disk full' });
  expect(controller.room.session.composerDraft).toBe('');
  expect(
    await (await command('/unknown', id, sessionId, { draft: { clientId, version: 2 } })).json(),
  ).toEqual(result);
});

it.each(['lost acknowledgement', 'error after commitment'])(
  'retries attachment send A with its identity after host draft B at v+1: %s',
  async (variant) => {
    const sessionId = controller.room.session.id;
    const clientId = randomUUID();
    const first = (await (await upload()).json()).attachment;
    const second = (await (await upload(alternatePng())).json()).attachment;
    await post('/api/draft', {
      clientId,
      sessionId,
      version: 1,
      baseRevision: 0,
      text: 'A',
      attachmentIds: [first.id],
    });
    const sendId = randomUUID();
    const sendA = () =>
      command('A', sendId, sessionId, {
        attachmentIds: [first.id],
        draft: { clientId, version: 2, baseRevision: 1 },
      });
    const acceptB = async () => {
      const accepted = await (
        await post('/api/draft', {
          clientId,
          sessionId,
          version: 3,
          baseRevision: controller.room.session.composerDraftRevision,
          text: 'B',
          attachmentIds: [second.id],
        })
      ).json();
      expect(accepted).toMatchObject({ ok: true, accepted: true });
    };
    if (variant === 'error after commitment') {
      const submit = controller.submit.bind(controller);
      vi.spyOn(controller, 'submit').mockImplementationOnce(async (...args) => {
        await submit(...args);
        await acceptB();
        throw new Error('lost acknowledgement');
      });
    }
    const original = await (await sendA()).json();
    if (variant === 'lost acknowledgement') await acceptB();
    const submitDraft = vi.spyOn(controller, 'submitDraft');
    const retried = await (await sendA()).json();
    expect(retried).toEqual(original);
    expect(submitDraft).not.toHaveBeenCalled();
    expect(retried.ok).toBe(variant === 'lost acknowledgement');
    expect(retried.submission.commitment).toEqual({ status: 'committed', operationId: sendId });
    expect(retried.submission.recovery).toEqual(
      variant === 'lost acknowledgement'
        ? { status: 'not-needed' }
        : { status: 'skipped', reason: 'newer-draft' },
    );
    expect(controller.room.session.messages).toHaveLength(1);
    expect(controller.room.session.messages[0]).toMatchObject({
      text: 'A',
      attachments: [first],
      attachmentOperation: { id: sendId },
    });
    expect(controller.room.session.composerDraft).toBe('B');
    expect(controller.room.session.composerAttachments).toEqual([second]);
    expect(controller.room.session.composerDraftVersions).toEqual({ [clientId]: 3 });
    expect(store.load(sessionId)).toMatchObject({
      composerDraft: 'B',
      composerAttachments: [second],
      composerDraftVersions: { [clientId]: 3 },
    });
  },
);

it('rejects terminal attachment commands and completion, including forged authority, before path access', async () => {
  const input = await import('../src/ui/attachment-input.js');
  const path = join(base, 'outside-secret.png');
  writeFileSync(path, tinyPng());
  const before = controller.room.session.composerAttachments ?? [];
  for (const extra of [{}, { origin: 'terminal' }, { terminal: true }]) {
    const result = await command(
      '/attach ' + path,
      randomUUID(),
      controller.room.session.id,
      extra,
    );
    expect([200, 400]).toContain(result.status);
    const rejected = await result.json();
    expect(rejected.ok).not.toBe(true);
    expect(JSON.stringify(rejected)).not.toContain(path);
    const completed = await post('/api/complete', {
      sessionId: controller.room.session.id,
      value: '/attach ' + path,
      cursor: ('/attach ' + path).length,
      ...extra,
    });
    expect(completed.status).toBe(400);
    expect(await completed.text()).not.toContain(path);
  }
  expect(input.readAttachmentPath).not.toHaveBeenCalled();
  expect(input.completeAttachmentAction).not.toHaveBeenCalled();
  expect(controller.room.session.composerAttachments ?? []).toEqual(before);
  expect(complete(controller.room.config.workspace, [], '/att', 4).suggestions).toEqual([]);
  await command('/help');
  expect(controller.room.session.notices.at(-1)?.text).not.toContain('/attach');
  expect((await upload()).status).toBe(201);
});
