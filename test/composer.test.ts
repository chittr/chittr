import { describe, expect, it } from 'vitest';
import {
  ComposerController,
  type ComposerEvent,
  type ComposerTransport,
  type DraftUpdate,
} from '../web/composer.js';
import type { AttachmentMetadata } from '../src/types.js';
import type {
  CommandResult,
  DraftSubmissionCommitment,
  DraftSubmissionRecovery,
  WebCommand,
  WebState,
} from '../src/web-types.js';

const metadata = (name: string): AttachmentMetadata => ({
  id: name,
  filename: name,
  width: 1,
  height: 1,
  byteSize: 1,
  mediaType: 'image/png',
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function snapshot(
  overrides: {
    instanceId?: string;
    revision?: number;
    sessionId?: string;
    composerDraft?: string;
    composerDraftRevision?: number;
    composerAttachments?: AttachmentMetadata[];
  } = {},
): WebState {
  return {
    instanceId: overrides.instanceId ?? 'i1',
    revision: overrides.revision ?? 1,
    session: {
      id: overrides.sessionId ?? 's1',
      composerDraft: overrides.composerDraft ?? '',
      composerDraftRevision: overrides.composerDraftRevision ?? 0,
      composerAttachments: overrides.composerAttachments ?? [],
      messages: [],
    },
  } as unknown as WebState;
}
const sent = (
  sessionId = 's1',
  commitment: DraftSubmissionCommitment = { status: 'not-applicable' },
): CommandResult => ({
  ok: true,
  sessionId,
  submission: {
    dispatch: { status: 'sent' },
    commitment,
    recovery: { status: 'not-needed' },
    sessionId,
  },
});
const failed = (
  error: string,
  recovery: DraftSubmissionRecovery,
  commitment: DraftSubmissionCommitment = { status: 'not-applicable' },
  sessionId = 's1',
): CommandResult => ({
  ok: false,
  error,
  sessionId,
  submission: {
    dispatch: { status: 'failed', failure: 'command-error', error },
    commitment,
    recovery,
    sessionId,
  },
});

function fixture(initial: Record<string, string> = {}) {
  const storage = new Map(Object.entries(initial));
  const requests: WebCommand[] = [];
  const responses: Array<(request: WebCommand) => Promise<CommandResult>> = [];
  const states: Array<() => Promise<WebState>> = [];
  const saves: Array<{ update: DraftUpdate; keepalive: boolean }> = [];
  const uploads = new Map<string, ReturnType<typeof deferred<AttachmentMetadata>>>();
  let stateCalls = 0;
  let version = 0;
  let hostRevision = 0;
  const transport: ComposerTransport = {
    command: (request) => {
      requests.push(structuredClone(request));
      const respond = responses.shift();
      if (!respond) throw new Error('No scripted command response');
      return respond(request);
    },
    state: () => {
      stateCalls++;
      const next = states.shift();
      if (!next) throw new Error('No scripted state response');
      return next();
    },
    saveDraft: async (update, keepalive = false) => {
      saves.push({ update, keepalive });
      return { accepted: true, revision: ++hostRevision };
    },
    upload: (file) => {
      const pending = deferred<AttachmentMetadata>();
      uploads.set(file.name, pending);
      return pending.promise;
    },
    // Browser decoding is Playwright's concern; here every file is already the PNG to send.
    prepareImage: async (file) => ({ file, converted: false }),
    draftVersion: () => ({ clientId: 'tab', version: ++version }),
  };
  const composer = new ComposerController(transport, {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => void storage.set(key, value),
    removeItem: (key) => void storage.delete(key),
  });
  const events: ComposerEvent[] = [];
  composer.subscribe((event) => events.push(event));
  return {
    composer,
    storage,
    requests,
    responses,
    states,
    saves,
    uploads,
    events,
    stateCalls: () => stateCalls,
    lose: (message = 'Failed to fetch') => {
      responses.push(() => Promise.reject(new Error(message)));
    },
    respond: (result: CommandResult, next?: WebState) => {
      responses.push(() => Promise.resolve(result));
      if (next) states.push(() => Promise.resolve(next));
    },
  };
}

describe('browser composer submission and acknowledgement', () => {
  it('submits a reply draft with one identity and clears matching local text on acknowledged success', async () => {
    const f = fixture();
    f.composer.accept(snapshot());
    expect(f.composer.edit('Hello', { replyTo: 'm1' })).toBe(true);
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('/reply #m1 Hello');
    // The host accepted another client's text meanwhile; a text send clears, it does not adopt.
    f.respond(sent(), snapshot({ revision: 2, composerDraft: 'Other client text' }));
    const run = f.composer.submit(true);
    expect(run).toBeDefined();
    await flush();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      sessionId: 's1',
      line: '/reply #m1 Hello',
      draft: { clientId: 'tab', version: 1, baseRevision: 0 },
    });
    await run;
    expect(f.composer.text).toBe('');
    expect(f.composer.replyTo).toBeUndefined();
    expect(f.composer.pending).toBeUndefined();
    expect(f.composer.busy).toBe(false);
    expect(f.composer.error).toBe('');
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('');
    expect(f.storage.has('chittr:i1:s1:pending')).toBe(false);
    expect(f.events.map((e) => e.type)).toContain('text-replaced');
  });

  it.each<[string, DraftSubmissionRecovery]>([
    ['restored', { status: 'restored' }],
    ['skipped for a newer draft', { status: 'skipped', reason: 'newer-draft' }],
    ['skipped for a changed conversation', { status: 'skipped', reason: 'conversation-changed' }],
    ['skipped as ineligible', { status: 'skipped', reason: 'ineligible' }],
    ['failed', { status: 'failed', error: 'disk full' }],
  ])(
    'a definitive failure keeps the text and original error and clears pending when recovery %s',
    async (_name, recovery) => {
      const f = fixture();
      f.composer.accept(snapshot());
      f.composer.edit('Keep me');
      f.respond(failed('Unknown recipient', recovery));
      await f.composer.submit(true);
      expect(f.composer.error).toBe('Unknown recipient');
      expect(f.composer.text).toBe('Keep me');
      expect(f.composer.pending).toBeUndefined();
      expect(f.storage.get('chittr:i1:s1:draft')).toBe('Keep me');
      expect(f.storage.has('chittr:i1:s1:pending')).toBe(false);
      expect(f.stateCalls()).toBe(0);
      // The independent facts stay readable, apart from the presented command error.
      expect(f.composer.outcome).toEqual({
        request: f.requests[0],
        roomKey: 'chittr:i1:s1',
        submission: {
          dispatch: { status: 'failed', failure: 'command-error', error: 'Unknown recipient' },
          commitment: { status: 'not-applicable' },
          recovery,
          sessionId: 's1',
        },
      });
      // The next submission is a new operation with a new draft version.
      f.respond(sent(), snapshot({ revision: 2 }));
      await f.composer.submit(true);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]!.id).not.toBe(f.requests[0]!.id);
      expect(f.requests[1]!.draft).toEqual({ clientId: 'tab', version: 2, baseRevision: 0 });
    },
  );

  it('keeps the error for a cached dispatch failure after committed attachment work while host B stays accepted', async () => {
    const f = fixture();
    const sentImage = metadata('a.png');
    f.composer.accept(snapshot({ composerAttachments: [sentImage], composerDraftRevision: 3 }));
    f.composer.edit('Caption A');
    f.lose();
    await f.composer.submit(true);
    const request = f.requests[0]!;
    expect(request).toEqual({
      id: expect.any(String),
      sessionId: 's1',
      line: 'Caption A',
      attachmentIds: ['a.png'],
      draft: { clientId: 'tab', version: 1, baseRevision: 3 },
    });
    expect(f.composer.pending).toEqual(request);
    expect(f.composer.error).toBe('Failed to fetch');
    expect(f.composer.outcome).toBeUndefined();
    expect(JSON.parse(f.storage.get('chittr:s1:image-send')!)).toEqual(request);
    expect(JSON.parse(f.storage.get('chittr:i1:s1:pending')!)).toEqual(request);
    // A committed on the host and cleared the draft; another client then had B accepted,
    // and the event stream delivers it while A is still unresolved.
    const newer = metadata('newer.png');
    const hostB = snapshot({
      revision: 2,
      composerDraft: 'Newer accepted caption',
      composerDraftRevision: 5,
      composerAttachments: [newer],
    });
    expect(f.composer.accept(hostB)).toBe('updated');
    expect(f.composer.images.attachments).toEqual([newer]);
    expect(f.composer.text).toBe('Caption A');
    expect(f.composer.pending).toEqual(request);
    // The same identity is refused by the host with A's work already committed.
    f.respond(
      failed(
        'Attachments changed',
        { status: 'skipped', reason: 'ineligible' },
        {
          status: 'committed',
          operationId: request.id,
        },
      ),
    );
    await f.composer.retryPending();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]).toEqual(request);
    expect(f.composer.error).toBe('Attachments changed');
    expect(f.composer.outcome).toEqual({
      request,
      roomKey: 'chittr:i1:s1',
      submission: {
        dispatch: { status: 'failed', failure: 'command-error', error: 'Attachments changed' },
        commitment: { status: 'committed', operationId: request.id },
        recovery: { status: 'skipped', reason: 'ineligible' },
        sessionId: 's1',
      },
    });
    expect(f.composer.pending).toBeUndefined();
    expect(f.storage.has('chittr:s1:image-send')).toBe(false);
    expect(f.storage.has('chittr:i1:s1:pending')).toBe(false);
    expect(f.stateCalls()).toBe(0);
    // B's accepted references and the local text are untouched by the failed retry.
    expect(f.composer.images.attachments).toEqual([newer]);
    expect(f.composer.text).toBe('Caption A');
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('Caption A');
    // Sending now is a new operation against B's references, never A's identity.
    f.composer.edit('Caption B');
    f.respond(sent('s1', { status: 'committed', operationId: 'later' }), snapshot({ revision: 3 }));
    await f.composer.submit(true);
    expect(f.requests[2]).toEqual({
      id: expect.any(String),
      sessionId: 's1',
      line: 'Caption B',
      attachmentIds: ['newer.png'],
      draft: { clientId: 'tab', version: 2, baseRevision: 5 },
    });
    expect(f.requests[2]!.id).not.toBe(request.id);
  });

  it('keeps locally newer text through a committed failure of an unresolved send', async () => {
    const f = fixture();
    f.composer.accept(snapshot({ composerAttachments: [metadata('a.png')] }));
    f.composer.edit('Caption A');
    f.lose();
    await f.composer.submit(true);
    const request = f.requests[0]!;
    f.composer.edit('Local B');
    f.respond(
      failed(
        'Attachments changed',
        { status: 'skipped', reason: 'newer-draft' },
        {
          status: 'committed',
          operationId: request.id,
        },
      ),
    );
    await f.composer.retryPending();
    expect(f.requests[1]).toEqual(request);
    expect(f.composer.text).toBe('Local B');
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('Local B');
    expect(f.composer.pending).toBeUndefined();
    expect(f.composer.outcome?.submission.recovery).toEqual({
      status: 'skipped',
      reason: 'newer-draft',
    });
  });

  it('retains the pending request after a lost response and resends it unchanged on explicit retry', async () => {
    const f = fixture();
    f.composer.accept(snapshot());
    f.composer.edit('Sent once');
    const response = deferred<CommandResult>();
    f.responses.push(() => response.promise);
    const run = f.composer.submit(true)!;
    await flush();
    expect(f.composer.busy).toBe(true);
    expect(f.composer.pending?.line).toBe('Sent once');
    response.reject(new Error('Failed to fetch'));
    await run;
    expect(f.composer.busy).toBe(false);
    expect(f.composer.error).toBe('Failed to fetch');
    expect(f.composer.pending).toEqual(f.requests[0]);
    expect(f.composer.outcome).toBeUndefined();
    expect(JSON.parse(f.storage.get('chittr:i1:s1:pending')!)).toEqual(f.requests[0]);
    expect(f.composer.text).toBe('Sent once');
    expect(f.composer.submit(true)).toBeUndefined();
    expect(f.composer.command('/pause', true)).toBeUndefined();
    f.respond(sent(), snapshot({ revision: 2 }));
    await f.composer.retryPending();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]).toEqual(f.requests[0]);
    expect(f.composer.pending).toBeUndefined();
    expect(f.composer.text).toBe('');
    expect(f.composer.error).toBe('');
    expect(f.composer.outcome).toEqual({
      request: f.requests[0],
      roomKey: 'chittr:i1:s1',
      submission: {
        dispatch: { status: 'sent' },
        commitment: { status: 'not-applicable' },
        recovery: { status: 'not-needed' },
        sessionId: 's1',
      },
    });
  });

  it('retains the pending request when the state refresh after a successful command fails', async () => {
    const f = fixture();
    f.composer.accept(snapshot());
    f.composer.edit('Refresh me');
    f.responses.push(() => Promise.resolve(sent()));
    f.states.push(() => Promise.reject(new Error('Request failed (503)')));
    await f.composer.submit(true);
    expect(f.composer.error).toBe('Request failed (503)');
    expect(f.composer.pending).toEqual(f.requests[0]);
    expect(f.composer.text).toBe('Refresh me');
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('Refresh me');
    f.respond(sent(), snapshot({ revision: 2 }));
    await f.composer.retryPending();
    expect(f.requests[1]).toEqual(f.requests[0]);
    expect(f.composer.pending).toBeUndefined();
    expect(f.composer.text).toBe('');
  });

  it('runs generic commands serially, returns their errors including transport errors, and never clears text', async () => {
    const f = fixture();
    expect(f.composer.command('/pause', true)).toBeUndefined();
    f.composer.accept(snapshot());
    f.composer.edit('Keep typing');
    expect(f.composer.command('/pause', false)).toBeUndefined();
    f.respond(sent(), snapshot({ revision: 2, composerDraft: 'host text' }));
    const first = f.composer.command('/pause', true)!;
    expect(f.composer.command('/stop', true)).toBeUndefined();
    await expect(first).resolves.toBeUndefined();
    expect(f.requests.map((r) => r.line)).toEqual(['/pause']);
    expect(f.requests[0]!.draft).toBeUndefined();
    expect(f.composer.text).toBe('Keep typing');
    expect(f.composer.pending).toBeUndefined();
    f.respond(failed('Unknown recipient', { status: 'skipped', reason: 'ineligible' }));
    await expect(f.composer.command('@nobody hi', true)).resolves.toBe('Unknown recipient');
    expect(f.composer.error).toBe('Unknown recipient');
    f.lose('Request failed (500)');
    await expect(f.composer.command('/stop', true)).resolves.toBe('Request failed (500)');
    expect(f.composer.pending?.line).toBe('/stop');
    expect(f.composer.text).toBe('Keep typing');
  });

  it('skips the state fetch and reports room-quit for a successful /quit', async () => {
    const f = fixture();
    f.composer.accept(snapshot());
    f.respond(sent());
    await expect(f.composer.command('/quit', true)).resolves.toBeUndefined();
    expect(f.stateCalls()).toBe(0);
    expect(f.events.at(-2)).toEqual({ type: 'room-quit' });
    expect(f.composer.pending).toBeUndefined();
  });
});

