import type { ImagePathSupport } from './image-support.js';
import { resolveComposerRecipients } from './recipient-resolution.js';
import type { Message } from './types.js';

export interface ImageWarningParticipant {
  id: string;
  enabled: boolean;
  initialImageSupport?: ImagePathSupport;
}

export interface ImageWarningGroup {
  status: 'not_observed' | 'unsupported';
  recipients: { id: string; reason: string }[];
}

export interface ImageDraftWarning {
  groups: ImageWarningGroup[];
}

export function imageDraftWarning(input: {
  line: string;
  hasImages: boolean;
  participants: ImageWarningParticipant[];
  messages: Message[];
  invalidRoom?: boolean;
}): ImageDraftWarning | undefined {
  if (!input.hasImages || input.invalidRoom) return undefined;
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
  const recipients = recipientIds.flatMap((id) => {
    const support = enabled.find((participant) => participant.id === id)?.initialImageSupport;
    return support && !support.available ? [{ id, support }] : [];
  });
  const groups = (['not_observed', 'unsupported'] as const).flatMap((status) => {
    const matches = recipients
      .filter((recipient) => recipient.support.status === status)
      .map((recipient) => ({ id: recipient.id, reason: recipient.support.reason }));
    return matches.length ? [{ status, recipients: matches }] : [];
  });
  return groups.length ? { groups } : undefined;
}

export function formatImageDraftWarning(warning: ImageDraftWarning): string {
  return [
    'Image status warning',
    ...warning.groups.map(
      (group) =>
        `${group.status === 'not_observed' ? 'Not observed' : 'Unsupported'}: ${group.recipients
          .map((recipient) => `@${recipient.id}: ${recipient.reason}`)
          .join('; ')}`,
    ),
  ].join(' · ');
}
