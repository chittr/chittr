import { expect, it } from 'vitest';
import {
  formatImageDraftWarning,
  formatImageRecipientStatus,
  imageDraftWarning,
  imageWarningLine,
} from '../src/image-warning.js';
import type { ImageWarningParticipant } from '../src/image-warning.js';
import type { Message } from '../src/types.js';

const message = (id: string, author: string, recipients: string[]): Message => ({
  id,
  sequence: Number(id.slice(1)),
  author,
  recipients,
  text: 'message',
  createdAt: '2026-09-17T00:00:00.000Z',
  replyTo: [],
  roots: [id],
  deliveries: {},
});

const participants: ImageWarningParticipant[] = [
  {
    id: 'codex',
    enabled: true,
    initialImageSupport: { available: true, status: 'available' },
  },
  {
    id: 'claude',
    enabled: true,
    initialImageSupport: {
      available: false,
      status: 'not_observed',
      reason: 'Claude model has not been observed',
    },
  },
  {
    id: 'antigravity',
    enabled: true,
    initialImageSupport: {
      available: false,
      status: 'unsupported',
      reason: 'Antigravity images are unsupported',
    },
  },
  { id: 'disabled', enabled: false },
];
const messages = [
  message('m1', 'human', ['claude']),
  message('m2', 'codex', ['human']),
  message('m3', 'human', ['disabled']),
];
const warning = (line: string, options: { hasImages?: boolean; invalidRoom?: boolean } = {}) =>
  imageDraftWarning({
    line,
    hasImages: options.hasImages ?? true,
    invalidRoom: options.invalidRoom,
    participants,
    messages,
  });

it('uses send recipient rules and lists one short line per affected recipient', () => {
  const listed = warning('hello');
  expect(listed?.recipients).toEqual([
    { id: 'claude', status: 'not_observed', reason: 'Claude model has not been observed' },
    { id: 'antigravity', status: 'unsupported', reason: 'Antigravity images are unsupported' },
  ]);
  expect(listed!.recipients.map(imageWarningLine)).toEqual([
    "@claude can't receive images yet",
    "@antigravity can't receive images",
  ]);
  expect(formatImageDraftWarning(listed!)).toEqual([
    "@claude can't receive images yet",
    "@antigravity can't receive images",
    'Ctrl+O, /attach --status for details.',
  ]);
  expect(warning('@human @antigravity compare')?.recipients).toEqual([
    { id: 'antigravity', status: 'unsupported', reason: 'Antigravity images are unsupported' },
  ]);
  expect(warning('@human')).toBeUndefined();
  expect(warning('@codex')).toBeUndefined();
  expect(warning('/reply #m1')?.recipients.map((recipient) => recipient.id)).toEqual(['claude']);
  expect(warning('/reply #m2')).toBeUndefined();
});

it('reports every resolved recipient for /attach --status without requiring staged images', () => {
  const status = (line: string, invalidRoom = false) =>
    formatImageRecipientStatus({ line, participants, messages, invalidRoom });
  expect(status('@codex @claude compare')).toBe(
    '@codex: can receive images\n@claude: Claude model has not been observed',
  );
  expect(status('hello')).toBe(
    [
      '@codex: can receive images',
      '@claude: Claude model has not been observed',
      '@antigravity: Antigravity images are unsupported',
    ].join('\n'),
  );
  expect(status('@human')).toBe('The current draft has no agent recipients.');
  expect(status('@unknown text')).toContain('cannot be sent as written');
  expect(status('hello', true)).toContain('cannot be sent as written');
});

it('hides warnings for invalid sends and treats escaped or reply payload slashes as text', () => {
  for (const line of ['@cl', '@unknown text', '/reply #m999 text', '/reply #m3 text', '/help'])
    expect(warning(line), line).toBeUndefined();
  expect(warning('//help')).toBeDefined();
  expect(warning('/reply #m1 /help')).toBeDefined();
  expect(warning('hello', { hasImages: false })).toBeUndefined();
  expect(warning('hello', { invalidRoom: true })).toBeUndefined();
});
