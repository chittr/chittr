import { describe, expect, it } from 'vitest';
import {
  draftConcurrencyProblems,
  judgeCycle,
  observeSession,
  processProblems,
  survivalProblems,
  unexpectedDifferences,
  type ExpectedAttachment,
  type IntendedEdit,
  type ProcessObservation,
  type StoredAttachment,
} from '../scripts/cross-version-outcomes.js';

const id = '11111111-2222-4333-8444-555555555555';
const writer = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const image = (name: string) => ({
  id: `att-${name.repeat(32).slice(0, 32)}`,
  filename: `${name}.png`,
  mediaType: 'image/png',
  byteSize: 7028,
  width: 48,
  height: 48,
});
// A session as the new build saves it: one sent image, a draft with two ordered images.
const saved = () => ({
  version: 1,
  id,
  workspace: '/somewhere/private',
  updatedAt: '2026-09-17T10:00:00.000Z',
  notices: [],
  paused: true,
  agents: { codex: { id: 'codex', connection: 'unavailable' } },
  exchanges: { m1: { used: 0, allowance: 8 } },
  messages: [
    {
      id: 'm1',
      sequence: 1,
      author: 'human',
      text: 'sent image',
      attachments: [image('a')],
      attachmentOperation: { id: writer, inputHash: 'f'.repeat(64) },
    },
  ],
  composerDraft: 'unsent draft',
  composerAttachments: [image('b'), image('c')],
  composerDraftRevision: 44,
  composerDraftVersions: { [writer]: 4 } as Record<string, number>,
  pinnedMessageIds: [] as string[],
});
type Saved = ReturnType<typeof saved>;
const after = (change: (session: Saved) => void, edits: IntendedEdit[] = []) => {
  const session = saved();
  change(session);
  return unexpectedDifferences(observeSession(saved()), observeSession(session), edits).map(
    (difference) => difference.path,
  );
};
const draftEdit: IntendedEdit = {
  kind: 'draft-text',
  sessionId: id,
  build: 'previous',
  text: 'unsent draft kept',
};
const oldSend: IntendedEdit = {
  kind: 'text-message',
  sessionId: id,
  build: 'previous',
  text: 'unsent draft',
};
const sendByOldBuild = (session: Saved) => {
  session.messages.push({
    id: 'm2',
    sequence: 2,
    author: 'human',
    text: 'unsent draft',
  } as Saved['messages'][number]);
  session.composerDraft = '';
  (session.exchanges as Record<string, unknown>).m2 = { used: 0, allowance: 8 };
};

