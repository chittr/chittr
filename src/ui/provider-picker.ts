import type { Provider } from '../providers.js';
import { providers as providerInfo } from '../providers.js';
import { clip, InputParser, type Key } from './input.js';

type Input = Pick<
  NodeJS.ReadStream,
  'isTTY' | 'isRaw' | 'setRawMode' | 'resume' | 'pause' | 'on' | 'off'
>;
type Output = Pick<NodeJS.WriteStream, 'isTTY' | 'columns' | 'write' | 'on' | 'off'>;
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const hint = '↑/↓ move · Space toggle · Enter confirm · Esc cancel';

/**
 * Check off the detected providers to enable by default. Every choice starts checked.
 * Renders inline below the cursor, so earlier setup output stays visible. Resolves the
 * checked providers in display order, or undefined when cancelled.
 */
export async function pickProviders(
  choices: readonly Provider[],
  input: Input = process.stdin,
  output: Output = process.stdout,
): Promise<Provider[] | undefined> {
  if (!input.isTTY || !output.isTTY)
    throw new Error('The provider picker requires an interactive terminal.');
  if (!choices.length) return undefined;
  const checked = new Set(choices);
  let cursor = 0,
    drawn = 0,
    warning = false,
    finished = false;
  let escapeTimer: NodeJS.Timeout | undefined;
  let resolve!: (selected: Provider[] | undefined) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<Provider[] | undefined>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const selection = () => choices.filter((provider) => checked.has(provider));
  // Replace the previous frame in place. Clipping each line to one column short of the
  // terminal width keeps every line on one row, so the cursor moves up a known count.
  // A terminal that reflows on shrink can wrap the old frame and leave stale rows above
  // the redraw; the picker is up for seconds, so that cosmetic case is accepted.
  const draw = (lines: string[], highlight = -1) => {
    const width = Math.max(1, (output.columns || 80) - 1);
    const up = drawn > 1 ? `\x1b[${drawn - 1}A` : '';
    const body = lines.map((line, index) => {
      const clipped = clip(line, width);
      return index === highlight ? `\x1b[1m${clipped}\x1b[0m` : clipped;
    });
    output.write(`${up}\r\x1b[J${body.join('\r\n')}`);
    drawn = lines.length;
  };
  const render = () => {
    if (finished) return;
    try {
      draw(
        [
          'Choose default agents',
          ...choices.map(
            (provider, index) =>
              `${index === cursor ? '›' : ' '} [${checked.has(provider) ? 'x' : ' '}] ${providerInfo[provider].label} (${provider})`,
          ),
          warning ? 'Select at least one agent (Space toggles).' : hint,
        ],
        cursor + 1,
      );
    } catch (error) {
      fail(error as Error);
    }
  };
  // Leave a one-line summary in scrollback, or clear the frame on cancel or failure.
  const settle = (summary?: string) => {
    try {
      draw(summary ? [summary] : []);
      if (summary) output.write('\r\n');
    } catch {
      /* The terminal may have disconnected. */
    }
  };
  const finish = (selected?: Provider[]) => {
    if (finished) return;
    finished = true;
    settle(selected && `Default agents: ${selected.join(', ')}`);
    resolve(selected);
  };
  const cancel = () => finish();
  const fail = (error: Error) => {
    if (finished) return;
    finished = true;
    settle();
    reject(error);
  };
  const key = (key: Key) => {
    if (finished) return;
    if (['escape', 'ctrl-c', 'ctrl-d'].includes(key.name)) return cancel();
    if (key.name === 'enter') {
      const selected = selection();
      if (selected.length) return finish(selected);
      warning = true;
      return render();
    }
    switch (key.name) {
      case 'up':
        cursor--;
        break;
      case 'down':
        cursor++;
        break;
      case 'home':
        cursor = 0;
        break;
      case 'end':
        cursor = choices.length - 1;
        break;
      case 'text': {
        if (key.text !== ' ') return;
        const provider = choices[cursor]!;
        if (!checked.delete(provider)) checked.add(provider);
        warning = false;
        break;
      }
      default:
        return;
    }
    cursor = Math.max(0, Math.min(cursor, choices.length - 1));
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
    // Bracketed paste keeps a pasted space or newline from toggling or confirming.
    output.write('\x1b[?25l\x1b[?2004h');
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
    output.write('\x1b[?2004l\x1b[?25h\x1b[0m');
  }
}
