import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  AttachmentError,
  attachmentLimits,
  grokInitialContent,
  validateAttachmentSet,
  validateImage,
} from '../src/attachments.js';
import { SessionStore } from '../src/store.js';
import { newSession, Room } from '../src/room.js';
import { RoomController } from '../src/controller.js';
import type { AgentAdapter, RoomConfig, TurnInput, TurnResult } from '../src/types.js';
import { alternatePng, dimensionPng, paddedPng, tinyPng } from './image-fixture.js';

let root: string;
let workspace: string;
let store: SessionStore;
const config = (): RoomConfig => ({
  workspace,
  permissions: { edits: false, commands: false, network: false },
  followUpTurns: 8,
  sources: [],
  provenance: {},
  agents: {},
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-attachments-')));
  workspace = join(root, 'workspace');
  mkdirSync(workspace);
  store = new SessionStore(workspace, join(root, 'state'));
  store.acquire();
});

afterEach(() => {
  store.release();
  rmSync(root, { recursive: true, force: true });
});

function stage(sessionId: string, bytes = tinyPng(), operationId = randomUUID()) {
  return store.stageAttachment({
    sessionId,
    operationId,
    filename: '../display.png',
    mediaType: 'image/png',
    bytes,
  });
}

describe('attachment storage', () => {
  it('validates actual image content, media type, dimensions, and limits', () => {
    expect(validateImage(tinyPng(), 'image/png')).toEqual({
      mediaType: 'image/png',
      width: 1,
      height: 1,
    });
    expect(() => validateImage(tinyPng(), 'image/jpeg')).toThrow('does not match');
    expect(() =>
      validateImage(Buffer.from('ffd8ffe000104a4649460001ffd9', 'hex'), 'image/jpeg'),
    ).toThrow('Only complete PNG');
    expect(() => validateImage(tinyPng().subarray(0, 30), 'image/png')).toThrow('complete');
    expect(() => validateImage(Buffer.from('not an image'), 'image/png')).toThrow('complete PNG');
    expect(() =>
      validateImage(Buffer.alloc(attachmentLimits.perImageBytes + 1), 'image/png'),
    ).toThrow('1 MiB');
    expect(() =>
      validateImage(dimensionPng(attachmentLimits.maximumDimension + 1, 1), 'image/png'),
    ).toThrow('dimensions');
    expect(() =>
      validateAttachmentSet(
        Array.from({ length: 4 }, (_, index) => ({
          id: `att-${String(index).padStart(32, '0')}`,
          filename: `${index}.png`,
          mediaType: 'image/png' as const,
          byteSize: 800 * 1024,
          width: 1,
          height: 1,
        })),
      ),
    ).toThrow('3 MiB');
  });

  it('deduplicates upload operations and content while rejecting changed operation input', () => {
    const session = newSession(config());
    store.save(session);
    const operationId = randomUUID();
    const first = stage(session.id, tinyPng(), operationId);
    expect(first.filename).toBe('display.png');
    expect(stage(session.id, tinyPng(), operationId)).toEqual(first);
    expect(() => stage(session.id, alternatePng(), operationId)).toThrow(AttachmentError);
    const second = stage(session.id, tinyPng());
    expect(second.id).not.toBe(first.id);
    const blobs = readdirSync(join(store.directory, session.id, 'attachments', 'blobs')).filter(
      (name) => name.endsWith('.bin'),
    );
    expect(blobs).toHaveLength(1);
    expect(store.attachmentAccess(session.id).resolve(first.id).bytes).toEqual(tinyPng());
  });

  it('keeps live draft/message references and expires abandoned staging and interrupted writes', () => {
    const session = newSession(config());
    store.save(session);
    const liveDraft = stage(session.id);
    const liveMessage = stage(session.id);
    const abandoned = stage(session.id);
    session.composerAttachments = [liveDraft];
    session.messages.push({
      id: 'm1',
      sequence: 1,
      author: 'human',
      recipients: [],
      text: '',
      createdAt: new Date().toISOString(),
      replyTo: [],
      roots: ['m1'],
      deliveries: {},
      attachments: [liveMessage],
    });
    session.exchanges.m1 = { used: 0, allowance: 8 };
    store.save(session);
    const blobFolder = join(store.directory, session.id, 'attachments', 'blobs');
    const temporary = join(blobFolder, 'interrupted.tmp');
    const indexTemporary = join(
      store.directory,
      session.id,
      'attachments',
      'index.json.interrupted.tmp',
    );
    writeFileSync(temporary, 'partial');
    writeFileSync(indexTemporary, 'partial');
    const old = new Date(Date.now() - attachmentLimits.abandonedMilliseconds - 1000);
    utimesSync(temporary, old, old);
    utimesSync(indexTemporary, old, old);
    const result = store.cleanupAttachments(
      Date.now() + attachmentLimits.abandonedMilliseconds + 1,
    );
    expect(result.attachments).toBe(1);
    expect(result.temporary).toBe(2);
    expect(() => store.attachmentAccess(session.id).resolve(abandoned.id)).toThrow('not found');
    expect(store.attachmentAccess(session.id).resolve(liveDraft.id).bytes).toEqual(tinyPng());
    expect(store.attachmentAccess(session.id).resolve(liveMessage.id).bytes).toEqual(tinyPng());
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(indexTemporary)).toBe(false);

    session.composerAttachments = [];
    store.save(session);
    store.cleanupAttachments(Date.now() + 2 * attachmentLimits.abandonedMilliseconds + 2);
    expect(() => store.attachmentAccess(session.id).resolve(liveDraft.id)).toThrow('not found');
    expect(store.attachmentAccess(session.id).resolve(liveMessage.id).bytes).toEqual(tinyPng());
  });

  it('reports missing or corrupt bytes and never resolves across sessions', () => {
    const first = newSession(config());
    const second = newSession(config());
    store.save(first);
    store.save(second);
    const attachment = stage(first.id);
    expect(() => store.attachmentAccess(second.id).resolve(attachment.id)).toThrow('not found');
    const index = JSON.parse(
      readFileSync(join(store.directory, first.id, 'attachments', 'index.json'), 'utf8'),
    );
    const sha = index.attachments[attachment.id].sha256;
    writeFileSync(join(store.directory, first.id, 'attachments', 'blobs', `${sha}.bin`), 'broken');
    expect(() => store.attachmentAccess(first.id).resolve(attachment.id)).toThrow('integrity');
  });

  it('recovers committed references before expiring a stale ownership index on restart', () => {
    const session = newSession(config());
    store.save(session);
    const attachment = stage(session.id);
    session.messages.push({
      id: 'm1',
      sequence: 1,
      author: 'human',
      recipients: [],
      text: '',
      createdAt: new Date().toISOString(),
      replyTo: [],
      roots: ['m1'],
      deliveries: {},
      attachments: [attachment],
    });
    session.exchanges.m1 = { used: 0, allowance: 8 };
    store.save(session);
    const indexPath = join(store.directory, session.id, 'attachments', 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.attachments[attachment.id].orphanedAt = new Date(
      Date.now() - 2 * attachmentLimits.abandonedMilliseconds,
    ).toISOString();
    writeFileSync(indexPath, JSON.stringify(index));

    store.release();
    store = new SessionStore(workspace, join(root, 'state'));
    store.acquire();
    expect(store.attachmentAccess(session.id).resolve(attachment.id).bytes).toEqual(tinyPng());
    expect(
      JSON.parse(readFileSync(indexPath, 'utf8')).attachments[attachment.id].orphanedAt,
    ).toBeUndefined();
  });

  it('maps several required-message images in order within the native frame bound', () => {
    const bytes = [paddedPng(900 * 1024), paddedPng(900 * 1024), paddedPng(900 * 1024)];
    const metadata = bytes.map((value, index) => ({
      id: `att-${String(index).padStart(32, '0')}`,
      filename: `${index}.png`,
      mediaType: 'image/png' as const,
      byteSize: value.length,
      width: 1,
      height: 1,
    }));
    const messages = [
      {
        id: 'm1',
        sequence: 1,
        author: 'human',
        recipients: ['viewer'],
        text: 'first',
        createdAt: new Date().toISOString(),
        replyTo: [],
        roots: ['m1'],
        deliveries: {},
        attachments: metadata.slice(0, 2),
      },
      {
        id: 'm2',
        sequence: 2,
        author: 'human',
        recipients: ['viewer'],
        text: 'second',
        createdAt: new Date().toISOString(),
        replyTo: [],
        roots: ['m2'],
        deliveries: {},
        attachments: metadata.slice(2),
      },
    ];
    const content = grokInitialContent(messages, {
      settings: { directory: root, sessionId: randomUUID() },
      resolve: (id) => {
        const index = metadata.findIndex((value) => value.id === id);
        return { metadata: metadata[index]!, sha256: '0'.repeat(64), bytes: bytes[index]! };
      },
    });
    expect(
      content.filter((part: any) => part.type === 'text').map((part: any) => part.text),
    ).toEqual([
      `Chittr image for message #m1, attachment ${metadata[0]!.id}.`,
      `Chittr image for message #m1, attachment ${metadata[1]!.id}.`,
      `Chittr image for message #m2, attachment ${metadata[2]!.id}.`,
    ]);
    expect(content.filter((part: any) => part.type === 'image')).toHaveLength(3);
    expect(JSON.stringify(content).length).toBeLessThan(
      attachmentLimits.nativeFrameCharacters - 256 * 1024,
    );
  });
});

