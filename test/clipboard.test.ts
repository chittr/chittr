import { afterEach, expect, it, vi } from 'vitest';
import { paddedPng } from './image-fixture.js';

// The osascript subprocess is the boundary; the real pasteboard is never read.
const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile,
}));
const { readClipboardImage } = await import('../src/ui/clipboard.js');

/** Answers the next clipboard read with this JSON output and records its options. */
function clipboard(output: object) {
  const calls: { script: string; options: { maxBuffer: number } }[] = [];
  execFile.mockImplementationOnce((_command, args, options, callback) => {
    calls.push({ script: args[3], options });
    callback(null, JSON.stringify(output), '');
  });
  return calls;
}
afterEach(() => execFile.mockReset());

it.runIf(process.platform === 'darwin')(
  'reads a clipboard PNG of exactly 3 MiB and rejects a larger one naming the limit',
  async () => {
    const largest = paddedPng(3 * 1024 * 1024);
    const calls = clipboard({ status: 'ok', base64: largest.toString('base64') });
    const read = await readClipboardImage();
    expect(read.bytes.equals(largest)).toBe(true);
    expect(read.filename).toBe('clipboard.png');
    // The script refuses larger data itself, and the buffer fits the base64 of the largest.
    expect(calls[0]!.script).toContain('Number(data.length) > 3145728');
    expect(calls[0]!.options.maxBuffer).toBeGreaterThanOrEqual(
      largest.toString('base64').length + 2,
    );
    clipboard({ status: 'over-limit' });
    await expect(readClipboardImage()).rejects.toThrow(
      'Clipboard PNG exceeds the 3 MiB per-image limit. Save a PNG and use /attach <path>.',
    );
    clipboard({ status: 'ok', base64: paddedPng(3 * 1024 * 1024 + 1).toString('base64') });
    await expect(readClipboardImage()).rejects.toThrow(
      'Clipboard PNG exceeds the 3 MiB per-image limit. Save a smaller PNG and use /attach <path>.',
    );
  },
);
