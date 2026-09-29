import { expect, it } from 'vitest';
import { ComposerHistory } from '../src/composer-history.js';
import type { Message } from '../src/types.js';

function message(text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    sequence: 1,
    author: 'human',
    text,
    recipients: [],
    replyTo: [],
    roots: [],
    deliveries: {},
    createdAt: '',
    ...overrides,
  };
}

it('starts with Up, stops at the oldest message, and returns to the draft without wrapping', () => {
  const history = new ComposerHistory();
  const messages = [
    message('First'),
    message('Agent', { author: 'codex' }),
    message('Last\nmessage'),
  ];
  expect(history.move(1, messages, '')).toBeUndefined();
  expect(history.move(-1, messages, 'Unsent')).toBe('Last\nmessage');
  expect(history.move(-1, messages, 'Last\nmessage')).toBe('First');
  expect(history.move(-1, messages, 'First')).toBeUndefined();
  expect(history.move(1, messages, 'First')).toBe('Last\nmessage');
  expect(history.move(1, messages, 'Last\nmessage')).toBe('Unsent');
  expect(history.move(1, messages, 'Unsent')).toBeUndefined();
});

it('does nothing without sent human messages', () => {
  const history = new ComposerHistory();
  for (const messages of [[], [message('Agent', { author: 'claude' })]]) {
    expect(history.move(-1, messages, '')).toBeUndefined();
    expect(history.move(1, messages, '')).toBeUndefined();
    expect(history.browsing).toBe(false);
  }
});

it('retains recipients and replies, and escapes literal slash-prefixed messages', () => {
  const history = new ComposerHistory();
  const messages = [
    message('/pause'),
    message('Question', { recipients: ['codex', 'claude'] }),
    message('Answer', { recipients: ['codex'], replyTo: ['m2'] }),
  ];
  expect(history.move(-1, messages, '/reply #m3 Draft')).toBe('/reply #m2 @codex Answer');
  expect(history.move(-1, messages, '')).toBe('@codex @claude Question');
  expect(history.move(-1, messages, '')).toBe('//pause');
  history.move(1, messages, '');
  history.move(1, messages, '');
  expect(history.move(1, messages, '')).toBe('/reply #m3 Draft');
});

it('keeps its position through incoming messages and resets for edits or another conversation', () => {
  const history = new ComposerHistory();
  const messages = [message('First'), message('Second')];
  expect(history.move(-1, messages, 'Draft')).toBe('Second');
  messages.push(message('Third'));
  expect(history.move(-1, messages, 'Second')).toBe('First');
  expect(history.move(1, messages, 'First')).toBe('Second');
  expect(history.move(1, messages, 'Second')).toBe('Draft');
  expect(history.move(-1, messages, 'Draft')).toBe('Third');
  history.reset();
  expect(history.move(1, [], '')).toBeUndefined();
  expect(history.move(-1, [], '')).toBeUndefined();
});
