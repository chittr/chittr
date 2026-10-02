import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { inflateSync } from 'node:zlib';
import type { AttachmentMetadata, Message } from './types.js';
import { attachmentLimits, attachmentLimitText } from './attachment-limits.js';
import { providerEventBytes } from './process.js';

export { attachmentLimits, attachmentLimitText } from './attachment-limits.js';

const sessionIdentity = z.string().uuid();
const operationIdentity = z.string().uuid();
const attachmentIdentity = z.string().regex(/^att-[\da-f]{32}$/);
const hashIdentity = z.string().regex(/^[\da-f]{64}$/);
export const attachmentMetadataSchema = z
  .object({
    id: attachmentIdentity,
    filename: z.string().min(1).max(255),
    mediaType: z.enum(attachmentLimits.acceptedMediaTypes),
    byteSize: z.number().int().positive().max(attachmentLimits.perImageBytes),
    width: z.number().int().positive().max(attachmentLimits.maximumDimension),
    height: z.number().int().positive().max(attachmentLimits.maximumDimension),
  })
  .strict()
  .refine((value) => value.width * value.height <= attachmentLimits.maximumPixels);

const attachmentEntrySchema = z
  .object({
    metadata: attachmentMetadataSchema,
    sha256: hashIdentity,
    stagedAt: z.iso.datetime(),
    orphanedAt: z.iso.datetime().optional(),
  })
  .strict();
const attachmentIndexSchema = z
  .object({
    version: z.literal(1),
    attachments: z.record(attachmentIdentity, attachmentEntrySchema),
    operations: z.record(
      operationIdentity,
      z.object({ inputHash: hashIdentity, attachmentId: attachmentIdentity }).strict(),
    ),
  })
  .strict();
type AttachmentIndex = z.infer<typeof attachmentIndexSchema>;

export type AttachmentErrorCode =
  | 'attachment-conflict'
  | 'attachment-corrupt'
  | 'attachment-limit'
  | 'attachment-not-found'
  | 'attachment-unsupported'
  | 'attachment-invalid';

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface StageAttachmentInput {
  sessionId: string;
  operationId: string;
  filename: string;
  mediaType: string;
  bytes: Buffer;
}

export interface ResolvedAttachment {
  metadata: AttachmentMetadata;
  sha256: string;
  bytes: Buffer;
}

export interface AttachmentResolverSettings {
  directory: string;
  sessionId: string;
}

export const attachmentResolverSettingsSchema = z
  .object({ directory: z.string().min(1), sessionId: sessionIdentity })
  .strict();

export interface AttachmentAccess {
  settings: AttachmentResolverSettings;
  resolve(id: string): ResolvedAttachment;
}

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function atomicFile(path: string, bytes: Buffer | string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function cleanFilename(value: string): string {
  const filename = basename(value.replace(/\\/g, '/')).normalize('NFC').trim();
  if (!filename || /[\u0000-\u001f\u007f]/.test(filename) || Buffer.byteLength(filename) > 255)
    throw new AttachmentError('attachment-invalid', 'Use a display filename of at most 255 bytes');
  return filename;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  const allowedDepths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !allowedDepths[colorType]?.includes(bitDepth) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] !== 0
  )
    return;
  let offset = 8;
  let ended = false;
  let first = true;
  let palette = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (first && type !== 'IHDR') return;
    if (!first && type === 'IHDR') return;
    const dataEnd = offset + 8 + length;
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) return;
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, dataEnd));
    if (type === 'PLTE') palette = true;
    offset += length + 12;
    first = false;
    if (type === 'IEND') {
      ended = length === 0 && offset === bytes.length;
      break;
    }
  }
  if (!ended || !compressed.length || (colorType === 3 && !palette)) return;
  try {
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]!;
    const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
    const expected = height * (rowBytes + 1);
    const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
    if (pixels.length !== expected) return;
    for (let row = 0; row < height; row++) if (pixels[row * (rowBytes + 1)]! > 4) return;
  } catch {
    return;
  }
  return { width, height };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validateImage(
  bytes: Buffer,
  declaredMediaType: string,
): { mediaType: AttachmentMetadata['mediaType']; width: number; height: number } {
  if (!bytes.length) throw new AttachmentError('attachment-invalid', 'Image content is empty');
  if (bytes.length > attachmentLimits.perImageBytes)
    throw new AttachmentError('attachment-limit', attachmentLimitText.perImage);
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (
      !width ||
      !height ||
      width > attachmentLimits.maximumDimension ||
      height > attachmentLimits.maximumDimension ||
      width * height > attachmentLimits.maximumPixels
    )
      throw new AttachmentError(
        'attachment-limit',
        'Image dimensions exceed the attachment limits',
      );
  }
  const dimensions = pngDimensions(bytes);
  if (!dimensions)
    throw new AttachmentError('attachment-unsupported', 'Only complete PNG images are supported');
  const actual = 'image/png' as const;
  if (declaredMediaType !== actual)
    throw new AttachmentError('attachment-invalid', 'Declared media type does not match the image');
  if (
    !dimensions.width ||
    !dimensions.height ||
    dimensions.width > attachmentLimits.maximumDimension ||
    dimensions.height > attachmentLimits.maximumDimension ||
    dimensions.width * dimensions.height > attachmentLimits.maximumPixels
  )
    throw new AttachmentError('attachment-limit', 'Image dimensions exceed the attachment limits');
  return { mediaType: actual, ...dimensions };
}

