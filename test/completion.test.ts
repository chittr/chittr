import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { complete } from '../src/completion.js';
import { completionContext, fileReferenceActive } from '../src/completion-context.js';

let base: string, workspace: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-completion-')));
  workspace = join(base, 'project');
  mkdirSync(workspace);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const browse = (value: string) => complete(workspace, ['codex'], value, value.length);

it('detects relative file references at the cursor, including quoted paths', () => {
  for (const value of [
    './',
    'Inspect ./src/',
    '@codex\n./',
    'Inspect "./my folder/',
    'Inspect `./',
    'Inspect `./my folder/',
  ])
    expect(fileReferenceActive(value, value.length)).toBe(true);
  for (const value of ['Inspect .', 'https://host/path', 'words./', './file.ts ', '@codex'])
    expect(fileReferenceActive(value, value.length)).toBe(false);
  expect(completionContext('Inspect ./src/ later', 14)).toEqual({
    start: 8,
    token: './src/',
    prefix: './src/',
  });
  expect(completionContext('Inspect "./my folder/a\\"b\\\\c', 29).prefix).toBe(
    './my folder/a"b\\c',
  );
});

it('lists folders first and preserves ./ while keeping ordinary Tab completion', () => {
  mkdirSync(join(workspace, 'z-folder'));
  writeFileSync(join(workspace, 'a.txt'), '');
  writeFileSync(join(workspace, '.hidden'), '');
  const result = browse('Inspect ./');
  expect(result.start).toBe(8);
  expect(result.suggestions).toEqual(['./z-folder/', '`./.hidden` ', '`./a.txt` ']);
  expect(result.files).toMatchObject({
    directory: './',
    entries: [
      { label: 'z-folder/', directory: true },
      { label: '.hidden', directory: false },
      { label: 'a.txt', directory: false },
    ],
  });
  expect(result.files?.parent).toBeUndefined();
  expect(browse('Inspect a').suggestions).toEqual(['`a.txt` ']);
  expect(browse('@cod').suggestions).toEqual(['@codex ']);
  expect(browse('/part').suggestions).toEqual(['/participants ']);
  expect(browse('/pl').suggestions).toEqual(['/plan ']);
  expect(browse('/p').suggestions).toEqual([
    '/pause ',
    '/pin ',
    '/pins ',
    '/plan ',
    '/participants ',
  ]);
});

it('round trips spaces, quotes and backslashes when entering folders and selecting files', () => {
  const folder = 'my "folder\\';
  mkdirSync(join(workspace, folder, 'nested'), { recursive: true });
  writeFileSync(join(workspace, folder, 'a "note\\.md'), '');
  const entered = browse('./my').suggestions[0]!;
  expect(entered).toBe(JSON.stringify('./' + folder + '/').slice(0, -1));
  const listing = browse('Inspect ' + entered);
  expect(listing.files?.directory).toBe('./' + folder + '/');
  expect(listing.files?.parent).toBe('./');
  const nested = browse(listing.suggestions[0]!);
  expect(nested.files?.entries).toEqual([]);
  expect(nested.files?.parent).toBe(entered);
  expect(listing.suggestions[1]).toBe('`./' + folder + '/a "note\\.md` ');
});

it('keeps parent navigation and symlinks inside the workspace boundary', () => {
  mkdirSync(join(workspace, 'nested'));
  writeFileSync(join(base, 'private.txt'), '');
  symlinkSync(base, join(workspace, 'outside'));
  symlinkSync(join(workspace, 'nested'), join(workspace, 'alias'));
  expect(browse('./').suggestions).toEqual(['./nested/']);
  for (const path of ['./../', './nested/../../', './outside/', './alias/', './missing/']) {
    const result = browse(path);
    expect(result.suggestions).toEqual([]);
    expect(result.files?.error).toBeTruthy();
  }
  expect(browse('./nested/').files?.parent).toBe('./');
});

it('bounds large listings while allowing a typed filter to reach later entries', () => {
  for (let i = 0; i < 205; i++)
    writeFileSync(join(workspace, `file-${String(i).padStart(3, '0')}.txt`), '');
  writeFileSync(join(workspace, 'unsafe\nname'), '');
  expect(browse('./').suggestions).toHaveLength(200);
  expect(browse('./').files?.truncated).toBe(true);
  expect(browse('./file-204').suggestions).toEqual(['`./file-204.txt` ']);
  expect(browse('./no-match').files).toMatchObject({
    directory: './',
    entries: [],
    truncated: false,
  });
});

it('completes a folder then a file with or without a leading backtick', () => {
  mkdirSync(join(workspace, 'docs'));
  writeFileSync(join(workspace, 'docs', 'roadmap.md'), '');
  for (const prefix of ['./', '`./']) {
    const folder = browse('Inspect ' + prefix).suggestions[0]!;
    expect(folder).toBe(prefix + 'docs/');
    const file = browse('Inspect ' + folder + 'road').suggestions[0]!;
    expect(file).toBe('`./docs/roadmap.md` ');
    expect(fileReferenceActive('Inspect ' + file, ('Inspect ' + file).length)).toBe(false);
    expect(browse('Inspect `./docs/roadmap.md`').suggestions).toEqual([file]);
  }
});

it('preserves literal quotes and backslashes in backticks and handles filenames containing backticks', () => {
  const folder = 'my `folder\\';
  mkdirSync(join(workspace, folder));
  writeFileSync(join(workspace, folder, 'note".md`'), '');
  const entered = browse('Inspect `./my').suggestions[0]!;
  const listing = browse('Inspect ' + entered);
  expect(listing.files?.directory).toBe('./' + folder + '/');
  const file = listing.suggestions[0]!;
  expect(file).toBe('`` ./my `folder\\/note".md` `` ');
  expect(completionContext(file.trimEnd(), file.trimEnd().length).prefix).toBe(
    './' + folder + '/note".md`',
  );
  expect(browse('Inspect `./docs/../..').suggestions).toEqual([]);
});
