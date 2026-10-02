import type { ImagePathSupport } from './image-support.js';
import { resolveComposerRecipients } from './recipient-resolution.js';
import type { Message } from './types.js';

export interface ImageWarningParticipant {
  id: string;
  enabled: boolean;
  initialImageSupport?: ImagePathSupport;
}

export interface ImageWarningRecipient {
  id: string;
  status: 'not_observed' | 'unsupported';
  reason: string;
}

export interface ImageDraftWarning {
  /** One entry per affected recipient, in send-recipient order. */
  recipients: ImageWarningRecipient[];
}

export interface ImageRecipientInput {
  line: string;
  participants: ImageWarningParticipant[];
  messages: Message[];
  invalidRoom?: boolean;
}

/**
 * The agent recipients the draft line would send images to, by the send recipient
 * rules, with each one's current initial-image support. Undefined when the line
 * would not send with images.
 */
export function imageRecipients(
  input: ImageRecipientInput,
): { id: string; support?: ImagePathSupport }[] | undefined {
  if (input.invalidRoom) return undefined;
  const enabled = input.participants.filter((participant) => participant.enabled);
  let recipientIds: string[];
  try {
    recipientIds = resolveComposerRecipients(
      input.line,
      enabled.map((participant) => participant.id),
      input.messages,
      true,
    ).agentRecipients;
  } catch {
    return undefined;
  }
  return recipientIds.map((id) => ({
    id,
    support: enabled.find((participant) => participant.id === id)?.initialImageSupport,
  }));
}

export function imageDraftWarning(
  input: ImageRecipientInput & { hasImages: boolean },
): ImageDraftWarning | undefined {
  if (!input.hasImages) return undefined;
  const recipients = (imageRecipients(input) ?? []).flatMap(({ id, support }) =>
    support && !support.available ? [{ id, status: support.status, reason: support.reason }] : [],
  );
  return recipients.length ? { recipients } : undefined;
}

/** The one plain line each renderer shows for an affected recipient. */
export function imageWarningLine(recipient: ImageWarningRecipient): string {
  return `@${recipient.id} can't receive images${recipient.status === 'not_observed' ? ' yet' : ''}`;
}

export const imageStatusHint = 'Ctrl+O, /attach --status for details.';

/** Terminal lines: one per affected recipient, then where the full reasons are. */
export function formatImageDraftWarning(warning: ImageDraftWarning): string[] {
  return [...warning.recipients.map(imageWarningLine), imageStatusHint];
}

/** The terminal's `/attach --status` text: every recipient's full image-support reason. */
export function formatImageRecipientStatus(input: ImageRecipientInput): string {
  const recipients = imageRecipients(input);
  if (!recipients)
    return 'The current draft cannot be sent as written, so its image recipients are unknown.';
  if (!recipients.length) return 'The current draft has no agent recipients.';
  return recipients
    .map(({ id, support }) =>
      !support
        ? `@${id}: image support is not reported`
        : support.available
          ? `@${id}: can receive images`
          : `@${id}: ${support.reason}`,
    )
    .join('\n');
}