describe('differences from the comparison record', () => {
  it.each<[string, (session: Saved) => void, IntendedEdit[], string[]]>([
    ['an untouched session', () => {}, [], []],
    [
      'housekeeping a build rewrites on every open',
      (s) => {
        s.updatedAt = '2026-09-17T11:00:00.000Z';
        (s.notices as unknown[]).push({ id: 'n', text: 'Conversation resumed.' });
      },
      [],
      [],
    ],
    ['an intended draft edit', (s) => (s.composerDraft = 'unsent draft kept'), [draftEdit], []],
    ['an intended edit that was never saved', () => {}, [draftEdit], ['composerDraft']],
    ['draft text changed with no edit', (s) => (s.composerDraft = ''), [], ['composerDraft']],
    [
      'draft image references stripped',
      (s) => (s.composerAttachments = []),
      [],
      ['composerAttachments'],
    ],
    [
      'draft image references reordered',
      (s) => s.composerAttachments.reverse(),
      [],
      ['composerAttachments'],
    ],
    [
      'draft image metadata altered',
      (s) => (s.composerAttachments[0]!.byteSize = 1),
      [],
      ['composerAttachments'],
    ],
    [
      'a sent image reference stripped from its message',
      (s) => (s.messages[0]!.attachments = []),
      [],
      ['messages[0]'],
    ],
    [
      'the send operation identity dropped',
      (s) => delete (s.messages[0] as Partial<Saved['messages'][number]>).attachmentOperation,
      [],
      ['messages[0]'],
    ],
    ['a message removed', (s) => s.messages.pop(), [], ['messages.length', 'messages[0]']],
    ['a previous-build send', sendByOldBuild, [oldSend], []],
    [
      'a message nobody sent',
      sendByOldBuild,
      [],
      ['messages.length', 'composerDraft', 'exchanges'],
    ],
    [
      'a previous-build send that took the staged images with it',
      (s) => {
        sendByOldBuild(s);
        s.messages[1]!.attachments = [image('b')];
      },
      [oldSend],
      ['messages[1]'],
    ],
    [
      'the previous build moving the draft revision',
      (s) => {
        s.composerDraft = 'unsent draft kept';
        s.composerDraftRevision = 45;
      },
      [draftEdit],
      ['composerDraftRevision'],
    ],
    [
      'a new-build draft edit advancing the revision',
      (s) => {
        s.composerDraft = 'again';
        s.composerDraftRevision = 50;
        s.composerDraftVersions = { [writer]: 9 };
      },
      [{ kind: 'draft-text', sessionId: id, build: 'new', text: 'again' }],
      [],
    ],
    [
      'a new-build draft edit that reset the revision',
      (s) => {
        s.composerDraft = 'again';
        s.composerDraftRevision = 0;
      },
      [{ kind: 'draft-text', sessionId: id, build: 'new', text: 'again' }],
      ['composerDraftRevision'],
    ],
    [
      'a new-build draft edit that left the revision where it was',
      (s) => (s.composerDraft = 'again'),
      [{ kind: 'draft-text', sessionId: id, build: 'new', text: 'again' }],
      ['composerDraftRevision'],
    ],
    [
      'a new-build draft edit that forgot a known writer',
      (s) => {
        s.composerDraft = 'again';
        s.composerDraftRevision = 50;
        s.composerDraftVersions = {};
      },
      [{ kind: 'draft-text', sessionId: id, build: 'new', text: 'again' }],
      ['composerDraftVersions'],
    ],
    [
      "a new-build draft edit that moved a writer's counter backward",
      (s) => {
        s.composerDraft = 'again';
        s.composerDraftRevision = 50;
        s.composerDraftVersions = { [writer]: 3 };
      },
      [{ kind: 'draft-text', sessionId: id, build: 'new', text: 'again' }],
      ['composerDraftVersions'],
    ],
    [
      'a new-build draft edit from a second writer',
      (s) => {
        s.composerDraft = 'again';
        s.composerDraftRevision = 45;
        s.composerDraftVersions = { [writer]: 4, 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee': 1 };
      },
      [{ kind: 'draft-text', sessionId: id, build: 'new', text: 'again' }],
      [],
    ],
    [
      "a previous-build send that also changed an existing exchange's budget",
      (s) => {
        sendByOldBuild(s);
        s.exchanges.m1.allowance = 99;
      },
      [oldSend],
      ['exchanges'],
    ],
    [
      'an existing exchange whose used budget changed',
      (s) => {
        s.exchanges.m1.used = 3;
      },
      [],
      ['exchanges'],
    ],
    [
      'a previous-build send whose new exchange was already spent',
      (s) => {
        sendByOldBuild(s);
        (s.exchanges as Record<string, unknown>).m2 = { used: 2, allowance: 8 };
      },
      [oldSend],
      ['exchanges'],
    ],
    [
      'a previous-build send that opened an extra exchange',
      (s) => {
        sendByOldBuild(s);
        (s.exchanges as Record<string, unknown>).m9 = { used: 0, allowance: 8 };
      },
      [oldSend],
      ['exchanges'],
    ],
    [
      'a previous-build send that opened no exchange',
      (s) => {
        sendByOldBuild(s);
        delete (s.exchanges as Record<string, unknown>).m2;
      },
      [oldSend],
      ['exchanges'],
    ],
    [
      'an intended pin',
      (s) => s.pinnedMessageIds.push('m1'),
      [{ kind: 'pin', sessionId: id, build: 'previous', messageId: 'm1' }],
      [],
    ],
    ['a pin nobody made', (s) => s.pinnedMessageIds.push('m1'), [], ['pinnedMessageIds']],
    ['agent state rewritten', (s) => (s.agents.codex.connection = 'ready'), [], ['agents']],
    ['a top-level key dropped', (s) => delete (s as Partial<Saved>).paused, [], ['paused']],
    [
      "another session's edit",
      () => {},
      [{ ...draftEdit, sessionId: '99999999-2222-4333-8444-555555555555' }],
      [],
    ],
  ])('%s', (_name, change, edits, paths) => {
    expect(after(change, edits)).toEqual(paths);
  });
});

describe('the return to the new build, judged from what the previous build left', () => {
  const left = () => {
    const session = saved();
    sendByOldBuild(session);
    return session;
  };
  const again: IntendedEdit = { kind: 'draft-text', sessionId: id, build: 'new', text: 'again' };
  const returned = (change: (session: Saved) => void) => {
    const session = left();
    session.composerDraft = 'again';
    session.composerDraftRevision = 50;
    change(session);
    return unexpectedDifferences(observeSession(left()), observeSession(session), [again]).map(
      (difference) => difference.path,
    );
  };
  it.each<[string, (session: Saved) => void, string[]]>([
    ['only the new build edit', () => {}, []],
    [
      "the allowance of the exchange the previous build's send opened",
      (s) => ((s.exchanges as Record<string, { allowance: number }>).m2!.allowance = 99),
      ['exchanges'],
    ],
    [
      'the message the previous build sent',
      (s) => (s.messages[1]!.text = 'edited'),
      ['messages[1]'],
    ],
  ])('%s', (_name, change, paths) => expect(returned(change)).toEqual(paths));
});

describe('draft concurrency state', () => {
  const observe = (change: (session: Saved) => void) => {
    const session = saved();
    change(session);
    return draftConcurrencyProblems(observeSession(session)).length;
  };
  it.each<[string, (session: Saved) => void, number]>([
    ['the saved state', () => {}, 0],
    [
      'a session from before drafts had revisions',
      (s) => {
        delete (s as Partial<Saved>).composerDraftRevision;
        delete (s as Partial<Saved>).composerDraftVersions;
      },
      0,
    ],
    ['a negative revision', (s) => (s.composerDraftRevision = -1), 1],
    ['a fractional revision', (s) => (s.composerDraftRevision = 1.5), 1],
    ['a writer that is no UUID', (s) => (s.composerDraftVersions = { someone: 1 }), 1],
    ['a writer version that is no counter', (s) => (s.composerDraftVersions = { [writer]: -2 }), 1],
    [
      'writers that are no record',
      (s) => ((s as { composerDraftVersions: unknown }).composerDraftVersions = [1]),
      1,
    ],
  ])('%s', (_name, change, problems) => expect(observe(change)).toBe(problems));
});

const want: ExpectedAttachment = {
  sessionId: id,
  id: image('b').id,
  sha256: 'a'.repeat(64),
  byteSize: 7028,
  use: 'draft',
};
const live: StoredAttachment = {
  sessionId: id,
  id: want.id,
  indexed: true,
  indexSha256: want.sha256,
  resolvedSha256: want.sha256,
  resolvedByteSize: 7028,
};
describe('attachment survival', () => {
  it.each<[string, StoredAttachment[], number]>([
    ['a live, intact reference', [live], 0],
    ['no index entry', [], 1],
    ['an entry the index no longer holds', [{ ...live, indexed: false }], 1],
    // The blob still resolves inside the 24-hour grace; only the index shows it is doomed.
    ['an orphaned entry whose blob still resolves', [{ ...live, orphanedAt: '2026-09-17' }], 1],
    ['an index pointing at other content', [{ ...live, indexSha256: 'b'.repeat(64) }], 1],
    [
      'bytes the store refuses',
      [{ ...live, resolvedSha256: undefined, resolveError: 'AttachmentError' }],
      1,
    ],
    ['resolved bytes of another size', [{ ...live, resolvedByteSize: 7027 }], 1],
    ["the same ID in another session's index", [{ ...live, sessionId: 'other' }], 1],
  ])('%s', (_name, stored, problems) =>
    expect(survivalProblems([want], stored)).toHaveLength(problems),
  );
});

const orderly: ProcessObservation = {
  step: 'previous terminal reopen',
  build: 'previous',
  entry: 'terminal',
  exitCode: 0,
  terminated: false,
  lockPresentAfterExit: false,
  expectedSessionId: id,
  openedSessionId: id,
  createdSessionIds: [],
};
describe('process transitions', () => {
  it.each<[string, Partial<ProcessObservation>, number]>([
    ['an orderly reopen of the requested session', {}, 0],
    [
      'a first launch that creates its session',
      { expectedSessionId: undefined, createdSessionIds: [id] },
      0,
    ],
    ['a failed exit', { exitCode: 1 }, 1],
    ['a process that never reported an exit', { exitCode: null }, 1],
    ['a process that had to be terminated', { terminated: true }, 1],
    ['a workspace lock left behind', { lockPresentAfterExit: true }, 1],
    // A plain launch that starts a new chat is no compatibility evidence.
    ['a different session opened', { openedSessionId: 'other' }, 1],
    ['no session reported', { openedSessionId: undefined }, 1],
    ['a new session created beside the requested one', { createdSessionIds: ['other'] }, 1],
  ])('%s', (_name, change, problems) =>
    expect(processProblems([{ ...orderly, ...change }])).toHaveLength(problems),
  );
});

describe('cycle verdict', () => {
  const clean = {
    processes: [orderly],
    differences: [],
    concurrency: [],
    survival: [],
    beyondGrace: [],
    controlOrphan: { orphanedAfterCycle: true, removedBeyondGrace: true },
    sameSessionDirectory: true,
  };
  it('is directly compatible only with nothing to report', () => {
    expect(judgeCycle(clean)).toEqual({ verdict: 'direct-compatible', problems: [] });
  });
  it.each<[string, Partial<typeof clean>]>([
    ['a disorderly process', { processes: [{ ...orderly, terminated: true }] }],
    [
      'an unexpected change',
      {
        differences: [{ sessionId: id, path: 'composerAttachments', expected: [], observed: [] }],
      } as Partial<typeof clean>,
    ],
    ['invalid draft concurrency', { concurrency: ['bad revision'] } as Partial<typeof clean>],
    ['a reference that did not survive', { survival: ['gone'] } as Partial<typeof clean>],
    ['a reference lost beyond orphan grace', { beyondGrace: ['gone'] } as Partial<typeof clean>],
    ['builds using different session directories', { sameSessionDirectory: false }],
    // A cleanup run that deletes nothing has not shown it could have deleted a reference.
    [
      'a control orphan the aged cleanup left in place',
      { controlOrphan: { orphanedAfterCycle: true, removedBeyondGrace: false } },
    ],
    [
      'a control that was never an orphan',
      { controlOrphan: { orphanedAfterCycle: false, removedBeyondGrace: true } },
    ],
  ])('fails on %s', (_name, change) => {
    const judgement = judgeCycle({ ...clean, ...change });
    expect(judgement.verdict).toBe('direct-incompatible');
    expect(judgement.problems).toHaveLength(1);
  });
});
