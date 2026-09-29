import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import type { RoomConfig } from '../src/types.js';
import { tinyPng } from './image-fixture.js';

// Controller-level coverage of RoomController.submitDraft: the typed outcome, the preserved
// capture points and queue boundaries, and the interleavings the transports cannot reach.
let root: string,
  store: SessionStore,
  controller: RoomController,
  quit: ReturnType<typeof vi.fn<() => Promise<void>>>;
const config = (workspace: string): RoomConfig => ({
  workspace,
  humanName: 'Bill',
  permissions: { edits: false, commands: false, network: false },
  followUpTurns: 8,
  sources: [],
  provenance: {},
  agents: {},
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const session = () => controller.room.session;
const revision = () => session().composerDraftRevision ?? 0;
const stage = (operationId = randomUUID()) =>
  controller.stageAttachment({
    sessionId: session().id,
    operationId,
    filename: 'fixture.png',
    mediaType: 'image/png',
    bytes: tinyPng(),
  });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'draft-submission-'));
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  store = new SessionStore(workspace, join(root, 'state'));
  store.acquire();
  quit = vi.fn(async () => {});
  controller = new RoomController(config(workspace), store, undefined, { help: 'help', quit });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await controller.close();
  store.release();
  rmSync(root, { recursive: true, force: true });
});

describe('terminal text', () => {
  const submit = (line: string) =>
    controller.submitDraft({ source: 'terminal-text', line, sessionId: session().id });
  it('clears synchronously before one queued dispatch and reports a sent outcome', async () => {
    controller.room.saveDraft('@human hello');
    const before = revision();
    const seen: string[] = [];
    const real = controller.submit.bind(controller);
    vi.spyOn(controller, 'submit').mockImplementation((...args) => {
      seen.push(session().composerDraft ?? 'undefined');
      return real(...args);
    });
    const pending = submit('@human hello');
    expect(session().composerDraft).toBe('');
    expect(revision()).toBe(before + 1);
    expect(seen).toEqual(['']);
    expect(await pending).toEqual({
      dispatch: { status: 'sent' },
      commitment: { status: 'not-applicable' },
      recovery: { status: 'not-needed' },
      sessionId: session().id,
    });
    expect(session().messages.map((m) => m.text)).toEqual(['hello']);
    expect(revision()).toBe(before + 1);
  });
  it('restores a failed line with an unversioned write only into its unchanged draft', async () => {
    controller.room.saveDraft('/unknown');
    const before = revision();
    const result = await submit('/unknown');
    expect(result.dispatch).toEqual({
      status: 'failed',
      failure: 'command-error',
      error: expect.stringContaining('Unknown command /unknown'),
    });
    expect(result.recovery).toEqual({ status: 'restored' });
    expect(result.commitment).toEqual({ status: 'not-applicable' });
    expect(session().composerDraft).toBe('/unknown');
    expect(revision()).toBe(before + 2);
    expect(session().composerDraftVersions).toEqual({});
  });
  it.each(['/new', '/sessions ID', '/quit'])(
    'clears %s before dispatch and reports the selected session afterwards',
    async (command) => {
      const original = session().id;
      await controller.submit('@human keep');
      if (command === '/sessions ID') {
        await controller.submit('/new');
        command = `/sessions ${original}`;
      }
      const from = session().id;
      controller.room.saveDraft(command);
      const result = await submit(command);
      expect(result.dispatch).toEqual({ status: 'sent' });
      expect(result.recovery).toEqual({ status: 'not-needed' });
      expect(store.load(from)!.composerDraft).toBe('');
      expect(result.sessionId).toBe(session().id);
      if (command === '/quit') expect(quit).toHaveBeenCalledOnce();
      else expect(session().id).not.toBe(from);
    },
  );
  it('skips restoration for a newer draft written while the send was pending', async () => {
    controller.room.saveDraft('first');
    const pending = deferred<void>();
    vi.spyOn(controller, 'submit').mockReturnValueOnce(pending.promise);
    const sending = submit('first');
    controller.room.saveDraft('newer thought');
    pending.reject(new Error('indeterminate'));
    const result = await sending;
    expect(result.dispatch).toMatchObject({ status: 'failed', error: 'indeterminate' });
    expect(result.recovery).toEqual({ status: 'skipped', reason: 'newer-draft' });
    expect(session().composerDraft).toBe('newer thought');
  });
  it('skips restoration when the conversation changed before the failure was classified', async () => {
    const original = session().id;
    controller.room.saveDraft('old send');
    const pending = deferred<void>();
    vi.spyOn(controller, 'submit').mockReturnValueOnce(pending.promise);
    const sending = submit('old send');
    await controller.submit('/new');
    controller.room.saveDraft('new caption');
    pending.reject(new Error('old failure'));
    const result = await sending;
    expect(result.recovery).toEqual({ status: 'skipped', reason: 'conversation-changed' });
    expect(result.sessionId).toBe(session().id);
    expect(session().id).not.toBe(original);
    expect(session().composerDraft).toBe('new caption');
    expect(store.load(original)!.composerDraft).toBe('');
  });
  it('reports a failed restoration separately from the command error', async () => {
    controller.room.saveDraft('/unknown');
    const sending = submit('/unknown');
    vi.spyOn(controller.room, 'saveDraft').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const result = await sending;
    expect(result.dispatch).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Unknown command'),
    });
    expect(result.recovery).toEqual({ status: 'failed', error: 'disk full' });
    expect(session().composerDraft).toBe('');
  });
});

