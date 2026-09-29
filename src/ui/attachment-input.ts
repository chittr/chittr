import { constants } from 'node:fs';
import { open, realpath, stat, opendir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { attachmentLimits } from '../attachments.js';
import type { AttachmentMetadata } from '../types.js';

export const attachmentHelp = [
  'Ctrl+O opens attachment actions; Enter runs an action, never sends. Esc cancels ingestion.',
  'Once a draft update is dispatched, Esc dismisses the input; its result is still shown.',
  '/attach <path> · /attach --list · /attach --remove <full-id> · /attach --clipboard',
  'Tab completes actions, paths and staged IDs. PNG only; 1 MiB each, four images, 3 MiB total.',
  'Use an absolute or launch-relative path. Spaces are literal; JSON quotes preserve exact names.',
  'Example: /attach "./images/photo one.png". Use /attach -- <path> for option-like names.',
  'No ~/ expansion or shell escaping. If image clipboard is unavailable, save a PNG and /attach its path.',
].join('\n');
export type AttachmentAction =
  | { kind: 'path'; path: string }
  | { kind: 'list' }
  | { kind: 'clipboard' }
  | { kind: 'help' }
  | { kind: 'remove'; id: string };

export function parseAttachmentAction(line: string): AttachmentAction {
  if (line.trim() === '/help' || line.trim() === '/attach') return { kind: 'help' };
  const match = /^\/attach\s+([\s\S]*)$/.exec(line);
  if (!match) throw new Error('Use /attach <path>, --list, --remove <id> or --clipboard.');
  let rest = match[1]!.trim();
  if (rest === '--list') return { kind: 'list' };
  if (rest === '--clipboard') return { kind: 'clipboard' };
  if (/^--remove(?:\s|$)/.test(rest)) {
    const id = rest.slice(8).trim();
    if (!/^att-[a-f0-9]{32}$/.test(id))
      throw new Error('Use the full staged attachment ID with --remove.');
    return { kind: 'remove', id };
  }
  if (/^--(?:\s|$)/.test(rest)) rest = rest.slice(2).trim();
  let path: unknown = rest;
  if (rest.startsWith('"')) {
    try {
      path = JSON.parse(rest);
    } catch {
      throw new Error('Use a complete JSON-quoted path, e.g. /attach "./photo one.png".');
    }
  } else if (rest.startsWith('~/') || /\\\s/.test(rest)) {
    throw new Error(
      'No ~/ expansion or shell escaping. Use an absolute or launch-relative JSON-quoted path, e.g. /attach "./photo one.png".',
    );
  }
  if (typeof path !== 'string' || !path || path.includes('\0'))
    throw new Error('Select a nonempty image pathname.');
  return { kind: 'path', path };
}

/** Only imported by the trusted terminal client. Never accepts browser origin claims. */
export async function readAttachmentPath(
  path: string,
  launchDirectory: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let handle;
  try {
    const selected = resolve(launchDirectory, path);
    const target = await realpath(selected);
    signal?.throwIfAborted();
    // NONBLOCK prevents a selected FIFO (including replacement races) hanging open.
    handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('Select a regular PNG file.');
    if (before.size > BigInt(attachmentLimits.perImageBytes))
      throw new Error('Image exceeds the 1 MiB limit.');
    const buffer = Buffer.alloc(attachmentLimits.perImageBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        length,
        Math.min(65536, buffer.length - length),
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > attachmentLimits.perImageBytes) throw new Error('Image exceeds the 1 MiB limit.');
    const after = await handle.stat({ bigint: true });
    const current = await stat(selected, { bigint: true });
    if (
      before.size !== BigInt(length) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    )
      throw new Error('Image changed while reading; select it again.');
    signal?.throwIfAborted();
    return { bytes: buffer.subarray(0, length), filename: basename(selected) };
  } catch (error) {
    if (signal?.aborted) throw new Error('Attachment action cancelled.');
    const code = (error as NodeJS.ErrnoException).code;
    // Do not retain source paths in notices, transcript JSON or errors.
    if (code)
      throw new Error(
        `Could not read selected image (${code}); select a readable regular PNG file.`,
      );
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Full-line JSON-quoted insertions round-trip through the literal parser, including symlinks. */
export async function completeAttachmentAction(
  line: string,
  launchDirectory: string,
  attachments: AttachmentMetadata[],
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  if (!line.includes(' ')) return ['/attach ', '/help'].filter((item) => item.startsWith(line));
  if (line.startsWith('/attach --remove '))
    return attachments.map((a) => `/attach --remove ${a.id}`).filter((s) => s.startsWith(line));
  const options = ['/attach --list', '/attach --remove ', '/attach --clipboard'];
  if (line.startsWith('/attach -') && !line.startsWith('/attach -- '))
    return options.filter((s) => s.startsWith(line));
  if (!line.startsWith('/attach ')) return [];
  let prefix = line.slice(8).trimStart();
  if (prefix.startsWith('-- ')) prefix = prefix.slice(3).trimStart();
  if (prefix.startsWith('"')) {
    try {
      prefix = JSON.parse(prefix);
    } catch {
      try {
        prefix = JSON.parse(prefix + '"');
      } catch {
        return [];
      }
    }
  } else if (prefix.startsWith('~/') || /\\\s/.test(prefix)) return [];
  const directory = prefix.endsWith('/') ? prefix : dirname(prefix || '.');
  const stem = prefix.endsWith('/') ? '' : basename(prefix);
  const matches: string[] = [];
  try {
    const entries = await opendir(resolve(launchDirectory, directory));
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (
        !entry.name.startsWith(stem) ||
        (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink())
      )
        continue;
      // Retain symlinks as explicit selections. Reading resolves and validates the handle.
      const path =
        (prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '') +
        entry.name +
        (entry.isDirectory() ? '/' : '');
      matches.push('/attach ' + JSON.stringify(path));
      if (matches.length >= 200) break;
    }
  } catch {
    return [];
  }
  return matches.sort();
}

export function attachmentLabel(a: AttachmentMetadata): string {
  // JSON escapes controls, bidi formatting and line separators stay visibly escaped too.
  const filename = JSON.stringify(a.filename).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${a.id} · ${filename} · ${a.mediaType} · ${a.width}×${a.height} · ${a.byteSize} bytes`;
}