describe('browser composer attachment acknowledgement', () => {
  it('adopts the same-conversation snapshot text and references after an acknowledged attachment send', async () => {
    const f = fixture();
    const sentImage = metadata('sent.png');
    f.composer.accept(snapshot({ composerAttachments: [sentImage], composerDraftRevision: 4 }));
    f.composer.edit('Sent draft');
    const newer = metadata('newer.png');
    f.respond(
      sent('s1', { status: 'committed', operationId: 'op' }),
      snapshot({
        revision: 2,
        composerDraft: 'Newer accepted caption',
        composerDraftRevision: 6,
        composerAttachments: [newer],
      }),
    );
    await f.composer.submit(true);
    expect(f.requests[0]).toMatchObject({
      attachmentIds: ['sent.png'],
      draft: { baseRevision: 4 },
    });
    expect(f.composer.text).toBe('Newer accepted caption');
    expect(f.composer.images.attachments).toEqual([newer]);
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('Newer accepted caption');
    expect(f.composer.pending).toBeUndefined();
    expect(f.storage.has('chittr:s1:image-send')).toBe(false);
  });

  it('clears to empty when the acknowledged snapshot shows the atomic clear and nothing newer', async () => {
    const f = fixture();
    f.composer.accept(
      snapshot({ composerAttachments: [metadata('a.png')], composerDraftRevision: 1 }),
    );
    f.composer.edit('Caption', { replyTo: 'm2' });
    f.respond(
      sent('s1', { status: 'committed', operationId: 'op' }),
      snapshot({ revision: 2, composerDraft: '', composerDraftRevision: 2 }),
    );
    await f.composer.submit(true);
    expect(f.composer.text).toBe('');
    expect(f.composer.replyTo).toBeUndefined();
    expect(f.composer.images.attachments).toEqual([]);
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('');
  });

  it.each([
    ['session', snapshot({ sessionId: 's2', revision: 2, composerDraft: 'Other room draft' })],
    ['instance', snapshot({ instanceId: 'i2', revision: 1, composerDraft: 'Restarted host text' })],
  ])(
    'does not adopt a snapshot for a different %s; it clears only the matching submitted text',
    async (_name, next) => {
      const f = fixture();
      f.composer.accept(snapshot({ composerAttachments: [metadata('a.png')] }));
      f.composer.edit('Caption A');
      f.respond(sent(next.session.id, { status: 'committed', operationId: 'op' }), next);
      await f.composer.submit(true);
      expect(f.storage.get('chittr:i1:s1:draft')).toBe('');
      expect(f.storage.has('chittr:i1:s1:pending')).toBe(false);
      expect(f.storage.has('chittr:s1:image-send')).toBe(false);
      expect(f.composer.roomKey).toBe(`chittr:${next.instanceId}:${next.session.id}`);
      expect(f.composer.text).toBe(next.session.composerDraft);
      expect(f.storage.has(`chittr:${next.instanceId}:${next.session.id}:draft`)).toBe(false);
    },
  );
});

