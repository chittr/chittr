import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { pickProviders } from '../src/ui/provider-picker.js';
import type { Provider } from '../src/providers.js';

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
  columns = 96;
  text = '';
  write(text: string) {
    this.text += text;
    return true;
  }
  frame() {
    return stripAnsi(this.text.split('\r\x1b[J').at(-1)!);
  }
}
function fixture(choices: Provider[] = ['codex', 'claude', 'grok']) {
  const input = new Input(),
    output = new Output();
  const result = pickProviders(choices, input as never, output as never);
  return { input, output, result };
}

it('starts with every detected provider checked and confirms them in display order', async () => {
  const { input, output, result } = fixture();
  expect(output.frame().split('\r\n')).toEqual([
    'Choose default agents',
    '› [x] Codex CLI (codex)',
    '  [x] Claude Code (claude)',
    '  [x] Grok Build (grok)',
    '↑/↓ move · Space toggle · Enter confirm · Esc cancel',
  ]);
  input.send('\r');
  expect(await result).toEqual(['codex', 'claude', 'grok']);
  expect(output.frame()).toBe('Default agents: codex, claude, grok\r\n');
  expect(input.isRaw).toBe(false);
  expect(input.flowing).toBe(false);
  expect(input.listenerCount('data')).toBe(0);
  expect(output.listenerCount('resize')).toBe(0);
  expect(output.text).toMatch(/\x1b\[\?2004l\x1b\[\?25h\x1b\[0m$/);
});
it('moves with arrows, clamps at both ends, and toggles with Space', async () => {
  const { input, output, result } = fixture();
  input.send('\x1b[A');
  expect(output.frame()).toContain('› [x] Codex CLI');
  input.send(' \x1b[B\x1b[B\x1b[B');
  expect(output.frame()).toContain('  [ ] Codex CLI');
  expect(output.frame()).toContain('› [x] Grok Build');
  input.send(' \x1b[H \x1b[F');
  expect(output.frame()).toContain('› [ ] Grok Build');
  input.send('\r');
  expect(await result).toEqual(['codex', 'claude']);
});
it('redraws over the previous frame instead of appending a new one', async () => {
  const { input, output, result } = fixture();
  input.send('\x1b[B');
  // Five lines drawn, so the next frame moves up four rows before clearing.
  expect(output.text).toContain('\x1b[4A\r\x1b[J');
  input.send('\x03');
  await result;
});
it('keeps the picker open and explains why when Enter is pressed with nothing checked', async () => {
  const { input, output, result } = fixture(['codex', 'claude']);
  input.send(' \x1b[B \r');
  expect(output.frame()).toContain('Select at least one agent (Space toggles).');
  expect(input.isRaw).toBe(true);
  input.send(' ');
  expect(output.frame()).toContain('Enter confirm');
  input.send('\r');
  expect(await result).toEqual(['claude']);
});
it('ignores pasted text and keys it does not bind', async () => {
  const { input, output, result } = fixture(['codex']);
  input.send('\x1b[200~ \r\x1b[201~x\t\x7f');
  expect(output.frame()).toContain('› [x] Codex CLI');
  expect(input.isRaw).toBe(true);
  input.send('\r');
  expect(await result).toEqual(['codex']);
});
it('clips the list and the confirmed summary to the terminal width on resize', async () => {
  const { input, output, result } = fixture(['codex', 'claude', 'grok']);
  output.columns = 20;
  output.emit('resize');
  const lines = output.frame().split('\r\n');
  expect(lines).toHaveLength(5);
  expect(lines.every((line) => stringWidth(line) <= 19)).toBe(true);
  input.send('\r');
  await result;
  const summary = output.frame().replace(/\r\n$/, '');
  expect(summary).toMatch(/^Default agents: .*…$/);
  expect(stringWidth(summary)).toBeLessThanOrEqual(19);
});
it.each(['\x1b', '\x03', '\x04'])(
  'cancels, clears the frame and restores terminal state: %j',
  async (key) => {
    const count = process.listenerCount('SIGINT');
    const { input, output, result } = fixture();
    input.send(key);
    expect(await result).toBeUndefined();
    expect(output.frame()).toBe('');
    expect(input.isRaw).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(count);
  },
);
it('cancels when stdin ends', async () => {
  const { input, output, result } = fixture();
  input.emit('end');
  expect(await result).toBeUndefined();
  expect(output.frame()).toBe('');
});
it('restores preexisting raw mode and removes listeners on input failure', async () => {
  const input = new Input(),
    output = new Output();
  input.isRaw = true;
  const result = pickProviders(['codex'], input as never, output as never);
  input.emit('error', new Error('disconnected'));
  await expect(result).rejects.toThrow('disconnected');
  // The frame is cleared so the caller's error message starts on a clean line.
  expect(output.frame()).toBe('');
  expect(input.isRaw).toBe(true);
  expect(input.listenerCount('error')).toBe(0);
  expect(output.listenerCount('error')).toBe(0);
});
it('refuses to run without an interactive terminal', async () => {
  const input = new Input();
  input.isTTY = false;
  await expect(pickProviders(['codex'], input as never, new Output() as never)).rejects.toThrow(
    'requires an interactive terminal',
  );
});
