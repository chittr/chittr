import { createHash } from 'node:crypto';
import {
  AttachmentError,
  attachmentLimits,
  validateAttachmentSet,
  validateImage,
  type AttachmentAccess,
} from './attachments.js';
import type { Message } from './types.js';

/** #51's revised criterion treats roots as an environment projection. The
 * direct filesystem grant and native feature denies are checked separately.
 */
export function codexSessionPolicy(result: any, workspace: string, profile: string) {
  return {
    environmentCount: Array.isArray(result.thread?.environments)
      ? result.thread.environments.length
      : 'unavailable',
    projectedRootCount: Array.isArray(result.runtimeWorkspaceRoots)
      ? result.runtimeWorkspaceRoots.length
      : 'unavailable',
    cwdMatches: result.cwd === workspace,
    namedProfileMatches: result.activePermissionProfile?.id === profile,
    profileExtendsAbsent: result.activePermissionProfile?.extends === null,
    approvalsNever: result.approvalPolicy === 'never',
    reviewerIsUser: result.approvalsReviewer === 'user',
    readOnly: result.sandbox?.type === 'readOnly',
    networkDisabled: result.sandbox?.networkAccess === false,
    zeroEnvironments:
      Array.isArray(result.thread?.environments) && result.thread.environments.length === 0,
    zeroProjectedRoots:
      Array.isArray(result.runtimeWorkspaceRoots) && result.runtimeWorkspaceRoots.length === 0,
  };
}

/** Bound the final wire frame and a JSON-escaped replay with existing headroom.
 * UTF-8 byte length is at least as strict as the incoming character limit.
 */
export function assertCodexFrame(serialized: string): void {
  const size = Math.max(
    Buffer.byteLength(serialized),
    Buffer.byteLength(JSON.stringify(serialized)),
  );
  if (size + 256 * 1024 > attachmentLimits.nativeFrameCharacters)
    throw new AttachmentError('attachment-limit', 'Codex image frame exceeds the transport limit');
}

/** The caller supplies only current required messages, never the history or seed. */
export function codexInitialContent(messages: Message[], access?: AttachmentAccess) {
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> = [];
  let total = 0;
  for (const message of messages) {
    const attachments = message.attachments ?? [];
    validateAttachmentSet(attachments);
    for (const metadata of attachments) {
      if (!access)
        throw new AttachmentError('attachment-not-found', 'Attachment resolver is unavailable');
      const image = access.resolve(metadata.id);
      const dimensions = validateImage(image.bytes, metadata.mediaType);
      if (
        JSON.stringify(image.metadata) !== JSON.stringify(metadata) ||
        image.bytes.length !== metadata.byteSize ||
        dimensions.width !== metadata.width ||
        dimensions.height !== metadata.height ||
        createHash('sha256').update(image.bytes).digest('hex') !== image.sha256
      )
        throw new AttachmentError('attachment-corrupt', 'Attachment content failed validation');
      total += image.bytes.length;
      if (total > attachmentLimits.aggregateBytes)
        throw new AttachmentError('attachment-limit', 'Image batch exceeds the aggregate limit');
      content.push(
        {
          type: 'text',
          text: `Chittr image for message #${message.id}, attachment ${metadata.id}.`,
        },
        { type: 'image', url: `data:image/png;base64,${image.bytes.toString('base64')}` },
      );
    }
  }
  return content;
}
