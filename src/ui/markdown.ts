import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Nodes, Definition, Table } from 'mdast';
import stringWidth from 'string-width';
import { cleanText } from './input.js';
import type { CopyRow } from './selection.js';

export interface MarkdownRow extends CopyRow {
  /** Sanitized source coordinates, independent of visual wrapping and table widths. */
  source: { block: number; line: number };
}
interface Run {
  text: string;
  style: string;
  line: number;
}
const parser = unified().use(remarkParse).use(remarkGfm);
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const reset = '\x1b[0m';
const strong = '\x1b[1m',
  emphasis = '\x1b[3m',
  code = '\x1b[36m';
const displayText = (text: string) => cleanText(text).replace(/[\x80-\x9f]/g, '');

/** Layout trusted styled text without re-sanitizing it or splitting a grapheme. */
function wrap(runs: Run[], width: number, first = '', rest = first): CopyRow[] {
  // Character references can decode into controls during parsing. Clean those
  // values too, before combining them with application-owned styles.
  runs = runs.map((run) => ({ ...run, text: displayText(run.text) }));
  const text = runs.map((run) => run.text).join('');
  const rows: CopyRow[] = [];
  let runIndex = 0,
    runEnd = runs[0]?.text.length ?? 0;
  let prefix = first,
    cells = stringWidth(prefix),
    body = '',
    style = '';
  const flush = () => {
    rows.push({
      text: prefix + body + (body.includes('\x1b[') ? reset : ''),
      continuation: rows.length > 0,
      contentStart: rows.length ? stringWidth(prefix) : 0,
    });
    prefix = rest;
    cells = stringWidth(prefix);
    body = '';
    style = '';
  };
  for (const part of segmenter.segment(text)) {
    while (part.index >= runEnd && runIndex < runs.length - 1)
      runEnd += runs[++runIndex]!.text.length;
    const size = stringWidth(part.segment);
    if (cells + size > width && body) flush();
    const nextStyle = runs[runIndex]?.style ?? '';
    if (nextStyle !== style) {
      body += (style ? reset : '') + nextStyle;
      style = nextStyle;
    }
    body += part.segment;
    cells += size;
  }
  flush();
  return rows;
}

