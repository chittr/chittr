import { expect, it } from 'vitest';
import { TextSelection, type CopyRow, type Cell } from '../src/ui/selection.js';

function select(rows: CopyRow[], start: Cell, end: Cell): TextSelection {
  const selection = new TextSelection(rows, start);
  selection.end = end;
  return selection;
}
it('selects the same plain text forwards and backwards, without ANSI sequences', () => {
  const rows = [{ text: '\x1b[96mhello world\x1b[0m' }];
  const first = { x: 1, y: 0 },
    last = { x: 4, y: 0 };
  expect(select(rows, first, last).text()).toBe('ello');
  expect(select(rows, last, first).text()).toBe('ello');
});
it('joins visual wraps, preserves real newlines and code indentation, and omits UI padding', () => {
  const rows = [
    { text: '  a long mes', contentStart: 2 },
    { text: '  sage', continuation: true, contentStart: 2 },
    { text: '    indented', contentStart: 2 },
    { text: '' },
    { text: '  next', contentStart: 2 },
  ];
  expect(select(rows, { x: 2, y: 0 }, { x: 5, y: 4 }).text()).toBe(
    'a long message\n  indented\n\nnext',
  );
  expect(select(rows, { x: 3, y: 1 }, { x: 5, y: 1 }).text()).toBe('age');
});
it('snaps selection and highlighting to whole wide and combining graphemes', () => {
  const row = { text: 'a👩‍💻e\u0301界z' };
  const selection = select([row], { x: 2, y: 0 }, { x: 4, y: 0 });
  expect(selection.text()).toBe('👩‍💻e\u0301界');
  expect(selection.highlight(0, row.text)).toBe('\x1b[0ma\x1b[30;103m👩‍💻e\u0301界\x1b[0mz');
});
it('does not copy a click or blank cells and snapshots rows independently of live output', () => {
  const rows = [{ text: 'original' }];
  const click = new TextSelection(rows, { x: 1, y: 0 });
  expect(click.text()).toBe('');
  expect(select(rows, { x: 12, y: 0 }, { x: 20, y: 0 }).text()).toBe('');
  click.end = { x: 7, y: 0 };
  rows[0]!.text = 'updated';
  expect(click.text()).toBe('riginal');
});
