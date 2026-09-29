import { describe, expect, it } from 'vitest';
import { AttachmentDraft, type DraftHost, type UploadItem } from '../web/attachment-draft.js';
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
