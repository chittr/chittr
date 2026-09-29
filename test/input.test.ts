import { it, expect } from 'vitest';
import {
  InputParser,
  previousBoundary,
  nextBoundary,
  inputRows,
  cleanText,
  type Key,
} from '../src/ui/input.js';
it('keeps Enter, Ctrl+J, and enhanced Ctrl+Enter distinct across input chunks', () => {
  const keys: Key[] = [];
  const parser = new InputParser((k) => keys.push(k));
  parser.feed('\r\n\x1b[13;');
  parser.feed('5u\x1b[27;5;13~');
  expect(keys.map((k) => k.name)).toEqual(['enter', 'newline', 'newline', 'newline']);
});
it('bracketed multiline paste is one edit and never a send, even with split delimiters', () => {
  const keys: Key[] = [];
  const parser = new InputParser((k) => keys.push(k));
  for (const part of ['\x1b[20', '0~one\r\ntwo\nthree\x1b[2', '01~']) parser.feed(part);
  expect(keys).toEqual([{ name: 'paste', text: 'one\ntwo\nthree' }]);
});
it('decodes UTF-8 chunks, control keys, arrows, and keyboard capability reports', () => {
  const keys: Key[] = [];
  const parser = new InputParser((k) => keys.push(k));
  for (const byte of Buffer.from('🙂')) parser.feed(Buffer.from([byte]));
  parser.feed('\x1b[A\x1bOD\x1b[?0u\x03');
  expect(keys).toEqual([
    { name: 'text', text: '🙂' },
    { name: 'up' },
    { name: 'left' },
    { name: 'keyboard-supported' },
    { name: 'ctrl-c' },
  ]);
});
it('moves by grapheme boundaries and wraps without splitting emoji', () => {
  const text = 'a👩‍💻b';
  expect(nextBoundary(text, 1)).toBe(text.length - 1);
  expect(previousBoundary(text, text.length - 1)).toBe(1);
  expect(inputRows('ab🙂cd', 4).map((r) => r.text)).toEqual(['ab🙂', 'cd']);
  expect(inputRows('abcd', 4).map((r) => r.text)).toEqual(['abcd', '']);
});
it('removes terminal escape sequences from displayed text without discarding multiline content', () => {
  expect(cleanText('hello\x1b[2J\nworld\x07')).toBe('hello\nworld');
});
it('decodes split SGR wheel reports without turning mouse data into composer text', () => {
  const keys: Key[] = [];
  const parser = new InputParser((key) => keys.push(key));
  for (const byte of Buffer.from('\x1b[<64;120;15M\x1b[<65;120;15M'))
    parser.feed(Buffer.from([byte]));
  parser.feed('\x1b[<0;4;5M\x1b[<0;4;5m\x1b[<64;4;5m');
  parser.feed('\x1b[<66;4;5M\x1b[<67;4;5M\x1b[<32;4;5M');
  parser.feed('hello');
  expect(keys.slice(0, 2)).toEqual([{ name: 'scroll-up' }, { name: 'scroll-down' }]);
  expect(
    keys
      .slice(2)
      .map((key) => key.text)
      .join(''),
  ).toBe('hello');
  expect(keys.slice(2, 5)).toEqual([
    { name: 'mouse-down', x: 3, y: 4 },
    { name: 'mouse-up', x: 3, y: 4 },
    { name: 'mouse-drag', x: 3, y: 4 },
  ]);
  expect(keys).toHaveLength(10);
});
it('decodes split drag coordinates and modified releases; ignores other mouse buttons', () => {
  const keys: Key[] = [];
  const parser = new InputParser((key) => keys.push(key));
  for (const byte of Buffer.from('\x1b[<0;3;5M\x1b[<48;12;6M\x1b[<16;12;6m'))
    parser.feed(Buffer.from([byte]));
  parser.feed('\x1b[<1;3;5M\x1b[<2;3;5M\x1b[<35;3;5M\x1b[<0;0;5M');
  expect(keys).toEqual([
    { name: 'mouse-down', x: 2, y: 4 },
    { name: 'mouse-drag', x: 11, y: 5 },
    { name: 'mouse-up', x: 11, y: 5 },
  ]);
});
it('recognizes clipboard shortcuts without inserting shortcut letters or key releases', () => {
  const keys: Key[] = [];
  const parser = new InputParser((key) => keys.push(key));
  parser.feed('\x16\x1b[118;5u\x1b[99;9u\x1b[118;9u\x1b[99;6u\x1b[118;6u');
  parser.feed('\x1b[99;9:3u\x1b[120;9u\x03');
  expect(keys.map((key) => key.name)).toEqual([
    'clipboard-paste',
    'clipboard-paste',
    'copy',
    'clipboard-paste',
    'copy',
    'clipboard-paste',
    'ctrl-c',
  ]);
});
it('keeps wheel modifiers and keyboard paging independent of draft editing', () => {
  const keys: Key[] = [];
  const parser = new InputParser((key) => keys.push(key));
  parser.feed('\x1b[<68;1;1M\x1b[<81;1;1M\x1b[5~\x1b[6;2~');
  parser.feed('\x1b[<64;0;1M\x1b[<64;1;0M\x1b[<999;1;1M');
  expect(keys.map((key) => key.name)).toEqual(['scroll-up', 'scroll-down', 'page-up', 'page-down']);
});

it('recognizes unused Ctrl+O as the explicit attachment action on legacy and enhanced keyboards', () => {
  const keys: Key[] = [];
  const parser = new InputParser((key) => keys.push(key));
  parser.feed('\x0f\x1b[111;5u');
  expect(keys).toEqual([{ name: 'attachments' }, { name: 'attachments' }]);
});