describe('http', () => {
  const clientId = randomUUID();
  const submit = (
    line: string,
    extra: Partial<Extract<Parameters<RoomController['submitDraft']>[0], { source: 'http' }>> = {},
  ) =>
    controller.submitDraft({
      source: 'http',
      line,
      sessionId: session().id,
      operationId: randomUUID(),
      ...extra,
    });
  it('validates, clears with the client version and submits as three queued actions', async () => {
    await controller.updateDraft({ text: '@human hi', clientId, version: 1 }, session().id);
    const before = revision();
    const order: string[] = [];
    for (const method of ['validateCommandOperation', 'updateDraft', 'submit'] as const) {
      const real = (controller[method] as (...args: unknown[]) => unknown).bind(controller);
      vi.spyOn(controller, method).mockImplementation(((...args: unknown[]) => {
        order.push(method);
        return real(...args);
      }) as never);
    }
    const result = await submit('@human hi', { draft: { clientId, version: 2 } });
    expect(order).toEqual(['validateCommandOperation', 'updateDraft', 'submit']);
    expect(result).toEqual({
      dispatch: { status: 'sent' },
      commitment: { status: 'not-applicable' },
      recovery: { status: 'not-needed' },
      sessionId: session().id,
    });
    expect(session().composerDraft).toBe('');
    expect(session().composerDraftVersions).toEqual({ [clientId]: 2 });
    expect(revision()).toBe(before + 1);
  });
  it('restores input.line unversioned when the guard qualifies, advancing revision only', async () => {
    await controller.updateDraft({ text: '/unknown', clientId, version: 1 }, session().id);
    const before = revision();
    const result = await submit('/unknown', { draft: { clientId, version: 2 } });
    expect(result.dispatch).toMatchObject({ status: 'failed', failure: 'command-error' });
    expect(result.recovery).toEqual({ status: 'restored' });
    expect(session().composerDraft).toBe('/unknown');
    expect(session().composerDraftVersions).toEqual({ [clientId]: 2 });
    expect(revision()).toBe(before + 2);
  });
  it('reports ineligible without any draft write when no draft identity was sent', async () => {
    controller.room.saveDraft('kept');
    const before = revision();
    const result = await submit('/unknown');
    expect(result.recovery).toEqual({ status: 'skipped', reason: 'ineligible' });
    expect(session().composerDraft).toBe('kept');
    expect(revision()).toBe(before);
  });
  it('lets a stale clear through to dispatch and skips restoration for the newer version', async () => {
    await controller.updateDraft({ text: 'v5', clientId, version: 5 }, session().id);
    const before = revision();
    const sent = await submit('@human stale but valid', { draft: { clientId, version: 3 } });
    expect(sent.dispatch).toEqual({ status: 'sent' });
    expect(session().messages.map((m) => m.text)).toEqual(['stale but valid']);
    expect(session().composerDraft).toBe('v5');
    expect(revision()).toBe(before);
    const failed = await submit('/unknown', { draft: { clientId, version: 3 } });
    expect(failed.recovery).toEqual({ status: 'skipped', reason: 'newer-draft' });
    expect(session().composerDraft).toBe('v5');
    expect(session().composerDraftVersions).toEqual({ [clientId]: 5 });
  });
  it('lets a same-client draft land between validation and the clear, through the public queue', async () => {
    await controller.updateDraft({ text: '/unknown', clientId, version: 1 }, session().id);
    const base = revision();
    const sending = submit('/unknown', { draft: { clientId, version: 2 } });
    // Enqueued after the queued validation and before the queued clear and dispatch.
    const competing = controller.updateDraft({ text: 'B', clientId, version: 3 }, session().id);
    expect(await competing).toEqual({ revision: base + 1, accepted: true });
    const result = await sending;
    expect(result.dispatch).toMatchObject({ status: 'failed', failure: 'command-error' });
    expect(result.recovery).toEqual({ status: 'skipped', reason: 'newer-draft' });
    expect(session().composerDraft).toBe('B');
    expect(session().composerDraftVersions).toEqual({ [clientId]: 3 });
    expect(revision()).toBe(base + 1);
  });
  it('lets a same-client draft land between the clear and the dispatch, through the public queue', async () => {
    await controller.updateDraft({ text: '/unknown', clientId, version: 1 }, session().id);
    const base = revision();
    const real = controller.updateDraft.bind(controller);
    const writes: Array<{ text: string; revision: number }> = [];
    let competing!: Promise<{ revision: number; accepted: boolean }>;
    vi.spyOn(controller, 'updateDraft').mockImplementation((value, sessionId) => {
      const queued = real(value, sessionId);
      void queued.then((saved) =>
        writes.push({
          text: typeof value === 'string' ? value : value.text,
          revision: saved.revision,
        }),
      );
      if (typeof value !== 'string' && value.text === '' && !competing) {
        competing = real({ text: 'B', clientId, version: 3 }, sessionId);
        void competing.then((saved) => writes.push({ text: 'B', revision: saved.revision }));
      }
      return queued;
    });
    const result = await submit('/unknown', { draft: { clientId, version: 2 } });
    expect(await competing).toEqual({ revision: base + 2, accepted: true });
    expect(writes).toEqual([
      { text: '', revision: base + 1 },
      { text: 'B', revision: base + 2 },
    ]);
    expect(result.dispatch).toMatchObject({ status: 'failed', failure: 'command-error' });
    expect(result.recovery).toEqual({ status: 'skipped', reason: 'newer-draft' });
    expect(session().composerDraft).toBe('B');
    expect(session().composerDraftVersions).toEqual({ [clientId]: 3 });
    expect(revision()).toBe(base + 2);
  });
  it('leaves the draft uncleared when a switch lands between validation and the clear', async () => {
    const original = session().id;
    await controller.updateDraft({ text: 'keep me', clientId, version: 1 }, original);
    const base = revision();
    const sending = submit('@human keep me', { draft: { clientId, version: 2 } });
    const switching = controller.submit('/new');
    const result = await sending;
    await switching;
    expect(result.dispatch).toEqual({
      status: 'failed',
      failure: 'command-error',
      error: 'The conversation changed. Your message has not been sent.',
    });
    expect(result.recovery).toEqual({ status: 'skipped', reason: 'conversation-changed' });
    expect(result.sessionId).toBe(session().id);
    expect(session().id).not.toBe(original);
    expect(store.load(original)).toMatchObject({
      composerDraft: 'keep me',
      composerDraftRevision: base,
      composerDraftVersions: { [clientId]: 1 },
      messages: [],
    });
  });
  it('reports conversation-changed when a switch lands between the guard and the queued write', async () => {
    const original = session().id;
    await controller.updateDraft({ text: '/unknown', clientId, version: 1 }, original);
    const real = controller.submit.bind(controller);
    let switching!: Promise<void>;
    vi.spyOn(controller, 'submit').mockImplementationOnce((...args) => {
      const dispatched = real(...args);
      switching = real('/new');
      return dispatched;
    });
    const update = vi.spyOn(controller, 'updateDraft');
    const result = await submit('/unknown', { draft: { clientId, version: 2 } });
    await switching;
    expect(update).toHaveBeenLastCalledWith('/unknown', original);
    expect(result.dispatch).toMatchObject({ status: 'failed', failure: 'command-error' });
    expect(result.recovery).toEqual({ status: 'skipped', reason: 'conversation-changed' });
    expect(result.sessionId).toBe(session().id);
    expect(session().id).not.toBe(original);
    expect(store.load(original)!.composerDraft).toBe('');
    expect(session().composerDraft ?? '').toBe('');
  });
  it('reports a failed queued restoration while keeping the command error', async () => {
    await controller.updateDraft({ text: '/unknown', clientId, version: 1 }, session().id);
    const real = controller.submit.bind(controller);
    vi.spyOn(controller, 'submit').mockImplementationOnce(async (...args) => {
      const dispatched = real(...args);
      vi.spyOn(controller.room, 'saveDraft').mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      return dispatched;
    });
    const result = await submit('/unknown', { draft: { clientId, version: 2 } });
    expect(result.dispatch).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Unknown command'),
    });
    expect(result.recovery).toEqual({ status: 'failed', error: 'disk full' });
    expect(session().composerDraft).toBe('');
  });
  it('distinguishes attachment commit failure, error after commitment and replay', async () => {
    const attachment = await stage();
    await controller.updateDraft(
      {
        text: 'caption',
        attachmentIds: [attachment.id],
        baseRevision: revision(),
        clientId,
        version: 1,
      },
      session().id,
    );
    const base = revision();
    const operationId = randomUUID();
    const attempt = (baseRevision: number) =>
      submit('caption', {
        attachmentIds: [attachment.id],
        operationId,
        draft: { clientId, version: 2, baseRevision },
      });
    const uncommitted = await attempt(base - 1);
    expect(uncommitted.dispatch).toMatchObject({
      status: 'failed',
      failure: 'command-error',
      error: expect.stringContaining('Draft changed'),
    });
    expect(uncommitted.commitment).toEqual({ status: 'uncommitted', operationId });
    expect(uncommitted.recovery).toEqual({ status: 'skipped', reason: 'ineligible' });
    expect(session().messages).toHaveLength(0);
    expect(session().composerDraft).toBe('caption');
    expect(session().composerAttachments).toEqual([attachment]);
    expect(session().composerDraftVersions).toEqual({ [clientId]: 1 });
    expect(revision()).toBe(base);

    const real = controller.submit.bind(controller);
    vi.spyOn(controller, 'submit').mockImplementationOnce(async (...args) => {
      await real(...args);
      throw new Error('lost acknowledgement');
    });
    const afterCommit = await attempt(base);
    expect(afterCommit.dispatch).toMatchObject({ status: 'failed', error: 'lost acknowledgement' });
    expect(afterCommit.commitment).toEqual({ status: 'committed', operationId });
    expect(afterCommit.recovery).toEqual({ status: 'restored' });
    expect(session().messages).toHaveLength(1);
    expect(session().messages[0]!.attachmentOperation!.id).toBe(operationId);
    expect(session().composerDraft).toBe('');
    expect(session().composerAttachments).toEqual([]);
    expect(session().composerDraftVersions).toEqual({ [clientId]: 2 });
    expect(revision()).toBe(base + 2);

    const replay = await attempt(base);
    expect(replay).toEqual({
      dispatch: { status: 'sent' },
      commitment: { status: 'committed', operationId },
      recovery: { status: 'not-needed' },
      sessionId: session().id,
    });
    expect(session().messages).toHaveLength(1);
    expect(revision()).toBe(base + 2);
  });
  it.each(['the same session', 'another session'])(
    'classifies commitment from the Room the dispatch ran against, captured under %s',
    async (selected) => {
      const target = session().id;
      const attachment = await stage();
      await controller.updateDraft(
        {
          text: 'A',
          attachmentIds: [attachment.id],
          baseRevision: revision(),
          clientId,
          version: 1,
        },
        target,
      );
      const base = revision();
      if (selected === 'another session') await controller.submit('/new');
      const captured = controller.room;
      const real = controller.submit.bind(controller);
      const executedIn: string[] = [];
      vi.spyOn(controller, 'submit').mockImplementationOnce(async (...args) => {
        executedIn.push('placeholder');
        await real(args[0], args[1], {
          ...args[2],
          executing: (room) => {
            executedIn[0] = room === captured ? 'captured' : 'replacement';
            args[2]!.executing?.(room);
          },
        });
        await real('/new');
        throw new Error('lost acknowledgement');
      });
      const operationId = randomUUID();
      // Queued before the submission: the target session is reopened in a replacement Room.
      const returning = real(`/sessions ${target}`);
      const result = await submit('A', {
        sessionId: target,
        attachmentIds: [attachment.id],
        operationId,
        draft: { clientId, version: 2, baseRevision: base },
      });
      await returning;
      expect(executedIn).toEqual(['replacement']);
      expect(captured.committedAttachmentOperation(operationId)).toBeUndefined();
      expect(result.dispatch).toMatchObject({ status: 'failed', error: 'lost acknowledgement' });
      expect(result.commitment).toEqual({ status: 'committed', operationId });
      expect(result.recovery).toEqual({ status: 'skipped', reason: 'conversation-changed' });
      expect(session().id).not.toBe(target);
      expect(result.sessionId).toBe(session().id);
      expect(store.load(target)).toMatchObject({
        messages: [{ text: 'A', attachmentOperation: { id: operationId } }],
        composerDraft: '',
        composerAttachments: [],
        composerDraftVersions: { [clientId]: 2 },
      });
    },
  );
  it('classifies a refused retry from the saved session an earlier attempt committed into', async () => {
    const target = session().id;
    const attachment = await stage();
    const operationId = randomUUID();
    const send = () =>
      submit('A', { sessionId: target, attachmentIds: [attachment.id], operationId });
    expect((await send()).commitment).toEqual({ status: 'committed', operationId });
    await controller.submit('/new');
    const load = vi.spyOn(store, 'load');
    const refused = await send();
    expect(refused.dispatch).toMatchObject({
      status: 'failed',
      error: 'The conversation changed. Your message has not been sent.',
    });
    expect(refused.commitment).toEqual({ status: 'committed', operationId });
    expect(refused.recovery).toEqual({ status: 'skipped', reason: 'ineligible' });
    expect(load).toHaveBeenCalledWith(target);
    expect(store.load(target)!.messages).toHaveLength(1);
    expect(session().messages).toHaveLength(0);
  });
  it('reports a refused dispatch of never-committed work as uncommitted, leaving the retry open', async () => {
    const target = session().id;
    const attachment = await stage();
    const operationId = randomUUID();
    const send = () =>
      submit('A', { sessionId: target, attachmentIds: [attachment.id], operationId });
    await controller.submit('/new');
    const refused = await send();
    expect(refused.dispatch).toMatchObject({ status: 'failed', failure: 'command-error' });
    expect(refused.commitment).toEqual({ status: 'uncommitted', operationId });
    expect(store.load(target)!.messages).toHaveLength(0);
    await controller.submit(`/sessions ${target}`);
    const delivered = await send();
    expect(delivered.dispatch).toEqual({ status: 'sent' });
    expect(delivered.commitment).toEqual({ status: 'committed', operationId });
    expect(session().messages).toHaveLength(1);
  });
  it('fails the submission when the saved session cannot be read, instead of reporting uncommitted', async () => {
    const target = session().id;
    const attachment = await stage();
    const operationId = randomUUID();
    await submit('A', { sessionId: target, attachmentIds: [attachment.id], operationId });
    await controller.submit('/new');
    const base = revision();
    vi.spyOn(store, 'load').mockImplementationOnce(() => {
      throw new Error('Saved session is invalid or unsupported; it has not been overwritten');
    });
    await expect(
      submit('A', { sessionId: target, attachmentIds: [attachment.id], operationId }),
    ).rejects.toThrow(
      `Could not read the saved conversation to classify attachment operation ${operationId}: Saved session is invalid or unsupported; it has not been overwritten`,
    );
    expect(revision()).toBe(base);
    expect(session().messages).toHaveLength(0);
  });
  it('reports a qualifying attachment recovery guard without a committed operation', async () => {
    const attachment = await stage();
    await controller.updateDraft(
      {
        text: 'caption',
        attachmentIds: [attachment.id],
        baseRevision: revision(),
        clientId,
        version: 3,
      },
      session().id,
    );
    const base = revision();
    const operationId = randomUUID();
    const result = await submit('caption', {
      attachmentIds: [attachment.id],
      operationId,
      draft: { clientId, version: 3, baseRevision: base },
    });
    expect(result.dispatch).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('stale'),
    });
    expect(result.commitment).toEqual({ status: 'uncommitted', operationId });
    expect(result.recovery).toEqual({ status: 'restored' });
    expect(session().messages).toHaveLength(0);
    expect(session().composerDraft).toBe('caption');
    expect(session().composerAttachments).toEqual([attachment]);
    expect(session().composerDraftVersions).toEqual({ [clientId]: 3 });
    expect(revision()).toBe(base + 1);
  });
  it('classifies a reused operation ID with different input as a conflict with no draft effect', async () => {
    const attachment = await stage();
    const operationId = randomUUID();
    const first = await submit('first', { attachmentIds: [attachment.id], operationId });
    expect(first.dispatch).toEqual({ status: 'sent' });
    await controller.updateDraft({ text: 'unsent', clientId, version: 1 }, session().id);
    const base = revision();
    const result = await submit('second', {
      attachmentIds: [attachment.id],
      operationId,
      draft: { clientId, version: 1, baseRevision: base },
    });
    expect(result.dispatch).toEqual({
      status: 'failed',
      failure: 'operation-conflict',
      error: 'Attachment operation ID was already used for different input',
    });
    expect(result.recovery).toEqual({ status: 'skipped', reason: 'ineligible' });
    expect(session().composerDraft).toBe('unsent');
    expect(revision()).toBe(base);
    expect(session().messages).toHaveLength(1);
  });
});

