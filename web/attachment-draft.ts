import type { AttachmentMetadata } from '../src/types.js';
import { attachmentLimits, attachmentLimitText } from '../src/attachment-limits.js';
import type { PreparedImage } from './image-prepare';

/** The name, size and SHA-256 of the file the user selected. */
export interface UploadSource {
  name: string;
  size: number;
  sha256: string;
}
export interface UploadItem {
  operationId: string;
  /** The uploaded PNG's name and size; the selected file's until it is prepared. */
  filename: string;
  byteSize: number;
  status: 'pending' | 'failed';
  error?: string;
  /** SHA-256 of the uploaded PNG, recorded before its bytes are sent. */
  fingerprint?: string;
  /** Set only when the uploaded PNG was converted from the selected file. */
  source?: UploadSource;
  attachment?: AttachmentMetadata;
  /** The selected file until prepared, then the bytes to upload. This page only. */
  file?: File;
}
export interface DraftHost {
  revision: number;
  attachments: AttachmentMetadata[];
}
export interface DraftTransport {
  /** Returns the PNG to upload for a selected image, converting it when needed. */
  prepare: (file: File) => Promise<PreparedImage>;
  upload: (file: File, operationId: string) => Promise<AttachmentMetadata>;
  save: (
    text: string,
    host?: DraftHost,
    keepalive?: boolean,
  ) => Promise<{ accepted: boolean; revision: number }>;
  refresh: () => Promise<DraftHost>;
  persist: (items: Omit<UploadItem, 'file'>[]) => void;
  changed: () => void;
}

const digest = async (file: Blob) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');