/** Pure terminal presentation. Source escapes are removed before Markdown is parsed. */
export function markdownRows(source: string, available: number): MarkdownRow[] {
  source = displayText(source);
  const width = Math.max(2, available);
  const tree = parser.parse(source);
  const definitions = new Map<string, Definition>();
  const collect = (node: Nodes): void => {
    if (node.type === 'definition' && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if ('children' in node) node.children.forEach(collect);
  };
  collect(tree);
  const rows: MarkdownRow[] = [];
  const raw = (node: Nodes) => source.slice(node.position?.start.offset, node.position?.end.offset);
  const inline = (nodes: Nodes[], style = ''): Run[] =>
    nodes.flatMap((node): Run[] => {
      const line = node.position?.start.line ?? 1;
      const run = (text: string, ownStyle = style) => [
        { text: displayText(text), style: ownStyle, line },
      ];
      switch (node.type) {
        case 'text':
        case 'html':
          return run(node.value);
        case 'break':
          return run('\n');
        case 'strong':
          return inline(node.children, style + strong);
        case 'emphasis':
          return inline(node.children, style + emphasis);
        case 'delete':
          return inline(node.children, style + '\x1b[9m');
        case 'inlineCode':
          return run(node.value, style + code);
        case 'link':
        case 'linkReference': {
          const label = inline(node.children, style + '\x1b[4m');
          const destination =
            node.type === 'link' ? node.url : definitions.get(node.identifier)?.url;
          if (!destination) return run(raw(node));
          return label
            .map((r) => ({ ...r }))
            .concat(
              label.map((r) => r.text).join('') === destination ? [] : run(` (${destination})`),
            );
        }
        case 'image':
        case 'imageReference':
          return run(`[Image: ${node.alt || 'reference'}]`);
        default:
          return run(raw(node));
      }
    });
  // Leave two cells for a wide grapheme even with deeply nested prefixes.
  const prefixFit = (prefix: string): string => {
    let result = '';
    for (const part of segmenter.segment(prefix)) {
      if (stringWidth(result + part.segment) > width - 2) break;
      result += part.segment;
    }
    return result;
  };
  const emit = (runs: Run[], block: number, first = '', rest = first, lineOverride?: number) => {
    let logical: Run[] = [],
      line = lineOverride ?? runs[0]?.line ?? block;
    let initial = true;
    const finish = () => {
      const a = prefixFit(initial ? first : rest),
        b = prefixFit(rest);
      for (const row of wrap(logical, width, a, b))
        rows.push({ ...row, source: { block, line }, trimStart: true });
      initial = false;
      logical = [];
    };
    for (const run of runs) {
      const parts = run.text.split('\n');
      for (const [i, text] of parts.entries()) {
        if (i) {
          finish();
          line = lineOverride ?? run.line + i;
        } else if (!logical.length && text) line = lineOverride ?? run.line;
        logical.push({ ...run, text });
      }
    }
    finish();
  };
  const table = (node: Table, prefix: string, block: number, first: string) => {
    const values = node.children.map((row) => row.children.map((cell) => inline(cell.children)));
    // GFM permits short rows; streamed rows can also temporarily have extra
    // cells. Fill missing cells and label extras instead of dropping values.
    const columns = Math.max(...values.map((row) => row.length));
    const data = values.map((row, index) =>
      Array.from(
        { length: columns },
        (_, column) =>
          row[column] ?? (index ? [] : [{ text: `Column ${column + 1}`, style: '', line: block }]),
      ),
    );
    const room = width - stringWidth(prefixFit(prefix));
    if (room < columns * 5 + 1) {
      for (const [index, cells] of data.entries()) {
        if (index)
          rows.push({
            text: prefixFit(prefix),
            source: { block, line: node.children[index]!.position!.start.line },
            trimStart: true,
          });
        for (const [column, value] of cells.entries()) {
          const label = index
            ? data[0]![column]!.map((r) => r.text).join('')
            : `Column ${column + 1}`;
          emit(
            [{ text: `${label}: `, style: strong, line: block }, ...value],
            block,
            !index && !column ? first : prefix,
            prefix,
            node.children[index]!.position!.start.line,
          );
        }
      }
      return;
    }
    const desired = Array.from({ length: columns }, (_, column) =>
      Math.max(2, ...data.map((row) => stringWidth(row[column]!.map((r) => r.text).join('')))),
    );
    const budget = room - columns * 3 - 1;
    const sizes = Array.from({ length: columns }, () => 2);
    let remaining = budget - columns * 2;
    while (remaining > 0 && sizes.some((size, i) => size < desired[i]!)) {
      for (let i = 0; i < columns && remaining > 0; i++)
        if (sizes[i]! < desired[i]!) {
          sizes[i]!++;
          remaining--;
        }
    }
    const border =
      prefixFit(prefix) + '+' + sizes.map((size) => '-'.repeat(size + 2)).join('+') + '+';
    const borderRow = (line: number) =>
      rows.push({ text: border, trimStart: true, source: { block, line } });
    rows.push({
      text: prefixFit(first) + border.slice(prefixFit(prefix).length),
      trimStart: true,
      source: { block, line: block },
    });
    for (const [index, cells] of data.entries()) {
      const line = node.children[index]!.position!.start.line;
      const layouts = cells.map((runs, i) => wrap(runs, sizes[i]!));
      const height = Math.max(...layouts.map((layout) => layout.length));
      for (let y = 0; y < height; y++) {
        const values = layouts.map((layout, column) => {
          const value = layout[y]?.text ?? '';
          const padding = sizes[column]! - stringWidth(value);
          const align = node.align?.[column];
          const left =
            align === 'right' ? padding : align === 'center' ? Math.floor(padding / 2) : 0;
          return ' ' + ' '.repeat(left) + value + ' '.repeat(padding - left) + ' ';
        });
        rows.push({
          text: prefixFit(prefix) + '|' + values.join('|') + '|',
          trimStart: true,
          source: { block, line },
        });
      }
      if (!index || index === data.length - 1) borderRow(line);
    }
  };
  const blocks = (
    nodes: Nodes[],
    prefix = '',
    firstPrefix = prefix,
    parentBlock?: number,
  ): void => {
    let previous: Nodes | undefined;
    for (const node of nodes) {
      const start = node.position?.start.line ?? 1;
      const block = parentBlock ?? start;
      if (previous && start > (previous.position?.end.line ?? start) + 1)
        rows.push({ text: prefixFit(prefix), source: { block, line: start - 1 }, trimStart: true });
      const first = previous ? prefix : firstPrefix;
      switch (node.type) {
        case 'paragraph':
        case 'heading':
          emit(
            inline(node.children, node.type === 'heading' ? strong + '\x1b[96m' : ''),
            block,
            first,
            prefix,
          );
          break;
        case 'blockquote':
          blocks(node.children, prefix + '> ', first + '> ', block);
          break;
        case 'list':
          node.children.forEach((item, i) => {
            const marker = node.ordered ? `${(node.start ?? 1) + i}. ` : '• ';
            const check = item.checked == null ? '' : item.checked ? '[x] ' : '[ ] ';
            blocks(
              item.children,
              prefix + ' '.repeat(marker.length + check.length),
              (i ? prefix : first) + marker + check,
              parentBlock ?? item.position?.start.line,
            );
          });
          break;
        case 'code': {
          if (node.lang)
            emit([{ text: node.lang, style: '\x1b[90m', line: start }], block, first, prefix);
          const fenced = /^\s*(?:`{3,}|~{3,})/.test(raw(node));
          emit(
            node.value.split('\n').flatMap((text, i) => [
              {
                text: (i ? '\n' : '') + text,
                style: code,
                line: start + (fenced ? 1 : 0) + Math.max(0, i - 1),
              },
            ]),
            block,
            node.lang ? prefix : first,
            prefix,
          );
          break;
        }
        case 'table':
          table(node, prefix, block, first);
          break;
        case 'thematicBreak':
          emit(
            [
              {
                text: '─'.repeat(Math.max(1, width - stringWidth(prefixFit(prefix)))),
                style: '\x1b[90m',
                line: start,
              },
            ],
            block,
            first,
            prefix,
          );
          break;
        case 'definition':
          break;
        default:
          emit([{ text: raw(node), style: '', line: start }], block, first, prefix);
      }
      previous = node;
    }
  };
  blocks(tree.children);
  return rows;
}