describe('terminal attachments', () => {
  const clientId = randomUUID();
  it('never writes a draft on failure and still reports a committed operation', async () => {
    const attachment = await stage();
    controller.room.saveDraft({ text: 'caption', attachmentIds: [attachment.id], baseRevision: 0 });
    const base = revision();
    const operationId = randomUUID();
    const attempt = (version: number) =>
      controller.submitDraft({
        source: 'terminal-attachments',
        line: 'caption',
        sessionId: session().id,
        attachmentIds: [attachment.id],
        operationId,
        draft: { clientId, version, baseRevision: revision() },
      });
    vi.spyOn(controller, 'submit').mockRejectedValueOnce(new Error('indeterminate'));
    const uncommitted = await attempt(1);
    expect(uncommitted.dispatch).toMatchObject({ status: 'failed', error: 'indeterminate' });
    expect(uncommitted.commitment).toEqual({ status: 'uncommitted', operationId });
    expect(uncommitted.recovery).toEqual({ status: 'skipped', reason: 'ineligible' });
    expect(session().composerDraft).toBe('caption');
    expect(session().composerAttachments).toEqual([attachment]);
    expect(revision()).toBe(base);

    const real = controller.submit.bind(controller);
    vi.spyOn(controller, 'submit').mockImplementationOnce(async (...args) => {
      await real(...args);
      throw new Error('lost acknowledgement');
    });
    const committed = await attempt(2);
    expect(committed.dispatch).toMatchObject({ status: 'failed', error: 'lost acknowledgement' });
    expect(committed.commitment).toEqual({ status: 'committed', operationId });
    expect(committed.recovery).toEqual({ status: 'skipped', reason: 'ineligible' });
    expect(session().messages).toHaveLength(1);
    expect(session().composerDraft).toBe('');
    expect(session().composerAttachments).toEqual([]);
    expect(revision()).toBe(base + 1);
  });
});
