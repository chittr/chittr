import type { Message } from './types.js';
import { formatReplyDraft } from './reply.js';

/** Sent human messages, oldest first, with the unsent draft after the newest. */
export class ComposerHistory {
  private entries?: string[];
  private index = 0;
  private draft = '';

  get browsing(): boolean {
    return this.entries !== undefined;
  }

  reset(): void {
    this.entries = undefined;
    this.index = 0;
    this.draft = '';
  }

  move(direction: -1 | 1, messages: readonly Message[], draft: string): string | undefined {
    if (!this.entries) {
      if (direction === 1) return;
      const entries = messages
        .filter((message) => message.author === 'human')
        .map((message) => {
          const text = [...message.recipients.map((id) => '@' + id), message.text].join(' ');
          return message.replyTo[0]
            ? formatReplyDraft(text, message.replyTo[0])
            : text.startsWith('/')
              ? '/' + text
              : text;
        });
      if (!entries.length) return;
      // Keep incoming messages from shifting the position while browsing.
      this.entries = entries;
      this.index = entries.length;
      this.draft = draft;
    }
    const next = this.index + direction;
    if (next < 0) return;
    if (next === this.entries.length) {
      const restored = this.draft;
      this.reset();
      return restored;
    }
    this.index = next;
    return this.entries[next];
  }
}