export function validateAttachmentSet(values: AttachmentMetadata[]): void {
  if (values.length > attachmentLimits.imagesPerMessage)
    throw new AttachmentError('attachment-limit', attachmentLimitText.count);
  if (new Set(values.map((value) => value.id)).size !== values.length)
    throw new AttachmentError('attachment-invalid', 'Attachment IDs must be unique and ordered');
  for (const value of values) attachmentMetadataSchema.parse(value);
  if (values.reduce((sum, value) => sum + value.byteSize, 0) > attachmentLimits.aggregateBytes)
    throw new AttachmentError('attachment-limit', attachmentLimitText.aggregate);
}

export class AttachmentStore {
  constructor(readonly directory: string) {}

  access(sessionId: string): AttachmentAccess {
    sessionIdentity.parse(sessionId);
    const settings = { directory: this.directory, sessionId };
    return { settings, resolve: (id) => this.resolve(settings, id) };
  }

  stage(input: StageAttachmentInput): AttachmentMetadata {
    this.cleanup();
    const sessionId = sessionIdentity.parse(input.sessionId);
    const operationId = operationIdentity.parse(input.operationId);
    const filename = cleanFilename(input.filename);
    const dimensions = validateImage(input.bytes, input.mediaType);
    const sha256 = hash(input.bytes);
    const inputHash = hash(
      JSON.stringify({
        filename,
        mediaType: dimensions.mediaType,
        byteSize: input.bytes.length,
        sha256,
      }),
    );
    const folder = this.attachmentFolder(sessionId);
    const blobFolder = join(folder, 'blobs');
    mkdirSync(blobFolder, { recursive: true, mode: 0o700 });
    const index = this.readIndex(sessionId);
    const previous = index.operations[operationId];
    if (previous) {
      if (previous.inputHash !== inputHash)
        throw new AttachmentError(
          'attachment-conflict',
          'Upload operation ID was already used for different input',
        );
      return this.resolve({ directory: this.directory, sessionId }, previous.attachmentId).metadata;
    }
    if (Object.keys(index.attachments).length >= attachmentLimits.maximumSessionAttachments)
      throw new AttachmentError(
        'attachment-limit',
        'This session has reached its attachment limit',
      );
    const id = `att-${randomBytes(16).toString('hex')}`;
    const metadata: AttachmentMetadata = {
      id,
      filename,
      mediaType: dimensions.mediaType,
      byteSize: input.bytes.length,
      width: dimensions.width,
      height: dimensions.height,
    };
    const blob = join(blobFolder, `${sha256}.bin`);
    if (existsSync(blob)) {
      const existing = readFileSync(blob);
      if (existing.length !== input.bytes.length || hash(existing) !== sha256) {
        unlinkSync(blob);
        atomicFile(blob, input.bytes);
      }
    } else atomicFile(blob, input.bytes);
    const stagedAt = new Date().toISOString();
    index.attachments[id] = { metadata, sha256, stagedAt, orphanedAt: stagedAt };
    index.operations[operationId] = { inputHash, attachmentId: id };
    this.writeIndex(sessionId, index);
    return metadata;
  }

  resolve(settings: AttachmentResolverSettings, id: string): ResolvedAttachment {
    const sessionId = sessionIdentity.parse(settings.sessionId);
    if (settings.directory !== this.directory)
      throw new AttachmentError('attachment-invalid', 'Attachment resolver settings do not match');
    attachmentIdentity.parse(id);
    const entry = this.readIndex(sessionId).attachments[id];
    if (!entry)
      throw new AttachmentError('attachment-not-found', 'Attachment was not found in this session');
    const blob = join(this.attachmentFolder(sessionId), 'blobs', `${entry.sha256}.bin`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(blob);
    } catch {
      throw new AttachmentError('attachment-corrupt', 'Attachment bytes are missing');
    }
    if (bytes.length !== entry.metadata.byteSize || hash(bytes) !== entry.sha256)
      throw new AttachmentError(
        'attachment-corrupt',
        'Attachment bytes failed their integrity check',
      );
    return { metadata: structuredClone(entry.metadata), sha256: entry.sha256, bytes };
  }

  reconcile(
    sessionId: string,
    messages: Message[],
    draft: AttachmentMetadata[],
    now = Date.now(),
  ): void {
    sessionIdentity.parse(sessionId);
    const index = this.readIndex(sessionId);
    const live = new Set([
      ...messages.flatMap((message) => message.attachments?.map((item) => item.id) ?? []),
      ...draft.map((item) => item.id),
    ]);
    let changed = false;
    for (const [id, entry] of Object.entries(index.attachments)) {
      if (live.has(id)) {
        if (entry.orphanedAt) {
          delete entry.orphanedAt;
          changed = true;
        }
      } else if (!entry.orphanedAt) {
        entry.orphanedAt = new Date(now).toISOString();
        changed = true;
      }
    }
    if (changed) this.writeIndex(sessionId, index);
  }

