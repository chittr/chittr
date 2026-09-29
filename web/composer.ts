import { AttachmentDraft, type DraftHost, type UploadItem } from './attachment-draft';
import type { AttachmentMetadata } from '../src/types.js';
import type {
  CommandResult,
  DraftSubmissionResult,
  WebCommand,
  WebState,
} from '../src/web-types.js';
import { formatReplyDraft, parseReplyDraft } from '../src/reply.js';

/**
 * The browser composer: recoverable composer state and its transitions, owned outside
 * rendering. Rendering reads the observable state below and submits intentions; it never
 * decides draft persistence, retry identity or recovery.
 *
 * Lifecycle. One controller lives for the page. `accept` feeds it every host snapshot the
 * page receives, whether from the event stream or from a command's own state fetch. A
 * snapshot for another instance/session ends the previous conversation's local work: its
 * `AttachmentDraft` is deactivated so delayed upload or ownership results are discarded,
 * and the new conversation's local draft, pending command and interrupted uploads are
 * restored from storage before the snapshot is presented.
 *
 * Conversation identity. `roomKey` is `chittr:<instanceId>:<sessionId>`; the instance is
 * the host launch, so a restarted host is a different conversation even for the same saved
 * session. Every intention captures the key it started under and checks it again after
 * each await; a result that arrives for an earlier conversation touches only that
 * conversation's storage, never the current one's memory.
 *
 * Storage scope. Instance/session scoped: `<roomKey>:draft` (formatted reply draft) and
 * `<roomKey>:pending` (the unresolved command). Session scoped, surviving a host restart:
 * `chittr:<sessionId>:image-send` (an unresolved attachment send, which takes precedence
 * over `:pending`) and `chittr:<sessionId>:uploads` (interrupted uploads without bytes).
 * The per-tab client/version allocator is the transport's `draftVersion`. No `File` bytes
 * are ever stored.
 *
 * Submission and retry outcomes. A composer submission allocates one command identity and
 * one draft version and retains the request as `pending` until the host acknowledges it.
 * The acknowledgement is the `CommandResult` plus, for anything but `/quit`, a state fetch.
 * Three sources are kept apart when that acknowledgement is mapped to browser state:
 *
 * - A2 result facts (`CommandResult.submission`) describe operation A: whether it was
 *   dispatched, whether its attachment work is committed, and what the host did to the
 *   draft afterwards. They are retained unchanged as `outcome`, apart from `error`, which
 *   carries only the command error. A failed dispatch keeps the local text and the original
 *   command error and clears pending, however the attachment work or recovery came out. A
 *   transport error or a failed state fetch is not a result and produces no outcome:
 *   pending and its identity are retained for `retryPending`, which resends the identical
 *   request.
 * - The accepted host snapshot describes current host state. After an acknowledged
 *   attachment send in the same instance/session its composer text and references are
 *   adopted; a text-only send clears matching local text instead of adopting host text.
 * - Local freshness: stored text is replaced only while it still equals the submitted
 *   line, and in-memory text only while the conversation and the submitted line still
 *   match, so a locally newer draft or another conversation is never overwritten.
 *
 * Generic commands (`command`) share the serialized send path and return the error string
 * the caller presents, including transport errors, but gain no composer clearing.
 */
export type ComposerEvent =
  | { type: 'change' }
  /** A snapshot was accepted; the binding presents it and resets unrelated UI on a change. */
  | { type: 'snapshot'; state: WebState; conversationChanged: boolean }
  /** An acknowledgement cleared or replaced the composer text outside an edit. */
  | { type: 'text-replaced' }
  /** A successful `/quit` produced no snapshot; the room is closed. */
  | { type: 'room-quit' };

