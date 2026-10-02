import { expect, it } from 'vitest';
import { transcript } from '../src/ui/terminal.js';
import { cleanText } from '../src/ui/input.js';
import type { AgentSnapshot, RoomSnapshot } from '../src/snapshot.js';
import type { Message } from '../src/types.js';

/** Plain-data fixtures: no Room, no controller, only the public display contract. */
function message(
  id: string,
  sequence: number,
  author: string,
  text: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    sequence,
    author,
    recipients: [],
    text,
    createdAt: `2026-09-19T10:00:0${sequence}.000Z`,
    replyTo: [],
    roots: ['m1'],
    deliveries: {},
    ...overrides,
  };
}
function agent(id: string, overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    provider: 'codex',
    model: 'provider default',
    effort: 'provider default',
    enabled: true,
    connection: 'ready',
    activity: 'available',
    paused: false,
    stopped: false,
    draft: '',
    pending: { queued: 0, capped: 0, unresolved: 0 },
    status: 'Available',
    statusDetail: 'Ready for your next message',
    ...overrides,
  };
}
function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    workspace: '/workspace',
    humanName: 'Bill',
    permissions: { edits: false, commands: false, network: false },
    commandAccess: { mode: 'off', blockedBy: [] },
    commandAccessDescription: 'Commands off',
    idle: true,
    session: {
      id: 'session',
      createdAt: '2026-09-19T09:00:00.000Z',
      paused: false,
      composerDraft: '',
      composerAttachments: [],
      composerDraftRevision: 0,
      messages: [],
      pinnedMessageIds: [],
      notices: [],
      exchanges: {},
    },
    agents: [],
    sessionAgentIds: [],
    ...overrides,
  };
}
const rows = (view: RoomSnapshot, width = 100) =>
  transcript(view, width).map((line) => ({ key: line.key, text: cleanText(line.text) }));
const text = (view: RoomSnapshot, width = 100) =>
  rows(view, width)
    .map((row) => row.text)
    .join('\n');

it('renders headers, bodies, deliveries, pins and notices from the projection in timeline order', () => {
  const view = snapshot({
    session: {
      ...snapshot().session,
      messages: [
        message('m1', 1, 'human', 'Hello room', { recipients: ['codex', 'human'] }),
        message('m2', 2, 'codex', 'Reply text', {
          recipients: ['human'],
          replyTo: ['m1'],
          deliveries: { human: { status: 'contributed', rationale: 'done' } },
        }),
      ],
      notices: [{ id: 'n1', text: 'Pinned #m1.', createdAt: '2026-09-19T10:00:01.500Z' }],
      pinnedMessageIds: ['m1'],
    },
  });
  const lines = rows(view);
  expect(lines.map((row) => row.key)).toEqual([
    'm1:header',
    'm1:text:1:1:0',
    'm1:space',
    'n1:notice:0',
    'm2:header',
    'm2:text:1:1:0',
    'm2:delivery:0',
    'm2:space',
  ]);
  expect(lines[0]!.text).toBe('Bill  #m1  [pinned] → @codex Bill');
  expect(lines[1]!.text).toBe('  Hello room');
  expect(lines[3]!.text).toBe('· Pinned #m1.');
  expect(lines[4]!.text).toBe('codex  #m2 → Bill  ↳ #m1');
  expect(lines[6]!.text).toBe('  human: contributed · done');
});

it('renders attachment labels and question state from public facts only', () => {
  const question = message('m1', 1, 'codex', 'Which way?', {
    recipients: ['human'],
    question: { choices: ['Left', 'Right'] },
    attachments: [
      {
        id: 'att-' + 'a'.repeat(32),
        filename: 'shot.png',
        mediaType: 'image/png',
        byteSize: 12,
        width: 2,
        height: 3,
      },
    ],
  });
  const open = snapshot({
    session: { ...snapshot().session, messages: [question] },
    agents: [agent('codex')],
    sessionAgentIds: ['codex'],
  });
  const rendered = text(open);
  expect(rendered).toContain(
    '  Image att-' + 'a'.repeat(32) + ' · "shot.png" · image/png · 2×3 · 12 bytes',
  );
  expect(rendered).toContain('  Which way?\n  1. Left\n  2. Right\n  Awaiting your answer');
  expect(rendered).toContain('/choose #m1 number');
  const answered = snapshot({
    session: {
      ...open.session,
      messages: [
        question,
        message('m2', 2, 'human', 'Left', {
          recipients: ['codex'],
          replyTo: ['m1'],
          finalAnswer: { questionId: 'm1' },
        }),
      ],
    },
    agents: open.agents,
    sessionAgentIds: open.sessionAgentIds,
  });
  expect(text(answered)).toContain('  Answered in #m2\n  Left');
  expect(text(answered)).not.toContain('Awaiting your answer');
});

