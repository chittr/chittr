import { expect, it } from 'vitest';
import { parseCliOptions } from '../src/cli-options.js';

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
