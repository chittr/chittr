import type { SessionSummary } from '../store.js';
import { cleanText, clip, InputParser, previousBoundary, type Key } from './input.js';

type Input = Pick<
  NodeJS.ReadStream,
  'isTTY' | 'isRaw' | 'setRawMode' | 'resume' | 'pause' | 'on' | 'off'
>;
type Output = Pick<NodeJS.WriteStream, 'isTTY' | 'columns' | 'rows' | 'write' | 'on' | 'off'>;
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function singleLine(text: string): string {
  return cleanText(text).replace(/\s+/g, ' ').trim();
}

/** Select from this workspace's saved chats before starting any providers. */
export async function pickSession(
  sessions: SessionSummary[],
  workspace: string,
  input: Input = process.stdin,
  output: Output = process.stdout,
): Promise<string | undefined> {
  if (!input.isTTY || !output.isTTY)
    throw new Error('The resume picker requires an interactive terminal.');
  if (!sessions.length) return undefined;
  const entries = sessions.map((session) => ({
    ...session,
    preview: singleLine(session.preview),
    updated: singleLine(new Date(session.updatedAt).toLocaleString()),
  }));
  let query = '',
    selected = 0,
    offset = 0,
    finished = false;
  let escapeTimer: NodeJS.Timeout | undefined;
  let resolve!: (id: string | undefined) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<string | undefined>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const matching = () =>
    entries.filter((entry) =>
      `${entry.preview} ${entry.id}`.toLowerCase().includes(query.toLowerCase()),
    );
  const header = () => {
    const search = `Search: ${query || '(type to filter)'}`;
    if ((output.rows || 24) < 10) return ['Resume a chat', search];
    return [
      'Resume a chat',
      singleLine(workspace),
      '',
      search,
      `${matching().length} of ${entries.length} chats · most recent first`,
      '',
    ];
  };
  const pageSize = () => Math.max(1, (output.rows || 24) - header().length - 2);
  const finish = (id?: string) => {
    if (finished) return;
    finished = true;
    resolve(id);
  };
  const cancel = () => finish();
  const fail = (error: Error) => {
    if (finished) return;
    finished = true;
    reject(error);
  };
  const render = () => {
    if (finished) return;
    try {
      const rows = output.rows || 24,
        width = Math.max(1, (output.columns || 80) - 1);
      const visible = matching(),
        page = pageSize();
      offset = Math.max(0, Math.min(offset, selected, visible.length - page));
      if (selected >= offset + page) offset = selected - page + 1;
      const lines = [
        ...header(),
        ...visible.slice(offset, offset + page).map((entry, index) => {
          const detail =
            width < 72 ? entry.preview : `${entry.updated}  ${entry.count} msgs  ${entry.preview}`;
          const label = `${index + offset === selected ? '›' : ' '} ${detail}`;
          const line = clip(label, width);
          return index + offset === selected ? `\x1b[7m${line}\x1b[0m` : line;
        }),
      ];
      if (!visible.length)
        lines.push('No matching chats. Edit the search or press Ctrl+U to clear.');
      while (lines.length < rows - 1) lines.push('');
      // Reserve the bottom line and one column so repainting never scrolls the terminal.
      const body = lines
        .slice(0, Math.max(0, rows - 1))
        .map((line) => `${clip(line, width)}\x1b[K`);
      body.push(`${clip('↑/↓ select · Enter resume · Esc cancel', width)}\x1b[K`);
      output.write(`\x1b[?25l\x1b[H${body.join('\r\n')}`);
    } catch (error) {
      fail(error as Error);
    }
  };
  const key = (key: Key) => {
    if (finished) return;
    if (['escape', 'ctrl-c', 'ctrl-d'].includes(key.name)) return cancel();
    const visible = matching();
    if (key.name === 'enter') {
      const choice = visible[selected];
      if (choice) finish(choice.id);
      return;
    }
    switch (key.name) {
      case 'up':
        selected--;
        break;
      case 'down':
        selected++;
        break;
      case 'page-up':
        selected -= pageSize();
        break;
      case 'page-down':
        selected += pageSize();
        break;
      case 'home':
        selected = 0;
        break;
      case 'end':
        selected = visible.length - 1;
        break;
      case 'text':
      case 'paste':
        query += cleanText(key.text ?? '').replace(/\s/g, ' ');
        selected = offset = 0;
        break;
      case 'backspace':
        query = query.slice(0, previousBoundary(query, query.length));
        selected = offset = 0;
        break;
      case 'clear-line':
        query = '';
        selected = offset = 0;
        break;
    }
    selected = Math.max(0, Math.min(selected, matching().length - 1));
    render();
  };
  const parser = new InputParser(key);
  const data = (chunk: Buffer) => {
    clearTimeout(escapeTimer);
    parser.feed(chunk);
    if (!finished) escapeTimer = setTimeout(() => parser.flushEscape(), 35);
  };
  const wasRaw = Boolean(input.isRaw);
  try {
    input.setRawMode(true);
    input.on('data', data);
    input.on('end', cancel);
    input.on('error', fail);
    output.on('resize', render);
    output.on('error', fail);
    for (const signal of signals) process.on(signal, cancel);
    output.write('\x1b[?1049h\x1b[?2004h');
    input.resume();
    render();
    return await result;
  } finally {
    clearTimeout(escapeTimer);
    input.off('data', data);
    input.off('end', cancel);
    input.off('error', fail);
    output.off('resize', render);
    output.off('error', fail);
    for (const signal of signals) process.off(signal, cancel);
    try {
      input.setRawMode(wasRaw);
    } catch {
      /* The terminal may have disconnected. */
    }
    input.pause();
    output.write('\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l');
  }
}
