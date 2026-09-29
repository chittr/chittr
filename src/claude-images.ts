import { createHash } from 'node:crypto';
import {
  AttachmentError,
  attachmentLimits,
  validateAttachmentSet,
  validateImage,
  type AttachmentAccess,
} from './attachments.js';
import type { Message } from './types.js';

export const nativeEnvelopeHeadroom = 256 * 1024;

/** UTF-8 bytes conservatively bound the reader's JavaScript character count.
 * Claude replays initial content once and MCP image results twice. Counting a
 * JSON-string-escaped copy too bounds text/metadata re-encoding in that replay.
 * The installed representation and envelope allowance require exact-build evidence.
 */
export function assertClaudeFrame(value: unknown, copies: 1 | 2): void {
  const json = JSON.stringify(value);
  const size = Math.max(Buffer.byteLength(json), Buffer.byteLength(JSON.stringify(json)));
  if (copies * size + nativeEnvelopeHeadroom > attachmentLimits.nativeFrameCharacters)
    throw new AttachmentError(
      'attachment-limit',
      'Claude image frame or replay exceeds the transport limit',
    );
}

/** Only required delivery messages enter this native boundary, never history/context. */
export function claudeInitialContent(messages: Message[], access?: AttachmentAccess) {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }
  > = [];
  let total = 0;
  for (const message of messages) {
    const attachments = message.attachments ?? [];
    validateAttachmentSet(attachments);
    for (const metadata of attachments) {
      if (!access)
        throw new AttachmentError('attachment-not-found', 'Attachment resolver is unavailable');
      const resolved = access.resolve(metadata.id);
      const dimensions = validateImage(resolved.bytes, metadata.mediaType);
      if (
        JSON.stringify(resolved.metadata) !== JSON.stringify(metadata) ||
        resolved.bytes.length !== metadata.byteSize ||
        dimensions.width !== metadata.width ||
        dimensions.height !== metadata.height ||
        createHash('sha256').update(resolved.bytes).digest('hex') !== resolved.sha256
      )
        throw new AttachmentError('attachment-corrupt', 'Attachment content failed validation');
      total += resolved.bytes.length;
      if (total > attachmentLimits.aggregateBytes)
        throw new AttachmentError('attachment-limit', 'Image batch exceeds the aggregate limit');
      content.push(
        {
          type: 'text',
          text: `Chittr image for message #${message.id}, attachment ${metadata.id}.`,
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: metadata.mediaType,
            data: resolved.bytes.toString('base64'),
          },
        },
      );
    }
  }
  return content;
}
