import { expect, it } from 'vitest';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { markdownRows } from '../src/ui/markdown.js';
import { TextSelection } from '../src/ui/selection.js';

const plain = (source: string, width = 78) =>
  markdownRows(source, width).map((r) => stripAnsi(r.text));
function copy(source: string, width = 78) {
  const rows = markdownRows(source, width).map((row) => ({
    ...row,
    text: '  ' + row.text,
    contentStart: 2 + (row.contentStart ?? 0),
    padding: row.padding?.map(({ start, end }) => ({ start: start + 2, end: end + 2 })),
  }));
  const selection = new TextSelection(rows, { x: 0, y: 0 });
  selection.end = { x: width + 2, y: rows.length - 1 };
  return selection.text();
}

it('renders common Markdown with independently closed styles, literal HTML and text references', () => {
  const source =
    '# Heading\n\n**bold** *italic* `inline`\nnext line\n\n- first\n  - nested\n\n3. third\n\n> quote\n\n```ts\n  const x = 1;\n```\n\n[label](https://example.com) ![alt](remote) ![](remote)\n\n<b>literal</b>';
  const rows = markdownRows(source, 78);
  expect(rows.map((r) => stripAnsi(r.text)).join('\n')).toBe(
    'Heading\n\nbold italic inline\nnext line\n\n• first\n  • nested\n\n3. third\n\n> quote\n\nts\n  const x = 1;\n\nlabel (https://example.com) [Image: alt] [Image: reference]\n\n<b>literal</b>',
  );
  expect(rows[0]!.text).toContain('\x1b[1m');
  expect(rows.find((r) => r.text.includes('italic'))!.text).toContain('\x1b[3m');
  expect(rows.find((r) => r.text.includes('const'))!.text).toContain('\x1b[36m');
  for (const row of rows)
    if (row.text.includes('\x1b[')) expect(row.text.endsWith('\x1b[0m')).toBe(true);
  expect(plain('[https://example.com](https://example.com)')).toEqual(['https://example.com']);
  expect(plain('[ref][x]\n\n[x]: https://example.com')).toContain('ref (https://example.com)');
});

it.each([18, 78])(
  'fits prose, nested lists, code, wide graphemes and tables in %s cells',
  (width) => {
    const token = '界👩‍💻e\u0301'.repeat(18);
    const source = `**${token}**\n\n- outer\n  - ${token}\n\n\`\`\`js\n    ${token}\n\`\`\`\n\n| Name | Value |\n| --- | --- |\n| wide | ${token} |`;
    const rows = markdownRows(source, width);
    for (const row of rows) {
      expect(stringWidth(row.text)).toBeLessThanOrEqual(width);
      const text = stripAnsi(row.text);
      expect(text).not.toMatch(/(?<!👩)\u200d|(?<!e)\u0301/);
    }
    expect(copy(`**${token}**`, width)).toBe(token);
    expect(copy(`\`\`\`\n    ${token}\n\`\`\``, width)).toBe('    ' + token);
    const styled = markdownRows(`**${token}**`, width);
    for (const row of styled) {
      expect(row.text.startsWith('\x1b[1m')).toBe(true);
      expect(row.text.endsWith('\x1b[0m')).toBe(true);
    }
    expect(rows.map((r) => stripAnsi(r.text)).join('\n')).toContain('Name');
    expect(rows.map((r) => stripAnsi(r.text)).join('\n')).toContain('wide');
  },
);

it('copies paragraph newlines, blanks, wrapped quote/list prefixes and sanitized code indentation', () => {
  expect(copy('**abcdefghi**\nsecond\n\nthird', 6)).toBe('abcdefghi\nsecond\n\nthird');
  expect(copy('> alphabeta', 7)).toBe('> alphabeta');
  expect(copy('- alphabeta', 7)).toBe('• alphabeta');
  expect(copy('```\n\t  abcdefghij\nnext\n```', 8)).toBe('      abcdefghij\nnext');
  expect(copy('*unclosed', 20)).toBe('*unclosed');
  expect(copy('```python\n  unfinished')).toBe('python\n  unfinished');
});

it('copies table display rows with borders and alignment spaces, retaining headers and all values', () => {
  const table = '| Key | Value |\n| --- | --- |\n| abcdef | xy |';
  expect(copy(table, 18)).toBe(
    '+--------+-------+\n| Key    | Value |\n+--------+-------+\n| abcdef | xy    |\n+--------+-------+',
  );
  const wrapped = copy('| A | B |\n| --- | --- |\n| abcdefghijkl | xy |', 12);
  expect(wrapped).toBe(
    '+-----+----+\n| A   | B  |\n+-----+----+\n| abc | xy |\n| def |    |\n| ghi |    |\n| jkl |    |\n+-----+----+',
  );
  expect(copy(table, 8)).toBe('Column 1: Key\nColumn 2: Value\n\nKey: abcdef\nValue: xy');
});

