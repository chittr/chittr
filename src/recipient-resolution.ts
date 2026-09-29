import type { Message } from './types.js';
import { parseReplyDraft } from './reply.js';

export interface ResolvedMessageRecipients {
  /** The compact recipient representation persisted on the message. Empty means broadcast. */
  recipients: string[];
  /** The enabled agent delivery set after broadcast and @human handling. */
  agentRecipients: string[];
  text: string;
  parent?: Message;
}

export function parseAddress(
  text: string,
  names: string[],
  allowEmpty = false,
): { recipients: string[]; text: string } {
  const recipients: string[] = [];
  let rest = text.trim();
  while (rest.startsWith('@')) {
    const match = /^@([a-z][a-z0-9_-]*)(?:\s+|$)/.exec(rest);
    if (!match)
      throw new Error('Use leading @names followed by a space. Your draft has not been sent.');
    const name = match[1]!;
    if (!['human', ...names].includes(name))
      throw new Error(`Unknown recipient @${name}. Your draft has not been sent.`);
    if (!recipients.includes(name)) recipients.push(name);
    rest = rest.slice(match[0].length).trimStart();
  }
  if (!rest.trim() && !allowEmpty) throw new Error('Enter a message after the recipients');
  return { recipients, text: rest };
}

export function resolveMessageRecipients(
  raw: string,
  enabledNames: string[],
  messages: Message[],
  replyTo?: string,
  allowEmpty = false,
): ResolvedMessageRecipients {
  const addressed = parseAddress(raw, enabledNames, allowEmpty);
  const parent =
    replyTo === undefined
      ? undefined
      : messages.find((message) => message.id === replyTo.replace(/^#/, ''));
  if (replyTo !== undefined && !parent)
    throw new Error(
      `Unknown reply target #${replyTo.replace(/^#/, '')}. Your draft has not been sent.`,
    );
  const recipients =
    addressed.recipients.length || !parent
      ? addressed.recipients
      : parent.author === 'human'
        ? parent.recipients
        : [parent.author];
  const unavailable = recipients.find((id) => id !== 'human' && !enabledNames.includes(id));
  if (unavailable)
    throw new Error(
      `@${unavailable} is no longer enabled. Use leading @names to choose a reply recipient.`,
    );
  return {
    recipients,
    agentRecipients: recipients.length
      ? recipients.filter((id) => id !== 'human')
      : [...enabledNames],
    text: addressed.text,
    parent,
  };
}

/** Resolve a browser or terminal composer value exactly as RoomController.execute will. */
export function resolveComposerRecipients(
  line: string,
  enabledNames: string[],
  messages: Message[],
  hasImages: boolean,
): ResolvedMessageRecipients {
  if (!line.startsWith('/') || line.startsWith('//'))
    return resolveMessageRecipients(
      line.startsWith('//') ? line.slice(1) : line,
      enabledNames,
      messages,
      undefined,
      hasImages,
    );
  const command = line.trim().split(/\s+/, 1)[0];
  if (command !== '/reply') throw new Error('Attachments can accompany messages and /reply only');
  const reply = parseReplyDraft(line);
  if (!reply.replyTo || (!reply.text.trim() && !hasImages))
    throw new Error('Usage: /reply #message-id [@agent ...] message');
  return resolveMessageRecipients(reply.text, enabledNames, messages, reply.replyTo, hasImages);
}
