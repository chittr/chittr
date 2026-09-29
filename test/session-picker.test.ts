import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { pickSession } from '../src/ui/session-picker.js';
import type { SessionSummary } from '../src/store.js';

class Input extends EventEmitter {
  isTTY = true;
  isRaw = false;
  flowing = false;
  setRawMode(raw: boolean) {
    this.isRaw = raw;
    return this;
  }
  resume() {
    this.flowing = true;
    return this;
  }
  pause() {
    this.flowing = false;
    return this;
  }
  send(text: string) {
    this.emit('data', Buffer.from(text));
  }
}
class Output extends EventEmitter {
  isTTY = true;
  rows = 16;
  columns = 96;
  text = '';
  write(text: string) {
    this.text += text;
    return true;
  }
  frame() {
    return stripAnsi(this.text.split('\x1b[?25l\x1b[H').at(-1)!);
  }
}
function fixture(sessions?: SessionSummary[]) {
  const input = new Input(),
    output = new Output();
  const result = pickSession(
    sessions ??
      Array.from({ length: 30 }, (_, index) => ({
        id: `session-${index}`,
        updatedAt: '2026-09-08T12:00:00Z',
        preview: `Conversation ${index}`,
        count: index + 1,
      })),
    '/project',
    input as never,
    output as never,
  );
  return { input, output, result };
}

it('pages through long histories, clamps navigation, and returns the highlighted chat once', async () => {
  const { input, output, result } = fixture();
  input.send('\x1b[A\x1b[6~');
  expect(output.frame()).toMatch(/› .*Conversation 8/);
  input.send('\x1b[F\x1b[B');
  expect(output.frame()).toMatch(/› .*Conversation 29/);
  input.send('\x1b[5~\x1b[H\x1b[B\rignored draft\r');
  expect(await result).toBe('session-1');
  expect(input.isRaw).toBe(false);
  expect(input.flowing).toBe(false);
  expect(input.listenerCount('data')).toBe(0);
  expect(output.listenerCount('resize')).toBe(0);
  expect(output.text).toContain('\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l');
});
it('filters by preview or ID without submitting pasted newlines, and clears a failed search', async () => {
  const { input, output, result } = fixture();
  input.send('missing\r');
  expect(output.frame()).toContain('No matching chats');
  expect(input.isRaw).toBe(true);
  input.send('\x15\x1b[200~CONVERSATION 2\x1b[201~');
  expect(output.frame()).toContain('11 of 30 chats');
  input.send('\x15\x1b[200~session-12\n\x1b[201~');
  expect(input.isRaw).toBe(true);
  input.send('\x7f\r');
  expect(await result).toBe('session-12');
});
it('handles grapheme backspace, sanitized previews, and resizing without wrapping', async () => {
  const { input, output, result } = fixture([
    {
      id: 'id',
      preview: 'Wide 👩‍💻 chat\x1b[2J\ncontinued',
      count: 2,
      updatedAt: '2026-09-08',
    },
  ]);
  expect(output.text).not.toContain('\x1b[2J');
  expect(output.frame()).toContain('Wide 👩‍💻 chat continued');
  input.send('👩‍💻\x7f');
  expect(output.frame()).toContain('1 of 1 chats');
  output.columns = 24;
  output.rows = 8;
  output.emit('resize');
  expect(output.frame()).toContain('› Wide 👩‍💻 chat');
  const lines = output.frame().split('\r\n');
  expect(lines).toHaveLength(8);
  expect(lines.every((line) => stringWidth(line) <= 23)).toBe(true);
  input.send('\r');
  expect(await result).toBe('id');
});
it.each(['\x1b', '\x03', '\x04'])('cancels and restores terminal state: %j', async (key) => {
  const count = process.listenerCount('SIGINT');
  const { input, result } = fixture();
  input.send(key);
  expect(await result).toBeUndefined();
  expect(input.isRaw).toBe(false);
  expect(process.listenerCount('SIGINT')).toBe(count);
});
it('restores preexisting raw mode and removes listeners on input failure', async () => {
  const input = new Input(),
    output = new Output();
  input.isRaw = true;
  const result = pickSession(
    [{ id: 'id', updatedAt: '2026-09-08', preview: 'chat', count: 0 }],
    '/project',
    input as never,
    output as never,
  );
  input.emit('error', new Error('disconnected'));
  await expect(result).rejects.toThrow('disconnected');
  expect(input.isRaw).toBe(true);
  expect(input.listenerCount('error')).toBe(0);
  expect(output.listenerCount('error')).toBe(0);
});