export interface DraftUpdate {
  clientId: string;
  version: number;
  sessionId: string;
  text: string;
  baseRevision?: number;
  attachmentIds?: string[];
}
/** The concrete browser mechanisms the composer needs; HTTP and authentication stay in api.ts. */
export interface ComposerTransport {
  /** Sends a command; rejects on transport failure or an error status. */
  command(request: WebCommand): Promise<CommandResult>;
  /** Fetches the current host snapshot. */
  state(): Promise<WebState>;
  /** Saves the draft; `keepalive` lets a page-hide save outlive the page. */
  saveDraft(
    update: DraftUpdate,
    keepalive?: boolean,
  ): Promise<{ accepted: boolean; revision: number }>;
  upload(file: File, sessionId: string, operationId: string): Promise<AttachmentMetadata>;
  /** The per-tab draft version allocator. */
  draftVersion(): { clientId: string; version: number };
}
export interface ComposerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
/**
 * The typed result of the most recent command the host answered, kept apart from `error`.
 * `submission.dispatch` carries the command error, `submission.recovery` any separate
 * recovery error, `submission.commitment` the attachment fact and `submission.sessionId` the
 * resulting session; `roomKey` is the conversation the request was submitted from, which a
 * switching command leaves behind. Nothing here is collapsed into a success flag.
 */
export interface ComposerOutcome {
  request: WebCommand;
  roomKey: string;
  submission: DraftSubmissionResult;
}
/** The attachment state the view renders, read from the active `AttachmentDraft`. */
export interface ComposerImages {
  attachments: AttachmentMetadata[];
  uploads: UploadItem[];
  error: string;
  saveStatus: string;
  removalId?: string;
}
export const byteSize = (value: string) => new TextEncoder().encode(value).length;
const limit = 65536;

export class ComposerController {
  private listeners = new Set<(event: ComposerEvent) => void>();
  private changeCount = 0;
  private imageChangeCount = 0;
  private snapshot?: WebState;
  private room = { key: '', instanceId: '', sessionId: '' };
  private manager?: AttachmentDraft;
  private textValue = '';
  private replyTarget?: string;
  private errorText = '';
  private pendingRequest?: WebCommand;
  private lastOutcome?: ComposerOutcome;
  private preparing = false;
  private sending = false;
  constructor(
    private transport: ComposerTransport,
    private storage: ComposerStorage,
  ) {}