// This controller owns browser work only. Host snapshots own accepted references.
// Upload bytes live in File objects for the lifetime of this page, never in its cache.
export class AttachmentDraft {
  host: DraftHost;
  items: UploadItem[];
  error = '';
  saveStatus = '';
  removalId?: string;
  active = true;
  private tail: Promise<unknown> = Promise.resolve();
  private order: string[];
  private text = '';
  // Decoding and encoding are bounded; waiters start in selection order.
  private conversionSlots = 2;
  private conversionQueue: (() => void)[] = [];
  constructor(
    host: DraftHost,
    private transport: DraftTransport,
    restored: UploadItem[] = [],
  ) {
    this.host = host;
    this.items = restored
      .filter((item) => !host.attachments.some((a) => a.id === item.attachment?.id))
      .map((item) => ({
        ...item,
        status: 'failed',
        error: 'Upload interrupted. Retry or remove this image.',
      }));
    this.order = [...host.attachments.map((a) => a.id), ...this.items.map((a) => a.operationId)];
  }
  private notify() {
    this.transport.persist(this.items.map(({ file: _file, ...item }) => item));
    if (this.active) this.transport.changed();
  }
  reconcile(host: DraftHost) {
    if (host.revision < this.host.revision) return;
    this.host = host;
    const live = new Set([
      ...host.attachments.map((a) => a.id),
      ...this.items.map((a) => a.operationId),
    ]);
    this.order = this.order.filter((id) => live.has(id));
    for (const id of live) if (!this.order.includes(id)) this.order.push(id);
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const task = this.tail.then(action);
    this.tail = task.catch(() => {});
    return task;
  }
  async settled() {
    await this.tail;
  }
  setText(text: string) {
    this.text = text;
  }
  saveText(text: string, keepalive = false) {
    this.setText(text);
    return this.enqueue(async () => {
      if (!this.active || text !== this.text) return;
      const result = await this.transport.save(text, undefined, keepalive);
      if (!result.accepted)
        throw Object.assign(new Error('Draft update was stale. Your local caption is retained.'), {
          status: 409,
        });
      // A contiguous text-only write cannot have changed ownership. A gap can include
      // another writer's attachment update, so refresh before using that revision.
      if (result.revision === this.host.revision + 1)
        this.host = { ...this.host, revision: result.revision };
      else if (result.revision > this.host.revision) this.reconcile(await this.transport.refresh());
      this.saveStatus = '';
    })
      .catch((error: Error & { status?: number }) => {
        if (error.status === 409) this.saveStatus = error.message;
        else
          this.saveStatus =
            'Draft save or refresh could not be confirmed. Your local caption is retained.';
      })
      .finally(() => this.notify());
  }
  private async own(attachments: AttachmentMetadata[]) {
    if (!this.active) throw new Error('Conversation changed. Retry in the original conversation.');
    const result = await this.transport.save(this.text, {
      revision: this.host.revision,
      attachments,
    });
    if (!result.accepted)
      throw new Error('Draft update was stale. Retry after checking the current draft.');
    this.reconcile(await this.transport.refresh());
  }
  stage(files: File[]) {
    for (const file of files) {
      if (this.items.length >= attachmentLimits.imagesPerMessage) {
        this.error =
          'Too many pending files. Resolve or remove the listed items before selecting more.';
        break;
      }
      const item: UploadItem = {
        operationId: crypto.randomUUID(),
        filename: file.name.slice(0, 255),
        byteSize: file.size,
        status: 'pending',
        file,
      };
      this.items.push(item);
      this.order.push(item.operationId);
      // Mirrors the host contract. Acceptance, including pixels/structure, is validated by the host.
      if (this.host.attachments.length + this.items.length > attachmentLimits.imagesPerMessage) {
        item.status = 'failed';
        item.error = `${attachmentLimitText.count}.`;
      } else void this.retry(item);
    }
    this.notify();
  }
  private async converting<T>(work: () => Promise<T>): Promise<T> {
    if (this.conversionSlots) this.conversionSlots--;
    else await new Promise<void>((resolve) => this.conversionQueue.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.conversionQueue.shift();
      if (next) next();
      else this.conversionSlots++;
    }
  }
  /**
   * Prepares the bytes to upload and records their identity before they are sent.
   * A file other than the item's own must be the one originally selected; for a
   * converted image, converting it again must reproduce the recorded output, or
   * the old operation would carry changed content.
   */
  private async prepare(item: UploadItem, file: File): Promise<File> {
    const { selected, prepared, output } = await this.converting(async () => {
      // A reselected file is checked before any conversion; a newly staged one
      // starts converting first, so conversions begin in selection order.
      let selected: string | undefined;
      if (file !== item.file) {
        selected = await digest(file);
        const expected = item.source ?? {
          name: item.filename,
          size: item.byteSize,
          sha256: item.fingerprint,
        };
        if (
          file.name !== expected.name ||
          file.size !== expected.size ||
          (expected.sha256 !== undefined && expected.sha256 !== selected)
        )
          throw new Error('Select the same file, or remove this item to choose a different image.');
      }
      const prepared = await this.transport.prepare(file);
      selected ??= await digest(file);
      return {
        selected,
        prepared,
        output: prepared.converted ? await digest(prepared.file) : selected,
      };
    });
    if (item.fingerprint && output !== item.fingerprint)
      throw new Error(
        'This image converted differently than before. Remove it and attach the image again.',
      );
    item.source = prepared.converted
      ? { name: file.name, size: file.size, sha256: selected }
      : undefined;
    item.filename = prepared.file.name;
    item.byteSize = prepared.file.size;
    item.fingerprint = output;
    item.file = prepared.file;
    this.notify();
    const accepted = new Set(this.host.attachments.map((a) => a.id));
    const bytes =
      this.host.attachments.reduce((n, a) => n + a.byteSize, 0) +
      this.items
        .filter(
          (entry) =>
            entry.status === 'pending' &&
            entry.fingerprint &&
            !(entry.attachment && accepted.has(entry.attachment.id)),
        )
        .reduce((n, a) => n + a.byteSize, 0);
    if (bytes > attachmentLimits.aggregateBytes)
      throw new Error(`${attachmentLimitText.aggregate}.`);
    return prepared.file;
  }
  async retry(item: UploadItem, file = item.file) {
    if (!this.active || !this.items.includes(item)) return;
    item.status = 'pending';
    item.error = undefined;
    this.notify();
    try {
      if (!item.attachment) {
        if (!file) throw new Error('Select the same file to retry this interrupted upload.');
        // An in-page retry sends the prepared bytes again; the host binds them to the operation.
        const upload =
          file === item.file && item.fingerprint ? file : await this.prepare(item, file);
        item.attachment = await this.transport.upload(upload, item.operationId);
        this.notify();
      }
      await this.enqueue(async () => {
        if (!this.active || !this.items.includes(item)) return;
        const byId = new Map(this.host.attachments.map((a) => [a.id, a]));
        byId.set(item.operationId, item.attachment!);
        const ordered = [
          ...new Map(
            this.order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])).map((a) => [a.id, a]),
          ).values(),
        ];
        await this.own(ordered);
        if (!this.items.includes(item)) {
          await this.own(this.host.attachments.filter((a) => a.id !== item.attachment!.id));
          return;
        }
        const index = this.order.indexOf(item.operationId);
        if (index >= 0) this.order[index] = item.attachment!.id;
        this.order = [...new Set(this.order)];
        this.items = this.items.filter((entry) => entry !== item);
      });
    } catch (error) {
      item.status = 'failed';
      item.error = (error as Error).message;
      if (this.active) {
        try {
          this.reconcile(await this.transport.refresh());
        } catch {
          /* Retry stays explicit. */
        }
      }
    }
    this.notify();
  }
  removeUpload(item: UploadItem) {
    this.items = this.items.filter((entry) => entry !== item);
    this.order = this.order.filter((id) => id !== item.operationId);
    if (item.attachment) {
      // Removal can race an ownership save whose acknowledgement is lost. Reconcile
      // after that queued save, then remove only this reference from the current set.
      void this.enqueue(async () => {
        if (!this.active) return;
        this.reconcile(await this.transport.refresh());
        if (this.host.attachments.some((a) => a.id === item.attachment!.id))
          await this.own(this.host.attachments.filter((a) => a.id !== item.attachment!.id));
      })
        .catch((error: Error) => {
          this.removalId = item.attachment!.id;
          this.error = `Image removal was not confirmed: ${error.message}. Check the draft and retry removal.`;
        })
        .finally(() => this.notify());
    }
    this.notify();
  }
  remove(id: string) {
    return this.enqueue(async () => {
      await this.own(this.host.attachments.filter((a) => a.id !== id));
      this.error = '';
      this.removalId = undefined;
    })
      .catch(async (error: Error) => {
        this.removalId = id;
        this.error = `Image removal was not confirmed: ${error.message}`;
        try {
          this.reconcile(await this.transport.refresh());
        } catch {
          /* Keep references. */
        }
      })
      .finally(() => this.notify());
  }
}
