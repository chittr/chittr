import { execFile } from 'node:child_process';

export interface Clipboard {
  write(text: string): Promise<void>;
  read(): Promise<string>;
}

function pasteboard(command: 'pbcopy' | 'pbpaste', input?: string): Promise<string> {
  if (process.platform !== 'darwin')
    return Promise.reject(new Error('Clipboard controls currently require macOS.'));
  return new Promise((resolve, reject) => {
    const child = execFile(
      `/usr/bin/${command}`,
      [],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
        timeout: 3000,
        maxBuffer: 65536,
      },
      (error, stdout) => {
        if (error) reject(new Error(`${command} failed: ${error.message}`));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(input);
  });
}

export const systemClipboard: Clipboard = {
  async write(text) {
    await pasteboard('pbcopy', text);
  },
  read: () => pasteboard('pbpaste'),
};

// OS-shipped JXA + AppKit. Only public.png is accepted; no conversion or helper dependency.
export async function readClipboardImage(
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; filename: string }> {
  if (process.platform !== 'darwin')
    throw new Error('Image clipboard requires macOS. Save a PNG and use /attach <path>.');
  const { attachmentLimits } = await import('../attachments.js');
  const limit = attachmentLimits.perImageBytes;
  const script = `ObjC.import('AppKit');
    const board = $.NSPasteboard.generalPasteboard;
    const types = ObjC.deepUnwrap(board.types) || [];
    if (!types.length) JSON.stringify({status:'empty'});
    else if (types.indexOf('public.png') < 0) JSON.stringify({status:types.some(t => /png|tiff|jpeg|image|heic/.test(t)) ? 'unsupported-image' : 'text-only'});
    else {
      const data = board.dataForType('public.png');
      if (!data || data.isNil()) JSON.stringify({status:'failed'});
      else if (Number(data.length) > ${limit}) JSON.stringify({status:'over-limit'});
      else JSON.stringify({status:'ok',base64:ObjC.unwrap(data.base64EncodedStringWithOptions(0))});
    }`;
  let output: string;
  try {
    output = await new Promise<string>((resolve, reject) => {
      execFile(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', script],
        {
          encoding: 'utf8',
          timeout: 3000,
          maxBuffer: Math.ceil(limit / 3) * 4 + 4096,
          signal,
        },
        (error, stdout, stderr) => {
          if (error)
            reject(
              new Error(
                /not authorized|not permitted|denied|-1743/i.test(stderr)
                  ? 'Clipboard access denied.'
                  : 'Image clipboard read failed or timed out.',
              ),
            );
          else resolve(stdout);
        },
      );
    });
  } catch (error) {
    throw new Error(`${(error as Error).message} Save a PNG and use /attach <path>.`);
  }
  let result: { status: string; base64?: string };
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error('Image clipboard returned invalid output. Save a PNG and use /attach <path>.');
  }
  const messages: Record<string, string> = {
    empty: 'Clipboard is empty.',
    'text-only': 'Clipboard has no image; ordinary text paste is unchanged.',
    'unsupported-image': 'Clipboard image is not PNG.',
    'over-limit': 'Clipboard PNG exceeds 1 MiB.',
    failed: 'Clipboard image could not be read.',
  };
  if (result.status !== 'ok' || typeof result.base64 !== 'string')
    throw new Error(
      `${messages[result.status] ?? 'Image clipboard unavailable.'} Save a PNG and use /attach <path>.`,
    );
  const bytes = Buffer.from(result.base64, 'base64');
  if (bytes.length > limit)
    throw new Error('Clipboard PNG exceeds 1 MiB. Save a smaller PNG and use /attach <path>.');
  return { bytes, filename: 'clipboard.png' };
}
