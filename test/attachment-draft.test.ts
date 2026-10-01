import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { AttachmentDraft, type DraftHost, type UploadItem } from '../web/attachment-draft.js';
import type { PreparedImage } from '../web/image-prepare.js';
import type { AttachmentMetadata } from '../src/types.js';
const metadata = (name: string): AttachmentMetadata => ({
  id: name,
  filename: name,
  width: 1,
  height: 1,
  byteSize: 1,
  mediaType: 'image/png',
});
const file = (name: string) => new File(['a'], name, { type: 'image/png' });
function fixture() {
  let host: DraftHost = { revision: 0, attachments: [] };
  let cache: Omit<UploadItem, 'file'>[] = [];
  const uploads = new Map<string, (value: AttachmentMetadata) => void>();
  const draft = new AttachmentDraft(host, {
    prepare: async (f) => ({ file: f, converted: false }),
    upload: (f) => new Promise((resolve) => uploads.set(f.name, resolve)),
    save: async (_text, update) => {
      if (update && update.revision !== host.revision) throw new Error('Draft changed');
      host = { revision: host.revision + 1, attachments: update?.attachments ?? host.attachments };
      return { accepted: true, revision: host.revision };
    },
    refresh: async () => host,
    persist: (items) => {
      cache = items;
    },
    changed: () => {},
  });
  return { draft, uploads, cache: () => cache, host: () => host };
}
describe('browser attachment draft boundary', () => {
  it('keeps selection order across out-of-order completion and excludes removed uploads', async () => {
    const f = fixture();
    f.draft.stage([file('first'), file('second'), file('removed')]);
    await expect.poll(() => f.uploads.size).toBe(3);
    f.draft.removeUpload(f.draft.items[2]!);
    f.uploads.get('second')!(metadata('second'));
    await expect.poll(() => f.host().attachments.map((a) => a.id)).toEqual(['second']);
    f.uploads.get('removed')!(metadata('removed'));
    f.uploads.get('first')!(metadata('first'));
    await expect.poll(() => f.host().attachments.map((a) => a.id)).toEqual(['first', 'second']);
    expect(f.cache()).toEqual([]);
  });
  it('discards delayed results after deactivation and persists identity without file bytes', async () => {
    const f = fixture();
    f.draft.stage([file('late')]);
    await expect.poll(() => f.uploads.size).toBe(1);
    expect(f.cache()[0]).toMatchObject({ filename: 'late', status: 'pending' });
    expect(f.cache()[0]).not.toHaveProperty('file');
    f.draft.active = false;
    f.uploads.get('late')!(metadata('late'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.host().attachments).toEqual([]);
  });
});

it('avoids full snapshots for contiguous text saves but refreshes ownership after a revision gap', async () => {
  let host: DraftHost = { revision: 1, attachments: [metadata('another-client')] };
  let refreshes = 0;
  const draft = new AttachmentDraft(
    { revision: 0, attachments: [] },
    {
      prepare: async (file) => ({ file, converted: false }),
      upload: async () => metadata('unused'),
      save: async () => ({ revision: ++host.revision, accepted: true }),
      refresh: async () => {
        refreshes++;
        return { ...host };
      },
      persist: () => {},
      changed: () => {},
    },
  );
  await draft.saveText('Preserve other client ownership');
  expect(draft.host.attachments).toEqual([metadata('another-client')]);
  expect(refreshes).toBe(1);
  await draft.saveText('A contiguous caption edit');
  expect(draft.host.revision).toBe(3);
  expect(refreshes).toBe(1);
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
/** A draft whose conversion and upload steps are scripted per test. */
function converting(
  prepare: (file: File) => Promise<PreparedImage>,
  upload: (file: File, operationId: string) => Promise<AttachmentMetadata>,
  restored: UploadItem[] = [],
  attachments: AttachmentMetadata[] = [],
) {
  let host: DraftHost = { revision: 0, attachments };
  let cache: Omit<UploadItem, 'file'>[] = [];
  const draft = new AttachmentDraft(
    host,
    {
      prepare,
      upload,
      save: async (_text, update) => {
        host = {
          revision: host.revision + 1,
          attachments: update?.attachments ?? host.attachments,
        };
        return { accepted: true, revision: host.revision };
      },
      refresh: async () => host,
      persist: (items) => {
        cache = structuredClone(items);
      },
      changed: () => {},
    },
    restored,
  );
  return { draft, cache: () => cache, host: () => host };
}

it('admits a 20-image selection and prepares it in selection order, two at a time', async () => {
  const started: string[] = [];
  const conversions = new Map<string, ReturnType<typeof deferred<PreparedImage>>>();
  let running = 0,
    most = 0;
  const f = converting(
    (file) => {
      started.push(file.name);
      most = Math.max(most, ++running);
      const pending = deferred<PreparedImage>();
      conversions.set(file.name, pending);
      return pending.promise.finally(() => running--);
    },
    async (file) => metadata(file.name),
  );
  const names = Array.from({ length: 21 }, (_, index) => `image-${index}.png`);
  f.draft.stage(names.map(file));
  expect(f.draft.items.map((item) => item.filename)).toEqual(names.slice(0, 20));
  expect(f.draft.error).toContain('Too many pending files');
  for (const name of names.slice(0, 20)) {
    await expect.poll(() => conversions.has(name)).toBe(true);
    conversions.get(name)!.resolve({ file: file(name), converted: false });
  }
  await expect.poll(() => f.host().attachments.length).toBe(20);
  expect(started).toEqual(names.slice(0, 20));
  expect(most).toBe(2);
  expect(f.host().attachments.map((a) => a.id)).toEqual(names.slice(0, 20));
});

it('retries a converted upload in the page with the bytes it first sent', async () => {
  const sent: { file: File; operationId: string }[] = [];
  let conversions = 0;
  const converted = new File(['converted'], 'photo.png', { type: 'image/png' });
  const f = converting(
    async () => {
      conversions++;
      return { file: converted, converted: true };
    },
    async (upload, operationId) => {
      sent.push({ file: upload, operationId });
      if (sent.length === 1) throw new Error('Failed to fetch');
      return metadata('photo.png');
    },
  );
  f.draft.stage([new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' })]);
  await expect.poll(() => f.draft.items[0]?.status).toBe('failed');
  const [item] = f.draft.items;
  expect(item).toMatchObject({
    filename: 'photo.png',
    byteSize: 9,
    fingerprint: sha256('converted'),
    source: { name: 'photo.jpg', size: 4, sha256: sha256('jpeg') },
  });
  await f.draft.retry(item!);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.file).toBe(sent[0]!.file);
  expect(sent[1]!.operationId).toBe(sent[0]!.operationId);
  expect(conversions).toBe(1);
  expect(f.host().attachments.map((a) => a.id)).toEqual(['photo.png']);
});

it('recovers a converted upload after reload only when reconverting the original reproduces it', async () => {
  const original = () => new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' });
  let output = 'converted';
  const prepare = async () => ({
    file: new File([output], 'photo.png', { type: 'image/png' }),
    converted: true,
  });
  const first = converting(prepare, () => Promise.reject(new Error('Failed to fetch')));
  first.draft.stage([original()]);
  await expect.poll(() => first.draft.items[0]?.status).toBe('failed');
  // Persisted state names both identities and holds no bytes.
  const saved = first.cache();
  expect(saved).toEqual([
    expect.objectContaining({
      filename: 'photo.png',
      byteSize: 9,
      fingerprint: sha256('converted'),
      source: { name: 'photo.jpg', size: 4, sha256: sha256('jpeg') },
    }),
  ]);
  expect(saved[0]).not.toHaveProperty('file');
  const operationId = saved[0]!.operationId;

  const sent: { bytes: string; operationId: string }[] = [];
  const upload = async (file: File, id: string) => {
    sent.push({ bytes: await file.text(), operationId: id });
    return metadata('recovered');
  };
  // A different file, or the same name with other content, is refused before conversion.
  const wrong = converting(prepare, upload, structuredClone(saved));
  for (const other of [
    new File(['jpeg'], 'other.jpg'),
    new File(['JPEG'], 'photo.jpg', { type: 'image/jpeg' }),
  ]) {
    await wrong.draft.retry(wrong.draft.items[0]!, other);
    expect(wrong.draft.items[0]!.error).toContain('Select the same file');
  }
  // The same original whose conversion now differs fails without a new operation.
  output = 'different';
  const changed = converting(prepare, upload, structuredClone(saved));
  await changed.draft.retry(changed.draft.items[0]!, original());
  expect(changed.draft.items[0]).toMatchObject({
    status: 'failed',
    error: 'This image converted differently than before. Remove it and attach the image again.',
    operationId,
  });
  expect(sent).toEqual([]);
  // The same original converting to the recorded bytes resumes the same operation.
  output = 'converted';
  const recovered = converting(prepare, upload, structuredClone(saved));
  await recovered.draft.retry(recovered.draft.items[0]!, original());
  expect(sent).toEqual([{ bytes: 'converted', operationId }]);
  expect(recovered.host().attachments.map((a) => a.id)).toEqual(['recovered']);
  expect(recovered.draft.items).toEqual([]);
});

it('fails a prepared image that would pass the per-message byte limit and names it', async () => {
  const uploads: string[] = [];
  const held = { ...metadata('held'), byteSize: 5 * 1024 * 1024 };
  const f = converting(
    async (selected) => ({
      file: new File([new Uint8Array(2 * 1024 * 1024)], selected.name, { type: 'image/png' }),
      converted: true,
    }),
    async (upload) => {
      uploads.push(upload.name);
      return metadata(upload.name);
    },
    [],
    [held],
  );
  f.draft.stage([new File(['jpeg'], 'big.png', { type: 'image/png' })]);
  await expect.poll(() => f.draft.items[0]?.status).toBe('failed');
  expect(f.draft.items[0]!.error).toBe('Images exceed the 6 MiB per-message limit.');
  expect(uploads).toEqual([]);
});