  cleanup(now = Date.now()): { attachments: number; blobs: number; temporary: number } {
    const removed = { attachments: 0, blobs: 0, temporary: 0 };
    if (!existsSync(this.directory)) return removed;
    for (const sessionId of readdirSync(this.directory).filter(
      (name) => sessionIdentity.safeParse(name).success,
    )) {
      const folder = this.attachmentFolder(sessionId);
      if (!existsSync(folder)) continue;
      let index: AttachmentIndex;
      try {
        index = this.readIndex(sessionId);
        const saved = JSON.parse(
          readFileSync(join(this.directory, sessionId, 'session.json'), 'utf8'),
        );
        this.reconcile(
          sessionId,
          Array.isArray(saved.messages) ? saved.messages : [],
          Array.isArray(saved.composerAttachments) ? saved.composerAttachments : [],
          now,
        );
        index = this.readIndex(sessionId);
      } catch {
        // An unreadable session is retained intact; cleanup must fail safe.
        continue;
      }
      for (const [id, entry] of Object.entries(index.attachments)) {
        if (
          entry.orphanedAt &&
          now - Date.parse(entry.orphanedAt) >= attachmentLimits.abandonedMilliseconds
        ) {
          delete index.attachments[id];
          removed.attachments++;
        }
      }
      for (const [operationId, operation] of Object.entries(index.operations))
        if (!index.attachments[operation.attachmentId]) delete index.operations[operationId];
      this.writeIndex(sessionId, index);
      const retained = new Set(
        Object.values(index.attachments).map((entry) => `${entry.sha256}.bin`),
      );
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (
          name.endsWith('.tmp') &&
          now - statSync(path).mtimeMs >= attachmentLimits.interruptedWriteMilliseconds
        ) {
          unlinkSync(path);
          removed.temporary++;
        }
      }
      const blobFolder = join(folder, 'blobs');
      if (!existsSync(blobFolder)) continue;
      for (const name of readdirSync(blobFolder)) {
        const path = join(blobFolder, name);
        const age = now - statSync(path).mtimeMs;
        if (name.endsWith('.tmp')) {
          if (age >= attachmentLimits.interruptedWriteMilliseconds) {
            unlinkSync(path);
            removed.temporary++;
          }
        } else if (!retained.has(name) && age >= attachmentLimits.abandonedMilliseconds) {
          unlinkSync(path);
          removed.blobs++;
        }
      }
    }
    return removed;
  }

  private attachmentFolder(sessionId: string): string {
    return join(this.directory, sessionId, 'attachments');
  }

  private readIndex(sessionId: string): AttachmentIndex {
    const path = join(this.attachmentFolder(sessionId), 'index.json');
    if (!existsSync(path)) return { version: 1, attachments: {}, operations: {} };
    try {
      return attachmentIndexSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      throw new AttachmentError('attachment-corrupt', 'Attachment index is invalid');
    }
  }

  private writeIndex(sessionId: string, index: AttachmentIndex): void {
    const folder = this.attachmentFolder(sessionId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    atomicFile(join(folder, 'index.json'), JSON.stringify(attachmentIndexSchema.parse(index)));
  }
}

export class FileAttachmentResolver implements AttachmentAccess {
  readonly settings: AttachmentResolverSettings;
  private store: AttachmentStore;
  constructor(settings: AttachmentResolverSettings) {
    this.settings = attachmentResolverSettingsSchema.parse(settings);
    this.store = new AttachmentStore(settings.directory);
  }
  resolve(id: string): ResolvedAttachment {
    return this.store.resolve(this.settings, id);
  }
}

export function grokInitialContent(messages: Message[], access?: AttachmentAccess): object[] {
  const attached = messages.flatMap((message) =>
    (message.attachments ?? []).map((metadata) => ({ message, metadata })),
  );
  if (!attached.length) return [];
  if (!access)
    throw new AttachmentError('attachment-not-found', 'Attachment resolver is unavailable');
  const content = attached.flatMap(({ message, metadata }) => {
    const resolved = access.resolve(metadata.id);
    if (JSON.stringify(resolved.metadata) !== JSON.stringify(metadata))
      throw new AttachmentError(
        'attachment-corrupt',
        'Attachment metadata failed its integrity check',
      );
    return [
      {
        type: 'text',
        text: `Chittr image for message #${message.id}, attachment ${metadata.id}.`,
      },
      {
        type: 'image',
        mimeType: metadata.mediaType,
        data: resolved.bytes.toString('base64'),
      },
    ];
  });
  if (Buffer.byteLength(JSON.stringify(content)) > providerEventBytes - 256 * 1024)
    throw new AttachmentError('attachment-limit', 'Images exceed the provider frame limit');
  return content;
}