it('renders agent drafts in session order, including a retained removed agent', () => {
  const view = snapshot({
    agents: [
      agent('alpha', { draft: 'alpha draft' }),
      agent('beta', {
        draft: 'beta draft',
        active: { startedAt: 't', messageIds: ['m1'] },
        activity: 'replying',
        status: 'Replying',
      }),
      agent('old', {
        provider: undefined,
        enabled: false,
        connection: 'unavailable',
        draft: 'old draft',
        status: 'Unavailable',
        statusDetail: 'Removed from config',
      }),
      agent('quiet'),
    ],
    sessionAgentIds: ['old', 'beta', 'alpha', 'quiet'],
  });
  expect(rows(view).map((row) => row.text)).toEqual([
    'old  incomplete response',
    '  old draft',
    'beta  replying…',
    '  beta draft',
    'alpha  incomplete response',
    '  alpha draft',
  ]);
});

it('wraps by width without mutating the fixture', () => {
  const view = snapshot({
    session: {
      ...snapshot().session,
      messages: [message('m1', 1, 'human', 'x'.repeat(30))],
    },
  });
  const before = structuredClone(view);
  const narrow = rows(view, 20);
  expect(narrow.filter((row) => row.key.startsWith('m1:text:'))).toHaveLength(2);
  expect(view).toEqual(before);
});

it('formats human, agent and draft bodies while leaving notices and auxiliary text plain', () => {
  const source =
    '# Heading\n\n**bold** *italic* `code`\n\n- item\n\n> quote\n\n```ts\n  code line\n```\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n[label](https://example.com) ![alt](remote)';
  const view = snapshot({
    session: {
      ...snapshot().session,
      composerDraft: '**raw composer**',
      messages: [
        message('m1', 1, 'human', source),
        message('m2', 2, 'codex', source, {
          question: { prompt: '**raw question**', choices: ['*raw choice*'] },
          attachments: [
            {
              id: 'att-' + 'a'.repeat(32),
              filename: '**raw image**.png',
              mediaType: 'image/png',
              byteSize: 12,
              width: 2,
              height: 3,
            },
          ],
          deliveries: { human: { status: 'contributed', rationale: '**raw delivery**' } },
        }),
      ],
      notices: [{ id: 'n1', text: '**raw notice**', createdAt: '2026-09-19T10:00:03.000Z' }],
    },
    agents: [agent('codex', { draft: source })],
    sessionAgentIds: ['codex'],
  });
  const before = structuredClone(view);
  for (const width of [20, 80]) {
    const lines = transcript(view, width);
    const bodies = ['m1:text:', 'm2:text:', 'codex:draft:'].map((prefix) =>
      lines.filter((row) => row.key.startsWith(prefix)).map((row) => cleanText(row.text)),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0]!.join('\n')).toContain('  Heading');
    expect(bodies[0]!.join('\n')).not.toContain('**bold**');
    expect(text(view, width)).toContain('**raw notice**');
    expect(text(view, width)).toContain('**raw question**');
    expect(
      lines
        .filter((r) => r.key.includes(':delivery:'))
        .map((r) => cleanText(r.text).slice(2))
        .join(''),
    ).toContain('**raw delivery**');
    expect(
      lines
        .filter((r) => r.key.includes(':att-'))
        .map((r) => cleanText(r.text).slice(2))
        .join(''),
    ).toContain('**raw image**');
    expect(view).toEqual(before);
  }
});

it('refreshes cached message layouts on text and width changes and owns its returned rows', () => {
  const item = message('m1', 1, 'human', '**original**');
  const view = snapshot({ session: { ...snapshot().session, messages: [item] } });
  const rendered = transcript(view, 80).find((r) => r.key.startsWith('m1:text:'))!;
  rendered.text = 'changed by a consumer';
  rendered.source!.line = 999;
  const fresh = transcript(view, 80).find((r) => r.key.startsWith('m1:text:'))!;
  expect(cleanText(fresh.text)).toBe('  original');
  expect(fresh.source!.line).toBe(1);
  item.text = '**' + 'x'.repeat(30) + '**';
  expect(text(view, 80)).toContain('  ' + 'x'.repeat(30));
  expect(transcript(view, 20).filter((r) => r.key.startsWith('m1:text:'))).toHaveLength(2);
});
