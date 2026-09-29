import { expect, it } from 'vitest';
import { formatImageDraftWarning, imageDraftWarning } from '../src/image-warning.js';
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

it('uses send recipient rules and groups unavailable image statuses', () => {
  const grouped = warning('hello');
  expect(grouped?.groups).toEqual([
    {
      status: 'not_observed',
      recipients: [{ id: 'claude', reason: 'Claude model has not been observed' }],
    },
    {
      status: 'unsupported',
      recipients: [{ id: 'antigravity', reason: 'Antigravity images are unsupported' }],
    },
  ]);
  expect(formatImageDraftWarning(grouped!)).toBe(
    'Image status warning · Not observed: @claude: Claude model has not been observed · Unsupported: @antigravity: Antigravity images are unsupported',
  );
  expect(warning('@human @antigravity compare')?.groups).toEqual([
    {
      status: 'unsupported',
      recipients: [{ id: 'antigravity', reason: 'Antigravity images are unsupported' }],
    },
  ]);
  expect(warning('@human')).toBeUndefined();
  expect(warning('/reply #m1')?.groups[0]?.recipients.map((recipient) => recipient.id)).toEqual([
    'claude',
  ]);
  expect(warning('/reply #m2')).toBeUndefined();
});

it('hides warnings for invalid sends and treats escaped or reply payload slashes as text', () => {
  for (const line of ['@cl', '@unknown text', '/reply #m999 text', '/reply #m3 text', '/help'])
    expect(warning(line), line).toBeUndefined();
  expect(warning('//help')).toBeDefined();
  expect(warning('/reply #m1 /help')).toBeDefined();
  expect(warning('hello', { hasImages: false })).toBeUndefined();
  expect(warning('hello', { invalidRoom: true })).toBeUndefined();
});