describe('browser composer local freshness', () => {
  it('leaves locally newer text alone when a delayed acknowledgement arrives', async () => {
    const f = fixture();
    f.composer.accept(snapshot());
    f.composer.edit('A text');
    const response = deferred<CommandResult>();
    f.responses.push(() => response.promise);
    f.states.push(() => Promise.resolve(snapshot({ revision: 2, composerDraft: '' })));
    const run = f.composer.submit(true)!;
    await flush();
    f.composer.edit('B text');
    response.resolve(sent());
    await run;
    expect(f.composer.text).toBe('B text');
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('B text');
    expect(f.composer.pending).toBeUndefined();
    expect(f.events.map((e) => e.type)).not.toContain('text-replaced');
  });

  it('ignores a stale snapshot for the presented instance', () => {
    const f = fixture();
    f.composer.accept(snapshot({ revision: 5, composerDraft: 'Current' }));
    f.composer.edit('Edited');
    expect(f.composer.accept(snapshot({ revision: 4, composerDraft: 'Older' }))).toBe('stale');
    expect(f.composer.text).toBe('Edited');
    expect(f.events.filter((e) => e.type === 'snapshot')).toHaveLength(1);
  });

  it('keeps another conversation untouched when the acknowledgement arrives after a switch', async () => {
    const f = fixture({ 'chittr:i1:s2:draft': 'Draft in the new room' });
    f.composer.accept(snapshot());
    f.composer.edit('A text');
    const response = deferred<CommandResult>();
    f.responses.push(() => response.promise);
    // The host has switched by the time A's own state fetch runs.
    f.states.push(() => Promise.resolve(snapshot({ sessionId: 's2', revision: 3 })));
    const run = f.composer.submit(true)!;
    await flush();
    expect(f.composer.accept(snapshot({ sessionId: 's2', revision: 2 }))).toBe('changed');
    expect(f.composer.text).toBe('Draft in the new room');
    expect(f.composer.pending).toBeUndefined();
    response.resolve(sent());
    await run;
    expect(f.composer.text).toBe('Draft in the new room');
    expect(f.composer.roomKey).toBe('chittr:i1:s2');
    expect(f.composer.error).toBe('');
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('');
    expect(f.storage.has('chittr:i1:s1:pending')).toBe(false);
    expect(f.storage.get('chittr:i1:s2:draft')).toBe('Draft in the new room');
  });

  it('drops a submission whose conversation or text changed while attachment work settled', async () => {
    const f = fixture();
    f.composer.accept(snapshot());
    f.composer.edit('Original');
    const save = deferred<{ accepted: boolean; revision: number }>();
    f.composer['transport'].saveDraft = () => save.promise;
    f.composer.captureSave()!.save();
    const run = f.composer.submit(true)!;
    await flush();
    expect(f.composer.busy).toBe(true);
    f.composer.edit('Changed while preparing');
    save.resolve({ accepted: true, revision: 1 });
    await run;
    expect(f.requests).toHaveLength(0);
    expect(f.composer.busy).toBe(false);
    expect(f.composer.text).toBe('Changed while preparing');
    const later = deferred<{ accepted: boolean; revision: number }>();
    f.composer['transport'].saveDraft = () => later.promise;
    f.composer.captureSave()!.save();
    const second = f.composer.submit(true)!;
    await flush();
    f.composer.accept(snapshot({ sessionId: 's2', revision: 2 }));
    later.resolve({ accepted: true, revision: 2 });
    await second;
    expect(f.requests).toHaveLength(0);
    expect(f.composer.busy).toBe(false);
  });
});

