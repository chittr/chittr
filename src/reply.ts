/** Reply drafts use the same command in saved sessions and either interface. */
export function parseReplyDraft(value: string): { text: string; replyTo?: string } {
  const match = /^\/reply\s+#?(m[1-9]\d*)(?:\s+([\s\S]*))?$/.exec(value);
  return match ? { replyTo: match[1]!, text: match[2] ?? '' } : { text: value };
}

export function formatReplyDraft(text: string, replyTo?: string): string {
  return replyTo ? `/reply #${replyTo} ${text}` : text;
}
