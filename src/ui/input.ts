import { StringDecoder } from 'node:string_decoder';
import stringWidth from 'string-width';
export type Key = { name: string; text?: string; x?: number; y?: number };
export class InputParser {
  private buffer = '';
  private paste = false;
  private pasted = '';
  private decoder = new StringDecoder('utf8');
  constructor(private emit: (key: Key) => void) {}
  feed(data: Buffer | string): void {
    this.buffer += typeof data === 'string' ? data : this.decoder.write(data);
    while (this.buffer) {
      if (this.paste) {
        const end = this.buffer.indexOf('\x1b[201~');
        if (end < 0) {
          const safe = Math.max(0, this.buffer.length - 6);
          this.pasted += this.buffer.slice(0, safe);
          this.buffer = this.buffer.slice(safe);
          if (this.pasted.length > 1024 * 1024) this.pasted = this.pasted.slice(0, 1024 * 1024);
          return;
        }
        this.pasted += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 6);
        this.paste = false;
        this.emit({
          name: 'paste',
          text: this.pasted.replaceAll('\r\n', '\n').replaceAll('\r', '\n'),
        });
        this.pasted = '';
        continue;
      }
      if (this.buffer.startsWith('\x1b[200~')) {
        this.buffer = this.buffer.slice(6);
        this.paste = true;
        continue;
      }
      if (this.buffer[0] === '\x1b') {
        const ss3 = /^\x1bO([A-DHF])/.exec(this.buffer);
        if (ss3) {
          this.buffer = this.buffer.slice(3);
          this.emit({
            name: (
              { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' } as Record<
                string,
                string
              >
            )[ss3[1]!]!,
          });
          continue;
        }
        if (this.buffer === '\x1bO') return;
        if (this.buffer === '\x1b' || /^\x1b\[[0-?]*[ -/]*$/.test(this.buffer)) return;
        const csi = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(this.buffer);
        if (csi) {
          this.buffer = this.buffer.slice(csi[0].length);
          this.csi(csi[1]!, csi[3]!);
          continue;
        }
        if (this.buffer.startsWith('\x1b\r')) {
          this.buffer = this.buffer.slice(2);
          this.emit({ name: 'newline' });
          continue;
        }
        this.buffer = this.buffer.slice(1);
        this.emit({ name: 'escape' });
        continue;
      }
      const point = String.fromCodePoint(this.buffer.codePointAt(0)!);
      this.buffer = this.buffer.slice(point.length);
      const names: Record<string, string> = {
        '\r': 'enter',
        '\n': 'newline',
        '\x0f': 'attachments',
        '\x7f': 'backspace',
        '\b': 'backspace',
        '\t': 'tab',
        '\x03': 'ctrl-c',
        '\x04': 'ctrl-d',
        '\x01': 'home',
        '\x05': 'end',
        '\x15': 'clear-line',
        '\x16': 'clipboard-paste',
        '\x0c': 'redraw',
      };
      if (names[point]) this.emit({ name: names[point] });
      else if (point >= ' ') this.emit({ name: 'text', text: point });
    }
  }
  flushEscape(): void {
    if (this.buffer === '\x1b') {
      this.buffer = '';
      this.emit({ name: 'escape' });
    }
  }
  private csi(parameters: string, final: string): void {
    // SGR mouse reports, with button-motion tracking (1002) and coordinates (1006).
    if (parameters.startsWith('<')) {
      const mouse = /^<(\d+);(\d+);(\d+)$/.exec(parameters);
      if (mouse && (final === 'M' || final === 'm')) {
        const button = Number(mouse[1]);
        if (button >= 0 && button <= 255 && Number(mouse[2]) > 0 && Number(mouse[3]) > 0) {
          const unmodified = button & ~28;
          if (final === 'M' && unmodified === 64) this.emit({ name: 'scroll-up' });
          if (final === 'M' && unmodified === 65) this.emit({ name: 'scroll-down' });
          if (unmodified === 0 || (final === 'M' && unmodified === 32))
            this.emit({
              name: final === 'm' ? 'mouse-up' : unmodified === 32 ? 'mouse-drag' : 'mouse-down',
              x: Number(mouse[2]) - 1,
              y: Number(mouse[3]) - 1,
            });
        }
      }
      return;
    }
    if (final === 'u' && parameters.startsWith('?')) {
      this.emit({ name: 'keyboard-supported' });
      return;
    }
    if (final === 'u') {
      const [codeString, modifierString] = parameters.split(';');
      if (modifierString?.split(':')[1] === '3') return; // Key release.
      const code = Number(codeString?.split(':')[0]),
        modifier = Number(modifierString?.split(':')[0] ?? 1) - 1;
      if ((modifier & 8) !== 0 || (modifier & 5) === 5) {
        if (code === 99 || code === 67) this.emit({ name: 'copy' });
        else if (code === 118 || code === 86) this.emit({ name: 'clipboard-paste' });
        // Super is Cmd on macOS; do not insert unhandled shortcuts into the draft.
        if ((modifier & 8) !== 0 || code === 99 || code === 67 || code === 118 || code === 86)
          return;
      }
      if (code === 13) {
        this.emit({ name: (modifier & 4) !== 0 ? 'newline' : 'enter' });
        return;
      }
      if ((modifier & 4) !== 0) {
        const control: Record<number, string> = {
          111: 'attachments',
          106: 'newline',
          99: 'ctrl-c',
          100: 'ctrl-d',
          97: 'home',
          101: 'end',
          117: 'clear-line',
          108: 'redraw',
          118: 'clipboard-paste',
        };
        if (control[code]) this.emit({ name: control[code] });
        return;
      }
      const names: Record<number, string> = {
        9: 'tab',
        27: 'escape',
        127: 'backspace',
        57349: 'delete',
        57350: 'left',
        57351: 'right',
        57352: 'up',
        57353: 'down',
        57354: 'page-up',
        57355: 'page-down',
        57356: 'home',
        57357: 'end',
      };
      if (names[code]) this.emit({ name: names[code] });
      else if (code >= 32 && code <= 0x10ffff)
        this.emit({ name: 'text', text: String.fromCodePoint(code) });
      return;
    }
    const arrows: Record<string, string> = {
      A: 'up',
      B: 'down',
      C: 'right',
      D: 'left',
      H: 'home',
      F: 'end',
      Z: 'backtab',
    };
    if (arrows[final]) {
      this.emit({ name: arrows[final] });
      return;
    }
    if (final === '~') {
      if (parameters === '27;5;13') {
        this.emit({ name: 'newline' });
        return;
      }
      const keys: Record<string, string> = {
        '1': 'home',
        '7': 'home',
        '4': 'end',
        '8': 'end',
        '3': 'delete',
        '5': 'page-up',
        '6': 'page-down',
      };
      const code = parameters.split(';')[0]!;
      if (keys[code]) this.emit({ name: keys[code] });
    }
  }
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function previousBoundary(text: string, index: number): number {
  let previous = 0;
  for (const part of segmenter.segment(text)) {
    if (part.index >= index) break;
    previous = part.index;
  }
  return previous;
}
export function nextBoundary(text: string, index: number): number {
  for (const part of segmenter.segment(text)) {
    if (part.index > index) return part.index;
  }
  return text.length;
}
export function cleanText(text: string): string {
  return text
    .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replaceAll('\t', '    ');
}
/** Fit plain text within `width` terminal cells, ending with an ellipsis when cut. */
export function clip(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let result = '',
    cells = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = stringWidth(segment);
    if (cells + size > width - 1) break;
    result += segment;
    cells += size;
  }
  return result + '…';
}
export interface InputRow {
  start: number;
  end: number;
  text: string;
}
export function inputRows(text: string, width: number): InputRow[] {
  const rows: InputRow[] = [];
  let start = 0,
    current = '',
    cells = 0;
  for (const part of segmenter.segment(text)) {
    if (part.segment === '\n') {
      rows.push({ start, end: part.index, text: current });
      start = part.index + 1;
      current = '';
      cells = 0;
      continue;
    }
    const size = stringWidth(part.segment);
    if (cells + size > width && current) {
      rows.push({ start, end: part.index, text: current });
      start = part.index;
      current = '';
      cells = 0;
    }
    current += part.segment;
    cells += size;
  }
  rows.push({ start, end: text.length, text: current });
  if (cells >= width) rows.push({ start: text.length, end: text.length, text: '' });
  return rows;
}