describe('browser composer conversation state', () => {
  it('restores the right conversation, prefers an unresolved attachment send, and revives interrupted uploads without bytes', () => {
    const attachmentSend: WebCommand = {
      id: 'a',
      sessionId: 's1',
      line: 'Lost image send',
      attachmentIds: ['img'],
      draft: { clientId: 'tab', version: 1, baseRevision: 0 },
    };
    const textSend: WebCommand = { id: 'b', sessionId: 's1', line: 'Lost text send' };
    const f = fixture({
      'chittr:i1:s1:draft': '/reply #m3 Saved reply',
      'chittr:s1:image-send': JSON.stringify(attachmentSend),
      'chittr:i1:s1:pending': JSON.stringify(textSend),
      'chittr:s1:uploads': JSON.stringify([
        { operationId: 'u1', filename: 'late.png', byteSize: 1, status: 'pending' },
      ]),
    });
    expect(f.composer.accept(snapshot({ composerDraft: 'Host draft' }))).toBe('changed');
    expect(f.composer.text).toBe('Saved reply');
    expect(f.composer.replyTo).toBe('m3');
    expect(f.composer.pending).toEqual(attachmentSend);
    expect(f.composer.images.uploads).toEqual([
      expect.objectContaining({
        operationId: 'u1',
        filename: 'late.png',
        status: 'failed',
        error: 'Upload interrupted. Retry or remove this image.',
      }),
    ]);
    expect(f.composer.images.uploads[0]).not.toHaveProperty('file');
    expect(f.events.at(-1)).toEqual({
      type: 'snapshot',
      state: expect.objectContaining({ instanceId: 'i1' }),
      conversationChanged: true,
    });
    // Without a tab copy the host draft is the starting text.
    const g = fixture();
    g.composer.accept(snapshot({ composerDraft: '/reply #m1 Host draft' }));
    expect(g.composer.text).toBe('Host draft');
    expect(g.composer.replyTo).toBe('m1');
    expect(g.composer.pending).toBeUndefined();
  });

  it('deactivates the previous attachment draft on a conversation change so delayed uploads are discarded', async () => {
    const f = fixture();
    f.composer.accept(snapshot());
    f.composer.stage([new File(['a'], 'late.png', { type: 'image/png' })]);
    await expect.poll(() => f.uploads.size).toBe(1);
    expect(f.composer.images.uploads).toHaveLength(1);
    expect(f.composer.accept(snapshot({ sessionId: 's2', revision: 2 }))).toBe('changed');
    expect(f.composer.images.uploads).toEqual([]);
    f.uploads.get('late.png')!.resolve(metadata('late.png'));
    await flush();
    expect(f.saves).toEqual([]);
    expect(f.composer.images.attachments).toEqual([]);
  });

  it('enforces the 64 KiB limit for edits and reply selection with the existing messages', () => {
    const f = fixture();
    f.composer.accept(snapshot());
    expect(f.composer.edit('x'.repeat(65536))).toBe(true);
    expect(f.composer.edit('x'.repeat(65537))).toBe(false);
    expect(f.composer.error).toBe(
      'Draft exceeds 64 KiB. Paste a smaller excerpt or reference a file.',
    );
    expect(f.composer.text).toHaveLength(65536);
    expect(f.composer.selectReply('m1')).toBe(false);
    expect(f.composer.error).toBe(
      'Draft exceeds 64 KiB. Shorten it before selecting a reply target.',
    );
    expect(f.composer.replyTo).toBeUndefined();
    expect(f.storage.get('chittr:i1:s1:draft')).toHaveLength(65536);
    f.composer.edit('short');
    expect(f.composer.selectReply('m1')).toBe(true);
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('/reply #m1 short');
    expect(f.composer.selectReply(undefined)).toBe(true);
    expect(f.storage.get('chittr:i1:s1:draft')).toBe('short');
    f.composer.dismissError();
    expect(f.composer.error).toBe('');
  });

  it('captures saves only while eligible and writes the captured text with keepalive', async () => {
    const f = fixture();
    expect(f.composer.captureSave()).toBeUndefined();
    f.composer.accept(snapshot());
    f.composer.edit('Draft', { replyTo: 'm1' });
    const capture = f.composer.captureSave()!;
    capture.save(true);
    await flush();
    expect(f.saves).toEqual([
      {
        update: { clientId: 'tab', version: 1, sessionId: 's1', text: '/reply #m1 Draft' },
        keepalive: true,
      },
    ]);
    // A capture taken before an edit is stale and saves nothing.
    const stale = f.composer.captureSave()!;
    f.composer.edit('Draft edited');
    stale.save();
    await flush();
    expect(f.saves).toHaveLength(1);
    f.lose();
    await f.composer.submit(true);
    expect(f.composer.pending).toBeDefined();
    expect(f.composer.captureSave()).toBeUndefined();
  });
});
