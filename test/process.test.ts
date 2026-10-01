import { afterEach, expect, it, vi } from 'vitest';
import { JsonLineSplitter, JsonLinesProcess, providerEventBytes } from '../src/process.js';

const processes: JsonLinesProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of processes.splice(0)) await child.close();
});

/** A real child process whose stdout is the given script's output. */
function provider(script: string) {
  const child = new JsonLinesProcess(process.execPath, ['-e', script], process.cwd(), process.env);
  processes.push(child);
  const messages: unknown[] = [];
  const notices: string[] = [];
  child.on('message', (message) => messages.push(message));
  child.on('notice', (notice) => notices.push(notice));
  const disconnected = new Promise<Error>((resolve) => child.once('disconnect', resolve));
  return { child, messages, notices, disconnected };
}

it('fails an unterminated provider line at the cap without buffering past it', async () => {
  expect(providerEventBytes).toBe(64 * 1024 * 1024);
  const buffered: number[] = [];
  const chunks: number[] = [];
  const push = JsonLineSplitter.prototype.push;
  vi.spyOn(JsonLineSplitter.prototype, 'push').mockImplementation(function (
    this: JsonLineSplitter,
    chunk,
    line,
  ) {
    chunks.push(chunk.length);
    try {
      push.call(this, chunk, line);
    } finally {
      buffered.push(this.bufferedBytes);
    }
  });
  // 65 MiB without a newline, then the process stays alive and never sends one.
  const { child, messages, disconnected } = provider(`
    const chunk = Buffer.alloc(1024 * 1024, 120);
    let sent = 0;
    const write = () => {
      while (sent < 65) {
        sent++;
        if (!process.stdout.write(chunk)) return process.stdout.once('drain', write);
      }
    };
    write();
    setInterval(() => {}, 1000);
  `);
  const error = await disconnected;
  expect(error.message).toBe('Oversized provider event');
  expect(child.closed).toBe(true);
  // The failure came from the cap, before any newline or process exit.
  expect(child.child.exitCode).toBeNull();
  expect(messages).toEqual([]);
  expect(Math.max(...buffered)).toBeLessThanOrEqual(providerEventBytes);
  expect(Math.max(...buffered)).toBeLessThanOrEqual(providerEventBytes + Math.max(...chunks));
  expect(buffered.at(-1)).toBe(0);
}, 30000);

it('dispatches large, CRLF, split UTF-8 and final unterminated lines and notices malformed ones', async () => {
  const large = 'y'.repeat(20 * 1024 * 1024);
  const { messages, notices, disconnected } = provider(`
    const out = process.stdout;
    const utf8 = Buffer.from(JSON.stringify({ kind: 'utf8', text: 'é界🙂' }) + '\\n');
    const steps = [
      () => out.write(JSON.stringify({ kind: 'large', text: 'y'.repeat(${large.length}) }) + '\\n'),
      () => out.write(JSON.stringify({ kind: 'crlf' }) + '\\r\\n'),
      // Split inside the two-byte é so neither chunk is valid UTF-8 alone.
      () => out.write(utf8.subarray(0, 24)),
      () => out.write(utf8.subarray(24)),
      () => out.write('{not json}\\n'),
      () => out.end(JSON.stringify({ kind: 'final' })),
    ];
    const next = () => {
      const step = steps.shift();
      if (step) { step(); setTimeout(next, 20); }
    };
    next();
  `);
  await disconnected;
  expect(messages.map((message: any) => message.kind)).toEqual(['large', 'crlf', 'utf8', 'final']);
  expect((messages[0] as any).text).toBe(large);
  expect((messages[2] as any).text).toBe('é界🙂');
  expect(notices).toEqual(['Ignored a malformed provider event']);
}, 30000);

it('splits bytes into lines, keeps lines that complete before an overflow, and bounds buffering', () => {
  const splitter = new JsonLineSplitter(8);
  const lines: string[] = [];
  const take = (text: string) => lines.push(text);
  splitter.push(Buffer.from('ab\r\ncd'), take);
  expect(lines).toEqual(['ab']);
  expect(splitter.bufferedBytes).toBe(2);
  const euro = Buffer.from('€');
  splitter.push(euro.subarray(0, 1), take);
  splitter.push(Buffer.concat([euro.subarray(1), Buffer.from('\n\nlast')]), take);
  expect(lines).toEqual(['ab', 'cd€', '']);
  splitter.end(take);
  expect(lines).toEqual(['ab', 'cd€', '', 'last']);
  splitter.end(take);
  expect(lines).toHaveLength(4);
  // A complete line before the overflow is still handed over; the rest is dropped.
  expect(() => splitter.push(Buffer.from('ok\n123456789'), take)).toThrow(
    'Oversized provider event',
  );
  expect(lines.at(-1)).toBe('ok');
  expect(splitter.bufferedBytes).toBe(0);
  // A terminated line over the cap fails the same way.
  expect(() => splitter.push(Buffer.from('12345'), take)).not.toThrow();
  expect(() => splitter.push(Buffer.from('6789\n'), take)).toThrow('Oversized provider event');
  expect(splitter.bufferedBytes).toBe(0);
});