it('keeps short and extra-cell streaming table rows readable at both layout widths', () => {
  for (const width of [8, 20, 78]) {
    const source = '| A | B |\n| - | - |\n| only |\n| a | b | extra |';
    const rows = markdownRows(source, width);
    const content = copy(source, width).replace(/[+|\- \n]/g, '');
    expect(content).toContain('only');
    expect(content).toContain('extra');
    for (const row of rows) expect(stringWidth(row.text)).toBeLessThanOrEqual(width);
  }
});

it('strips source CSI, OSC, C0 and C1 controls before producing only application SGR', () => {
  const attack = '\x1b[2Jclear\x1b]8;;https://evil\x07link\x1b]8;;\x1b\\\x00\x07\x9b31m';
  for (const source of [
    attack,
    `\`\`\`\n${attack}\n\`\`\``,
    `[${attack}](https://example.com/${attack})`,
    `<b>${attack}</b>`,
  ]) {
    const output = markdownRows(source, 18)
      .map((r) => r.text)
      .join('\n');
    expect(output).not.toContain('\x1b]');
    expect(output).not.toContain('\x1b[2J');
    expect(output.replace(/\x1b\[[0-9;]*m/g, '')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(stripAnsi(output)).toContain('clear');
  }
  for (const encoded of ['&#27;[2Jclear', '&#x1b;[31mred', '&#155;31mred']) {
    const output = markdownRows(`**${encoded}** [${encoded}](https://example.com/${encoded})`, 78)
      .map((r) => r.text)
      .join('\n');
    expect(output).not.toContain('\x1b[2J');
    expect(output).not.toContain('\x1b[31m');
    expect(output.replace(/\x1b\[[0-9;]*m/g, '')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  }
});

it('maps code lines and table rows to the same source coordinates after a closing fence and reflow', () => {
  const unfinished = '```ts\nfirst\n  named-code\nlast';
  const before = markdownRows(unfinished, 18).find((r) =>
    stripAnsi(r.text).includes('named-code'),
  )!;
  expect(before.source.line).toBe(3);
  expect(
    markdownRows(unfinished + '\n```\n\nafter', 18).find((r) =>
      stripAnsi(r.text).includes('named-code'),
    )!.source,
  ).toEqual(before.source);
  const table = '| A | B |\n| --- | --- |\n| named-row | v |';
  const row = markdownRows(table, 78).find((r) => stripAnsi(r.text).includes('named-row'))!;
  expect(row.source.line).toBe(3);
  expect(
    markdownRows(table + '\n| later | ' + 'long'.repeat(30) + ' |', 78).find((r) =>
      stripAnsi(r.text).includes('named-row'),
    )!.source,
  ).toEqual(row.source);
});

it.each([18, 78])(
  'keeps decoded table-cell LF, CR and tab references inside physical rows at %s cells',
  (width) => {
    const source = '| A | B |\n| - | - |\n| x&#10;y | z&#xA;q |\n| x&#13;y | z&#9;q |';
    const rows = markdownRows(source, width);
    for (const row of rows) {
      expect(row.text).not.toMatch(/[\n\r\t]/);
      expect(stringWidth(row.text)).toBeLessThanOrEqual(width);
    }
    const value = copy(source, width);
    expect(value).toContain('x y');
    expect(value).toContain('z q');
    expect(value).toContain('xy');
    expect(value).toContain('z    q');
  },
);

it('retains empty list and quote markers, unreferenced definitions and fence metadata', () => {
  expect(plain('- \n- b')).toEqual(['• ', '• b']);
  expect(plain('1. first\n2. ')).toEqual(['1. first', '2. ']);
  expect(plain('>')).toEqual(['> ']);
  expect(copy('[docs]: https://example.com')).toBe('[docs]: https://example.com');
  expect(copy('```ts title=app.ts\na\n```')).toBe('ts title=app.ts\na');
  expect(copy('[ref][docs]\n\n[docs]: https://example.com')).toBe('ref (https://example.com)');
  expect(copy('[docs]: https://example.com\n\n[ref][docs]')).toBe('ref (https://example.com)');
  expect(copy('[ref][docs]\n\n[docs]: https://example.com\n\nnext')).toBe(
    'ref (https://example.com)\n\nnext',
  );
});

it.each([8, 78])(
  'omits list alignment padding from blank, prose and code logical lines at %s cells',
  (width) => {
    expect(copy('- item\n\n  ```\n  a\n    b\n  ```', width)).toBe('• item\n\na\n  b');
    expect(copy('- first\n  next\n  - nested\n    more', width)).toBe(
      '• first\nnext\n  • nested\nmore',
    );
    expect(copy('> - item\n>\n>   ```\n>   a\n>     b\n>   ```', width)).toBe(
      '> • item\n> \n> a\n>   b',
    );
  },
);

it.each([20, 78])(
  'copies initial list markers with their nesting indentation at %s cells',
  (width) => {
    expect(copy('- a\n  - b\n    - c', width)).toBe('• a\n  • b\n    • c');
    expect(copy('1. a\n   - b', width)).toBe('1. a\n   • b');
    expect(copy('> - a\n>   - b', width)).toBe('> • a\n>   • b');
    expect(copy('- [x] a\n  - [ ] b', width)).toBe('• [x] a\n      • [ ] b');
  },
);