  // Observable state.
  /** Increments on every change; a stable snapshot for `useSyncExternalStore`. */
  get changes(): number {
    return this.changeCount;
  }
  /** Increments when the attachment state changes, for effects keyed to the image tiles. */
  get imageChanges(): number {
    return this.imageChangeCount;
  }
  /** The composer text without its reply prefix. */
  get text(): string {
    return this.textValue;
  }
  get replyTo(): string | undefined {
    return this.replyTarget;
  }
  /** Preparing attachments or sending; the composer is not editable. */
  get busy(): boolean {
    return this.preparing || this.sending;
  }
  /** The unresolved command, retained until the host acknowledges it. */
  get pending(): WebCommand | undefined {
    return this.pendingRequest;
  }
  /** Command feedback for the current conversation; empty when there is none. */
  get error(): string {
    return this.errorText;
  }
  /** A2's result for the last answered command, or undefined before one is answered. */
  get outcome(): ComposerOutcome | undefined {
    return this.lastOutcome;
  }
  /** `chittr:<instanceId>:<sessionId>` of the presented conversation, or '' before one. */
  get roomKey(): string {
    return this.room.key;
  }
  get images(): ComposerImages {
    return {
      attachments: this.manager?.host.attachments ?? [],
      uploads: this.manager?.items ?? [],
      error: this.manager?.error ?? '',
      saveStatus: this.manager?.saveStatus ?? '',
      removalId: this.manager?.removalId,
    };
  }
  subscribe = (listener: (event: ComposerEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(event: ComposerEvent = { type: 'change' }) {
    this.changeCount++;
    for (const listener of [...this.listeners]) listener(event);
  }

  /**
   * Accepts a host snapshot. A snapshot older than the presented one for the same instance
   * is `stale` and ignored. A different instance/session is `changed`: the previous
   * conversation's local work ends and the new one's is restored from storage.
   */
  accept(next: WebState): 'stale' | 'changed' | 'updated' {
    if (this.snapshot?.instanceId === next.instanceId && this.snapshot.revision > next.revision)
      return 'stale';
    const key = `chittr:${next.instanceId}:${next.session.id}`;
    const changed = this.room.key !== key;
    if (changed) {
      if (this.manager) this.manager.active = false;
      this.room = { key, instanceId: next.instanceId, sessionId: next.session.id };
      this.manager = this.createManager(next);
      const savedDraft = parseReplyDraft(
        this.storage.getItem(key + ':draft') ?? next.session.composerDraft,
      );
      this.textValue = savedDraft.text;
      this.replyTarget = savedDraft.replyTo;
      this.manager.setText(formatReplyDraft(savedDraft.text, savedDraft.replyTo));
      const saved =
        this.storage.getItem(`chittr:${next.session.id}:image-send`) ??
        this.storage.getItem(key + ':pending');
      try {
        this.pendingRequest = saved ? JSON.parse(saved) : undefined;
      } catch {
        this.pendingRequest = undefined;
      }
    }
    this.manager?.reconcile({
      revision: next.session.composerDraftRevision,
      attachments: next.session.composerAttachments,
    });
    this.snapshot = next;
    this.emit({ type: 'snapshot', state: next, conversationChanged: changed });
    return changed ? 'changed' : 'updated';
  }
  private createManager(next: WebState): AttachmentDraft {
    const { instanceId } = next;
    const sessionId = next.session.id;
    const uploadKey = `chittr:${sessionId}:uploads`;
    let restored: UploadItem[] = [];
    try {
      restored = JSON.parse(this.storage.getItem(uploadKey) ?? '[]');
    } catch {
      /* Host still restores accepted references. */
    }
    const manager: AttachmentDraft = new AttachmentDraft(
      {
        revision: next.session.composerDraftRevision,
        attachments: next.session.composerAttachments,
      },
      {
        upload: (file, operationId) => this.transport.upload(file, sessionId, operationId),
        save: (text, host, keepalive) =>
          this.transport.saveDraft(
            {
              ...this.transport.draftVersion(),
              sessionId,
              text,
              ...(host
                ? { baseRevision: host.revision, attachmentIds: host.attachments.map((a) => a.id) }
                : {}),
            },
            keepalive,
          ),
        refresh: async (): Promise<DraftHost> => {
          const snapshot = await this.transport.state();
          if (snapshot.session.id !== sessionId || snapshot.instanceId !== instanceId)
            throw new Error('Conversation changed');
          return {
            revision: snapshot.session.composerDraftRevision,
            attachments: snapshot.session.composerAttachments,
          };
        },
        persist: (items) => {
          if (manager.active) this.storage.setItem(uploadKey, JSON.stringify(items));
        },
        changed: () => {
          this.imageChangeCount++;
          this.emit();
        },
      },
      Array.isArray(restored) ? restored : [],
    );
    return manager;
  }

  // Editing.
  /**
   * Sets the composer text, keeping the current reply target unless `options.replyTo` is
   * given. Returns false, with the feedback set, when the formatted draft exceeds 64 KiB.
   */
  edit(text: string, options: { replyTo?: string } = { replyTo: this.replyTarget }): boolean {
    const value = formatReplyDraft(text, options.replyTo);
    if (byteSize(value) > limit) {
      this.errorText = 'Draft exceeds 64 KiB. Paste a smaller excerpt or reference a file.';
      this.emit();
      return false;
    }
    this.textValue = text;
    this.replyTarget = options.replyTo;
    this.store(value);
    return true;
  }
  /** Sets or clears the reply target; false, with the feedback set, when the draft would exceed 64 KiB. */
  selectReply(id?: string): boolean {
    const value = formatReplyDraft(this.textValue, id);
    if (byteSize(value) > limit) {
      this.errorText = 'Draft exceeds 64 KiB. Shorten it before selecting a reply target.';
      this.emit();
      return false;
    }
    this.replyTarget = id;
    this.store(value);
    return true;
  }
  private store(value: string) {
    this.manager?.setText(value);
    this.storage.setItem(this.room.key + ':draft', value);
    this.emit();
  }
  /** Presents feedback from a view-owned operation in the same slot command failures use. */
  report(message: string): void {
    this.errorText = message;
    this.emit();
  }
  dismissError(): void {
    this.errorText = '';
    this.emit();
  }

  // Saving.
  /**
   * Captures the current text for a host save, or returns undefined while nothing may be
   * saved: before a snapshot, while a command is pending or while busy. The binding owns
   * the timer and page-hide event; `save` writes the captured text through the conversation
   * that was active at capture, and writes nothing once the text or conversation moved on.
   */
  captureSave(): { save(keepalive?: boolean): void } | undefined {
    if (!this.snapshot || this.pendingRequest || this.busy) return;
    const manager = this.manager;
    const text = formatReplyDraft(this.textValue, this.replyTarget);
    return {
      save: (keepalive = false) => {
        if (manager !== this.manager || formatReplyDraft(this.textValue, this.replyTarget) !== text)
          return;
        void manager?.saveText(text, keepalive);
      },
    };
  }
  /** Repeats the host save of the current text after a reported save failure. */
  retryDraftSave(): void {
    void this.manager?.saveText(formatReplyDraft(this.textValue, this.replyTarget));
  }

  // Submitting.
  /**
   * Submits the composer. Returns undefined when not eligible: no snapshot, nothing to
   * send, uploads still pending, a pending command, busy, or the connection not live.
   * Otherwise waits for attachment work, rechecks the conversation and text, allocates the
   * command identity and draft version and sends. The returned promise settles when the
   * submission has been acknowledged or its failure recorded.
   */
  submit(live: boolean): Promise<void> | undefined {
    const manager = this.manager;
    if (
      !this.snapshot ||
      (!this.textValue.trim() && !manager?.host.attachments.length) ||
      manager?.items.length ||
      this.pendingRequest ||
      this.sending ||
      this.preparing ||
      !live
    )
      return;
    return this.prepareAndSend();
  }
  private async prepareAndSend(): Promise<void> {
    const { key, sessionId } = this.room;
    const manager = this.manager;
    const text = this.textValue;
    const replyTo = this.replyTarget;
    this.preparing = true;
    this.emit();
    manager?.setText(formatReplyDraft(text, replyTo));
    await manager?.settled();
    this.preparing = false;
    this.emit();
    if (
      this.room.key !== key ||
      manager?.items.length ||
      this.sending ||
      this.textValue !== text ||
      (!text.trim() && !manager?.host.attachments.length)
    )
      return;
    await this.execute({
      id: crypto.randomUUID(),
      sessionId,
      line: formatReplyDraft(text, replyTo),
      ...(manager?.host.attachments.length
        ? { attachmentIds: manager.host.attachments.map((a) => a.id) }
        : {}),
      draft: { ...this.transport.draftVersion(), baseRevision: manager?.host.revision },
    });
  }
  /** Resends the retained pending request unchanged, with its original identity. */
  retryPending(): Promise<void> {
    const request = this.pendingRequest;
    return request ? this.execute(request).then(() => undefined) : Promise.resolve();
  }
  /**
   * Runs a generic command for the current conversation. Returns undefined without sending
   * when not eligible: no snapshot, the connection not live, a pending command, or a send
   * in progress. Otherwise resolves to the error string, including transport errors, or to
   * undefined on success. No composer text is cleared.
   */
  command(line: string, live: boolean): Promise<string | undefined> | undefined {
    if (!this.snapshot || !live || this.pendingRequest || this.sending) return;
    return this.execute({ id: crypto.randomUUID(), sessionId: this.snapshot.session.id, line });
  }
  private async execute(request: WebCommand): Promise<string | undefined> {
    if (this.sending) return 'Another command is still being sent';
    this.sending = true;
    this.errorText = '';
    const key = this.room.key;
    const submittedText = request.line;
    this.pendingRequest = request;
    this.storage.setItem(key + ':pending', JSON.stringify(request));
    if (request.attachmentIds?.length)
      this.storage.setItem(`chittr:${request.sessionId}:image-send`, JSON.stringify(request));
    this.emit();
    try {
      const result = await this.transport.command(request);
      this.lastOutcome = { request, roomKey: key, submission: result.submission };
      const clearPending = () => {
        this.storage.removeItem(key + ':pending');
        if (request.attachmentIds?.length)
          this.storage.removeItem(`chittr:${request.sessionId}:image-send`);
        if (this.room.key === key) this.pendingRequest = undefined;
      };
      if (!result.ok) {
        // A definitive failure, whatever its commitment and recovery facts: the original
        // command error is presented, the facts stay readable in `outcome`, and the local
        // text is kept.
        clearPending();
        throw new Error(result.error);
      }
      const snapshot = request.line.trim() === '/quit' ? undefined : await this.transport.state();
      if (request.draft) this.acknowledge(request, snapshot, key, submittedText);
      if (snapshot) this.accept(snapshot);
      else this.emit({ type: 'room-quit' });
      clearPending();
    } catch (failure) {
      // A transport error or failed state fetch before this point retains the pending request.
      if (this.room.key === key) this.errorText = (failure as Error).message;
      return (failure as Error).message;
    } finally {
      this.sending = false;
      this.emit();
    }
  }
  /**
   * Applies an acknowledged composer submission to local text. An attachment send commits
   * the host draft's clear atomically, so the same-conversation snapshot's composer text is
   * the accepted state (empty, or a draft accepted since) and is adopted along with its
   * references through `accept`; a text-only send, or a snapshot for another conversation,
   * clears matching submitted text to empty instead. Both replacements are guarded by local
   * freshness: stored text only while it still equals the submitted line, in-memory text
   * only while the conversation and the submitted line still match.
   */
  private acknowledge(
    request: WebCommand,
    snapshot: WebState | undefined,
    key: string,
    submittedText: string,
  ) {
    const adoptHost =
      Boolean(request.attachmentIds?.length) &&
      snapshot !== undefined &&
      snapshot.session.id === request.sessionId &&
      snapshot.instanceId === this.room.instanceId &&
      this.room.key === key;
    const replacement = adoptHost ? snapshot.session.composerDraft : '';
    if (this.storage.getItem(key + ':draft') === submittedText)
      this.storage.setItem(key + ':draft', replacement);
    if (
      this.room.key === key &&
      formatReplyDraft(this.textValue, this.replyTarget) === submittedText
    ) {
      const restored = parseReplyDraft(replacement);
      this.textValue = restored.text;
      this.replyTarget = restored.replyTo;
      this.manager?.setText(replacement);
      this.emit({ type: 'text-replaced' });
    }
  }

  // Attachment actions, delegated to the active AttachmentDraft.
  stage(files: File[]): void {
    this.manager?.stage(files);
  }
  retryUpload(item: UploadItem, file?: File): void {
    void this.manager?.retry(item, file);
  }
  removeUpload(item: UploadItem): void {
    this.manager?.removeUpload(item);
  }
  removeAttachment(id: string): void {
    void this.manager?.remove(id);
  }
  retryRemoval(): void {
    const id = this.manager?.removalId;
    if (id) void this.manager?.remove(id);
  }
  dismissAttachmentError(): void {
    if (this.manager) this.manager.error = '';
    this.emit();
  }
}