class NativeFake implements AgentAdapter {
  imageSupport() {
    return {
      provider: 'grok' as const,
      initial: { available: true as const, status: 'available' as const },
      retrieval: {
        available: false as const,
        status: 'unsupported' as const,
        reason: 'Fake has no retrieval',
      },
    };
  }
  inputs: TurnInput[] = [];
  async start() {
    return { sessionId: 'native', restored: false };
  }
  async run(input: TurnInput): Promise<TurnResult> {
    this.inputs.push(input);
    return {
      outcomes: input.messages.map((message) => ({
        messageIds: [message.id],
        recipients: [],
        kind: 'pass',
        text: 'done',
      })),
    };
  }
  async interrupt() {}
  async close() {}
}

it('splits queued image messages so each valid attachment set reaches the adapter', async () => {
  const cfg = config();
  cfg.agents.viewer = {
    id: 'viewer',
    provider: 'grok',
    enabled: true,
    instructions: '',
    fingerprint: 'viewer',
  };
  const adapter = new NativeFake();
  const room = new Room(cfg, store, undefined, () => adapter);
  await room.start();
  const groups = [0, 1].map(() =>
    Array.from({ length: 3 }, () => stage(room.session.id, paddedPng(900 * 1024))),
  );
  room.send('@viewer first', undefined, {
    attachmentIds: groups[0]!.map((item) => item.id),
    operationId: randomUUID(),
  });
  room.send('@viewer second', undefined, {
    attachmentIds: groups[1]!.map((item) => item.id),
    operationId: randomUUID(),
  });
  const deadline = Date.now() + 2000;
  while (adapter.inputs.length < 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(adapter.inputs.map((input) => input.messages.map((message) => message.id))).toEqual([
    ['m1'],
    ['m2'],
  ]);
  await room.close();
});

it('persists attachment drafts and send identity across conflicts and restart', async () => {
  const cfg = config();
  cfg.agents.viewer = {
    id: 'viewer',
    provider: 'grok',
    enabled: true,
    instructions: '',
    fingerprint: 'viewer',
  };
  const adapters: NativeFake[] = [];
  const makeRoom = (session?: ReturnType<SessionStore['load']>) =>
    new Room(cfg, store, session, () => {
      const adapter = new NativeFake();
      adapters.push(adapter);
      return adapter;
    });
  let controller!: RoomController;
  controller = new RoomController(cfg, store, undefined, {
    help: '',
    quit: async () => controller.close(),
    createRoom: (_config, _store, session) => makeRoom(session),
  });
  await controller.room.start();
  const sessionId = controller.room.session.id;
  const first = stage(sessionId);
  const second = stage(sessionId, alternatePng());
  const clientId = randomUUID();
  expect(
    await controller.updateDraft(
      { text: '', attachmentIds: [first.id], baseRevision: 0, clientId, version: 1 },
      sessionId,
    ),
  ).toEqual({ revision: 1, accepted: true });
  await expect(
    controller.updateDraft(
      { text: '', attachmentIds: [second.id], baseRevision: 0, clientId: randomUUID(), version: 1 },
      sessionId,
    ),
  ).rejects.toThrow('Draft changed');
  expect(controller.room.session.composerAttachments).toEqual([first]);

  const failedSendId = randomUUID();
  const sessionFile = join(store.directory, sessionId, 'session.json');
  const sessionBackup = join(store.directory, sessionId, 'session.before-interruption.json');
  renameSync(sessionFile, sessionBackup);
  mkdirSync(sessionFile);
  let commitFailure: unknown;
  try {
    await controller.submit('@viewer', sessionId, {
      attachmentIds: [first.id],
      operationId: failedSendId,
      draft: { clientId, version: 2, baseRevision: 1 },
    });
  } catch (error) {
    commitFailure = error;
  } finally {
    rmSync(sessionFile, { recursive: true });
    renameSync(sessionBackup, sessionFile);
  }
  expect(String(commitFailure)).toMatch(/EISDIR|ENOTEMPTY|directory/);
  for (const name of readdirSync(join(store.directory, sessionId)).filter((value) =>
    value.endsWith('.tmp'),
  ))
    rmSync(join(store.directory, sessionId, name));
  expect(controller.room.session.messages).toHaveLength(0);
  expect(controller.room.session.composerAttachments).toEqual([first]);
  expect(store.load(sessionId)!.composerAttachments).toEqual([first]);

  expect(
    await controller.updateDraft(
      {
        text: '',
        attachmentIds: [first.id, second.id],
        baseRevision: 1,
        clientId,
        version: 2,
      },
      sessionId,
    ),
  ).toEqual({ revision: 2, accepted: true });
  await expect(
    controller.updateDraft(
      {
        text: '',
        attachmentIds: [first.id, second.id],
        baseRevision: 2,
        clientId,
        version: 2.5,
      },
      sessionId,
    ),
  ).rejects.toThrow('Invalid draft operation identity');
  const acceptedVersions = controller.room.session.composerDraftVersions;
  controller.room.session.composerDraftVersions = Object.fromEntries(
    Array.from({ length: 1000 }, () => [randomUUID(), 0]),
  );
  await expect(
    controller.submit('@viewer', sessionId, {
      attachmentIds: [first.id, second.id],
      operationId: randomUUID(),
      draft: { clientId: randomUUID(), version: 1, baseRevision: 2 },
    }),
  ).rejects.toThrow('Too many draft writers');
  controller.room.session.composerDraftVersions = acceptedVersions;
  const sendId = randomUUID();
  await controller.submit('@viewer', sessionId, {
    attachmentIds: [first.id, second.id],
    operationId: sendId,
    draft: { clientId, version: 3, baseRevision: 2 },
  });
  expect(controller.room.session.messages[0]).toMatchObject({
    text: '',
    recipients: ['viewer'],
    attachments: [first, second],
    attachmentOperation: { id: sendId },
  });
  expect(controller.room.session.composerAttachments).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(adapters[0]!.inputs[0]!.messages[0]!.attachments).toEqual([first, second]);
  await controller.close();

  const attachmentIndex = JSON.parse(
    readFileSync(join(store.directory, sessionId, 'attachments', 'index.json'), 'utf8'),
  );
  unlinkSync(
    join(
      store.directory,
      sessionId,
      'attachments',
      'blobs',
      `${attachmentIndex.attachments[first.id].sha256}.bin`,
    ),
  );

  let restored!: RoomController;
  restored = new RoomController(cfg, store, store.load(sessionId), {
    help: '',
    quit: async () => restored.close(),
    createRoom: (_config, _store, session) => makeRoom(session),
  });
  await restored.submit('@viewer', sessionId, {
    attachmentIds: [first.id, second.id],
    operationId: sendId,
  });
  expect(restored.room.session.messages).toHaveLength(1);
  await expect(
    restored.submit('@viewer', sessionId, { attachmentIds: [], operationId: sendId }),
  ).rejects.toThrow('different input');
  await expect(
    restored.submit('@viewer changed', sessionId, {
      attachmentIds: [first.id, second.id],
      operationId: sendId,
    }),
  ).rejects.toThrow('different input');
  await expect(restored.submit('/pause', sessionId, { operationId: sendId })).rejects.toThrow(
    'different input',
  );
  expect(restored.room.session.paused).toBe(false);
  expect(store.list()[0]!.preview).toBe('[Image: display.png]');
  await restored.close();
});

it('preserves ordered attachment drafts and messages while their session is inactive', async () => {
  const cfg = config();
  let controller!: RoomController;
  controller = new RoomController(cfg, store, undefined, {
    help: '',
    quit: async () => controller.close(),
    createRoom: (roomConfig, persistence, session) => new Room(roomConfig, persistence, session),
  });
  await controller.room.start();
  const originalSessionId = controller.room.session.id;
  const first = stage(originalSessionId);
  const second = stage(originalSessionId, alternatePng());
  const clientId = randomUUID();
  await controller.updateDraft(
    {
      text: '',
      attachmentIds: [first.id, second.id],
      baseRevision: 0,
      clientId,
      version: 1,
    },
    originalSessionId,
  );

  await controller.submit('/new');
  expect(controller.room.session.id).not.toBe(originalSessionId);
  store.cleanupAttachments(Date.now() + 2 * attachmentLimits.abandonedMilliseconds);
  expect(store.attachmentAccess(originalSessionId).resolve(first.id).bytes).toEqual(tinyPng());
  await controller.submit(`/sessions ${originalSessionId}`);
  expect(controller.room.session.composerAttachments).toEqual([first, second]);

  const sendId = randomUUID();
  await controller.submit('', originalSessionId, {
    attachmentIds: [first.id, second.id],
    operationId: sendId,
    draft: { clientId, version: 2, baseRevision: 1 },
  });
  expect(controller.room.session.messages[0]).toMatchObject({
    id: 'm1',
    attachments: [first, second],
    attachmentOperation: { id: sendId },
  });
  await controller.submit('/new');
  store.cleanupAttachments(Date.now() + 3 * attachmentLimits.abandonedMilliseconds);
  await controller.submit(`/sessions ${originalSessionId}`);
  expect(controller.room.session.messages[0]).toMatchObject({
    id: 'm1',
    attachments: [first, second],
  });
  expect(store.attachmentAccess(originalSessionId).resolve(second.id).bytes).toEqual(
    alternatePng(),
  );
  await controller.close();
});
