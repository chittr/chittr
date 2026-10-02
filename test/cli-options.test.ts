import { expect, it } from 'vitest';
import { parseCliOptions } from '../src/cli-options.js';

it('accepts standalone update', () => {
  expect(parseCliOptions(['update']).command).toBe('update');
});
it.each([
  ['extra'],
  ['--new'],
  ['--web'],
  ['--session', 'id'],
  ['--state-dir', '/tmp/state'],
  ['--trusted-commands'],
  ['--instructions-file', 'brief'],
  ['--json'],
])('rejects update arguments: %j', (...args) => {
  expect(() => parseCliOptions(['update', ...args])).toThrow('accepts no additional arguments');
  for (const flag of ['--help', '--version'])
    expect(() => parseCliOptions(['update', ...args, flag])).not.toThrow();
});

it.each([[], ['--web'], ['--new'], ['--new', '--web']])(
  'accepts a launch brief for a new chat: %j',
  (...args) => {
    expect(
      parseCliOptions([...args, '--instructions-file', ' brief with spaces.md ']).values[
        'instructions-file'
      ],
    ).toBe(' brief with spaces.md ');
  },
);
it.each([
  ['--instructions-file'],
  ['--instructions-file', ''],
  ['--instructions-file', '  '],
  ['--instructions-file', 'one', '--instructions-file=two'],
  ['--instructions-file=one', '--instructions-file=one'],
  ['resume', '--instructions-file', 'brief'],
  ['resume', 'id', '--instructions-file', 'brief'],
  ['--session', 'id', '--instructions-file', 'brief'],
  ['doctor', '--instructions-file', 'brief'],
])('rejects invalid brief arguments: %j', (...args) => {
  expect(() => parseCliOptions(args)).toThrow();
});
it.each(['--help', '--version'])('does not validate the launch file for %s', (flag) => {
  expect(() => parseCliOptions([flag, '--instructions-file', 'missing.md'])).not.toThrow();
});

it.each([[], ['--web'], ['--new'], ['--new', '--web']])(
  'starts a new chat without an implicit saved session: %j',
  (...args) => {
    const options = parseCliOptions(args);
    expect(options.command).toBe('new');
    expect(options.sessionId).toBeUndefined();
  },
);
it('distinguishes the resume picker from explicit session selection and preserves flags', () => {
  const picker = parseCliOptions(['resume', '--web', '--state-dir', '/tmp/history']);
  expect(picker.command).toBe('resume');
  expect(picker.sessionId).toBeUndefined();
  expect(picker.values.web).toBe(true);
  expect(picker.values['state-dir']).toBe('/tmp/history');
  expect(parseCliOptions(['resume', 'saved-id']).sessionId).toBe('saved-id');
  expect(parseCliOptions(['--session', 'saved-id']).sessionId).toBe('saved-id');
  expect(parseCliOptions(['doctor', '--json']).command).toBe('doctor');
});
it.each([
  ['resume', '--new'],
  ['--new', '--session', 'saved-id'],
  ['resume', 'one', '--session', 'two'],
  ['resume', 'one', 'two'],
  ['resume', ''],
  ['--session', ''],
  ['unknown'],
  ['doctor', 'extra'],
])('rejects ambiguous or invalid startup arguments: %j', (...args) => {
  expect(() => parseCliOptions(args)).toThrow();
});
