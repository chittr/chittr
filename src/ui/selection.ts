import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';

export interface CopyRow {
  text: string;
  /** A visual wrap, rather than a newline in the original text. */
  continuation?: boolean;
  /** Display-only padding to omit on subsequent rows, and on the first when trimStart is set. */
  contentStart?: number;
  /** Markdown body/draft rows omit padding even when the selection starts there. */
  trimStart?: boolean;
}
export interface Cell {
  x: number;
  y: number;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Snap both ends to whole graphemes, including clicks in a wide glyph's second cell. */
function span(text: string, left: number, right: number): [number, number] {
  let column = 0;
  let start = text.length;
  let end = text.length;
  for (const part of graphemes.segment(text)) {
    const next = column + stringWidth(part.segment);
    if (next > left && start === text.length) start = part.index;
    if (column >= right) {
      end = part.index;
      break;
    }
    column = next;
  }
  return [Math.min(start, end), end];
}

/** A snapshot keeps incoming output from moving the text underneath a drag. */
export class TextSelection {
  readonly rows: CopyRow[];
  end: Cell;
  dragging = true;
  status = 'Drag to select · release to copy';
  constructor(
    rows: CopyRow[],
    readonly start: Cell,
  ) {
    this.rows = rows.map((row) => ({ ...row, text: stripAnsi(row.text) }));
    this.end = start;
  }
  get moved(): boolean {
    return this.start.x !== this.end.x || this.start.y !== this.end.y;
  }
  private bounds(y: number): [number, number] | undefined {
    if (!this.moved) return;
    const [first, last] =
      this.start.y < this.end.y || (this.start.y === this.end.y && this.start.x <= this.end.x)
        ? [this.start, this.end]
        : [this.end, this.start];
    if (y < first.y || y > last.y) return;
    return [y === first.y ? first.x : 0, y === last.y ? last.x + 1 : Infinity];
  }
  text(): string {
    let result = '';
    let previous: number | undefined;
    for (const [y, row] of this.rows.entries()) {
      const bounds = this.bounds(y);
      if (!bounds) continue;
      const joins = previous === y - 1 && row.continuation;
      const left =
        previous === undefined && !row.trimStart
          ? bounds[0]
          : Math.max(bounds[0], row.contentStart ?? 0);
      const [start, end] = span(row.text, left, bounds[1]);
      if (previous !== undefined && !joins) result += '\n';
      result += row.text.slice(start, end);
      previous = y;
    }
    return result;
  }
  highlight(y: number, styled: string): string {
    const bounds = this.bounds(y);
    if (!bounds) return styled;
    const text = this.rows[y]?.text ?? '';
    const [start, end] = span(text, ...bounds);
    if (start === end) return styled;
    return `\x1b[0m${text.slice(0, start)}\x1b[30;103m${text.slice(start, end)}\x1b[0m${text.slice(end)}`;
  }
}
