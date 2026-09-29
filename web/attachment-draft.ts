import type { AttachmentMetadata } from '../src/types.js';

export interface UploadItem {
  operationId: string;
  filename: string;
  byteSize: number;
  status: 'pending' | 'failed';
  error?: string;
  fingerprint?: string;
  attachment?: AttachmentMetadata;
  file?: File;
}
export interface DraftHost {
  revision: number;
  attachments: AttachmentMetadata[];
}
export interface DraftTransport {
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
      if (this.items.length >= 16) {
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
      const bytes =
        this.host.attachments.reduce((n, a) => n + a.byteSize, 0) +
        this.items.reduce((n, a) => n + a.byteSize, 0);
      // Mirrors C2 contract v1. Acceptance, including pixels/structure, is validated by the host.
      if (
        file.type !== 'image/png' ||
        file.size > 1024 * 1024 ||
        this.host.attachments.length + this.items.length > 4 ||
        bytes > 3 * 1024 * 1024
      ) {
        item.status = 'failed';
        item.error = 'Use PNG images up to 1 MiB each, four images and 3 MiB total.';
      } else void this.retry(item);
    }
    this.notify();
  }
  async retry(item: UploadItem, file = item.file) {
    if (!this.active || !this.items.includes(item)) return;
    item.status = 'pending';
    item.error = undefined;
    this.notify();
    try {
      if (!item.attachment) {
        if (!file) throw new Error('Select the same file to retry this interrupted upload.');
        const fingerprint = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
        )
          .map((n) => n.toString(16).padStart(2, '0'))
          .join('');
        if (
          file.name !== item.filename ||
          file.size !== item.byteSize ||
          (item.fingerprint && item.fingerprint !== fingerprint)
        )
          throw new Error('Select the same file, or remove this item to choose a different image.');
        item.fingerprint = fingerprint;
        item.file = file;
        this.notify();
        item.attachment = await this.transport.upload(file, item.operationId);
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
