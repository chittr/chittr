import { afterEach, expect, it, vi } from 'vitest';
import { Room } from '../src/room.js';
import {
  completionInputs,
  historyInputs,
  pinnedMessages,
  projectRoom,
  providerDefault,
  questionSession,
  stagedAttachments,
  timeline,
  type RoomSnapshot,
} from '../src/snapshot.js';
import { questionDetails, unansweredQuestions } from '../src/questions.js';
import type {
  AdapterEvent,
  AgentAdapter,
  AgentConfig,
  AgentState,
  AttachmentMetadata,
  Message,
  RoomConfig,
  Session,
  TurnInput,
  TurnResult,
} from '../src/types.js';

class Fake implements AgentAdapter {
  async start(id?: string) {
    return { sessionId: id ?? 'native', restored: false };
  }
  run(_input: TurnInput, _event: (e: AdapterEvent) => void, signal: AbortSignal) {
    return new Promise<TurnResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
    });
  }
  async interrupt() {}
  async close() {}
}
const persistence = { save() {} };
const rooms: Room[] = [];
afterEach(async () => {
  await Promise.all(rooms.splice(0).map((room) => room.close()));
});
function agent(id: string, enabled = true, extra: Partial<AgentConfig> = {}): AgentConfig {
  return { id, provider: 'codex', enabled, instructions: '', fingerprint: id, ...extra };
}
function config(overrides: Partial<RoomConfig> = {}): RoomConfig {
  return {
    workspace: '/workspace',
    permissions: { edits: false, commands: false, network: false },
    agents: {},
    followUpTurns: 8,
    sources: [],
    provenance: {},
    ...overrides,
  };
}
function state(id: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    connection: 'ready',
    activity: 'available',
    paused: false,
    fingerprint: id,
    contextThrough: 0,
    draft: '',
    ...overrides,
  };
}
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
const attachment = (id: string): AttachmentMetadata => ({
  id: `att-${id.padEnd(32, '0')}`,
  filename: `${id}.png`,
  mediaType: 'image/png',
  byteSize: 10,
  width: 1,
  height: 1,
});
function room(cfg: RoomConfig, session?: Session): Room {
  const created = new Room(cfg, persistence, session, () => new Fake());
  rooms.push(created);
  return created;
}
/** A plain-data check: JSON-representable objects and arrays only. */
function plain(value: unknown, path = 'snapshot'): void {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return;
  expect(typeof value, path).toBe('object');
  const prototype = Object.getPrototypeOf(value);
  expect(prototype === Object.prototype || prototype === Array.prototype, path).toBe(true);
  for (const [key, child] of Object.entries(value as object)) plain(child, `${path}.${key}`);
}

it('projects every baseline wire field, its defaults and the three additions as plain JSON', () => {
  const source = room(config({ agents: { codex: agent('codex') } }));
  const snapshot = projectRoom(source);
  plain(snapshot);
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual({
    workspace: '/workspace',
    humanName: 'You',
    permissions: { edits: false, commands: false, network: false },
    commandAccess: { mode: 'off', blockedBy: [] },
    commandAccessDescription: 'Commands off',
    idle: true,
    session: {
      id: source.session.id,
      createdAt: source.session.createdAt,
      paused: false,
      composerDraft: '',
      composerAttachments: [],
      composerDraftRevision: 0,
      messages: [],
      pinnedMessageIds: [],
      notices: [],
      exchanges: {},
    },
    agents: [
      {
        id: 'codex',
        provider: 'codex',
        model: 'provider default',
        effort: 'provider default',
        enabled: true,
        connection: 'connecting',
        activity: 'available',
        paused: false,
        stopped: false,
        draft: '',
        pending: { queued: 0, capped: 0, unresolved: 0 },
        initialImageSupport: {
          available: false,
          status: 'not_observed',
          reason:
            'Initial-image support for @codex has not been observed while the participant is not connected',
        },
        status: 'Connecting',
        statusDetail: 'Starting the provider session',
      },
    ],
    sessionAgentIds: [],
  });
});

it('serialises a populated projection to the complete public wire shape', () => {
  const cfg = config({
    humanName: 'Bill',
    agents: {
      codex: agent('codex', true, { model: 'gpt-6-astra', effort: 'high' }),
      claude: agent('claude', false, { provider: 'claude' }),
    },
  });
  const source = room(cfg);
  const image = attachment('a');
  source.session.messages.push(
    message('m1', 1, 'human', 'look', { recipients: ['codex'], attachments: [image] }),
    message('m2', 2, 'codex', 'seen', {
      recipients: ['human'],
      replyTo: ['m1'],
      deliveries: { human: { status: 'contributed' } },
    }),
  );
  source.session.exchanges = { m1: { used: 1, allowance: 8 } };
  source.session.notices.push({ id: 'n1', text: 'note', createdAt: '2026-09-19T10:00:03.000Z' });
  source.session.pinnedMessageIds = ['m2'];
  source.session.composerDraft = 'caption';
  source.session.composerAttachments = [attachment('b')];
  source.session.composerDraftRevision = 3;
  source.session.paused = true;
  source.session.recoveryRequired = true;
  source.session.checkpoints = [
    { version: 1, createdAt: 't1', sourceAgent: 'codex', through: 1, messageId: 'm1', entries: [] },
    {
      version: 2,
      createdAt: 't2',
      sourceAgent: 'codex',
      through: 2,
      messageId: 'm2',
      entries: [
        { category: 'decision', text: 'Left', sources: [{ messageId: 'm2', author: 'codex' }] },
      ],
    },
  ];
  source.session.agents.codex = state('codex', {
    activity: 'working',
    detail: 'read_file',
    recoveryRequired: true,
    contextUsage: { usedTokens: 10, maxTokens: 100, updatedAt: 't' },
    maintenance: {
      id: 'c',
      agent: 'codex',
      status: 'failed',
      route: 'replacement',
      purpose: 'recovery',
      startedAt: 't',
      detail: 'Interrupted',
    },
    active: { id: 'a', messageIds: ['m1'], chargedRoots: ['m1'], startedAt: 't' },
    draft: 'partial',
    sessionId: 'private-native-session',
    contextThrough: 2,
  });
  source.session.agents.old = state('old', {
    connection: 'unavailable',
    detail: 'Removed from config',
    paused: true,
  });
  source.fatal = 'Session could not be saved';
  vi.spyOn(source, 'initialImageSupport').mockReturnValue({
    available: false,
    status: 'unsupported',
    reason: 'no route',
  });
  const snapshot = projectRoom(source);
  plain(snapshot);
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual({
    workspace: '/workspace',
    humanName: 'Bill',
    permissions: { edits: false, commands: false, network: false },
    commandAccess: { mode: 'off', blockedBy: [] },
    commandAccessDescription: 'Commands off',
    idle: true,
    fatal: 'Session could not be saved',
    session: {
      id: source.session.id,
      createdAt: source.session.createdAt,
      paused: true,
      recoveryRequired: true,
      composerDraft: 'caption',
      composerAttachments: [
        {
          id: 'att-b0000000000000000000000000000000',
          filename: 'b.png',
          mediaType: 'image/png',
          byteSize: 10,
          width: 1,
          height: 1,
        },
      ],
      composerDraftRevision: 3,
      messages: [
        {
          id: 'm1',
          sequence: 1,
          author: 'human',
          recipients: ['codex'],
          text: 'look',
          createdAt: '2026-09-19T10:00:01.000Z',
          replyTo: [],
          roots: ['m1'],
          deliveries: {},
          attachments: [
            {
              id: 'att-a0000000000000000000000000000000',
              filename: 'a.png',
              mediaType: 'image/png',
              byteSize: 10,
              width: 1,
              height: 1,
            },
          ],
        },
        {
          id: 'm2',
          sequence: 2,
          author: 'codex',
          recipients: ['human'],
          text: 'seen',
          createdAt: '2026-09-19T10:00:02.000Z',
          replyTo: ['m1'],
          roots: ['m1'],
          deliveries: { human: { status: 'contributed' } },
        },
      ],
      pinnedMessageIds: ['m2'],
      notices: [{ id: 'n1', text: 'note', createdAt: '2026-09-19T10:00:03.000Z' }],
      exchanges: { m1: { used: 1, allowance: 8 } },
      checkpoint: {
        version: 2,
        createdAt: 't2',
        sourceAgent: 'codex',
        through: 2,
        messageId: 'm2',
        entries: [
          { category: 'decision', text: 'Left', sources: [{ messageId: 'm2', author: 'codex' }] },
        ],
      },
    },
    agents: [
      {
        id: 'codex',
        provider: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        enabled: true,
        connection: 'ready',
        activity: 'working',
        paused: false,
        stopped: false,
        recoveryRequired: true,
        detail: 'read_file',
        contextUsage: { usedTokens: 10, maxTokens: 100, updatedAt: 't' },
        maintenance: {
          id: 'c',
          agent: 'codex',
          status: 'failed',
          route: 'replacement',
          purpose: 'recovery',
          startedAt: 't',
          detail: 'Interrupted',
        },
        draft: 'partial',
        active: { startedAt: 't', messageIds: ['m1'] },
        pending: { queued: 0, capped: 0, unresolved: 0 },
        initialImageSupport: { available: false, status: 'unsupported', reason: 'no route' },
        status: 'Working',
        statusDetail: 'read_file',
      },
      {
        id: 'claude',
        provider: 'claude',
        model: 'provider default',
        effort: 'provider default',
        enabled: false,
        connection: 'connecting',
        activity: 'available',
        paused: false,
        stopped: false,
        draft: '',
        pending: { queued: 0, capped: 0, unresolved: 0 },
        status: 'Connecting',
        statusDetail: 'Starting the provider session',
      },
      {
        id: 'old',
        model: 'provider default',
        effort: 'provider default',
        enabled: false,
        connection: 'unavailable',
        activity: 'available',
        paused: true,
        stopped: false,
        detail: 'Removed from config',
        draft: '',
        pending: { queued: 0, capped: 0, unresolved: 0 },
        status: 'Unavailable',
        statusDetail: 'Removed from config',
      },
    ],
    sessionAgentIds: ['codex', 'old'],
  });
  expect(JSON.stringify(snapshot)).not.toContain('private-native-session');
});

it('resolves human, model, effort and command-access values from config with documented fallbacks', () => {
  const configured = room(
    config({
      humanName: 'Bill',
      permissions: { edits: true, commands: true, network: false },
      commandAccess: { mode: 'sandboxed', source: 'user.yaml', blockedBy: [] },
      agents: { codex: agent('codex', true, { model: 'gpt-6-astra', effort: 'high' }) },
    }),
  );
  const snapshot = projectRoom(configured);
  expect(snapshot.humanName).toBe('Bill');
  expect(snapshot.commandAccess).toBe(configured.config.commandAccess);
  expect(snapshot.commandAccessDescription).toContain('Trust inactive (user.yaml)');
  expect(snapshot.agents[0]).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
  const fallback = projectRoom(
    room(config({ permissions: { edits: false, commands: true, network: false } })),
  );
  expect(fallback.commandAccess).toEqual({ mode: 'sandboxed', blockedBy: [] });
  expect(fallback.commandAccessDescription).toBe('Commands sandboxed');
  expect(providerDefault(undefined)).toBe('provider default');
  expect(providerDefault('xhigh')).toBe('xhigh');
});

it('derives the status pair once per agent through the documented ladder and precedence', () => {
  const cfg = config({
    agents: Object.fromEntries(
      ['absent', 'ready', 'unavailable', 'stopped', 'waiting', 'catchup', 'compact', 'busy'].map(
        (id) => [id, agent(id)],
      ),
    ),
  });
  const source = room(cfg);
  Object.assign(source.session.agents, {
    ready: state('ready'),
    unavailable: state('unavailable', { connection: 'unavailable', error: 'boom', detail: 'd' }),
    stopped: state('stopped', {
      stopped: true,
      detail: 'Recovery interrupted',
      maintenance: {
        id: 'x',
        agent: 'stopped',
        status: 'running',
        route: 'replacement',
        purpose: 'recovery',
        startedAt: 't',
      },
    }),
    waiting: state('waiting', { activity: 'waiting', awaitingHuman: true }),
    catchup: state('catchup', {
      connection: 'connecting',
      error: 'ignored while maintaining',
      maintenance: {
        id: 'r',
        agent: 'catchup',
        status: 'running',
        route: 'replacement',
        purpose: 'recovery',
        startedAt: 't',
        detail: 'Summarizing earlier messages (1 of 2)',
      },
    }),
    compact: state('compact', {
      maintenance: {
        id: 'c',
        agent: 'compact',
        status: 'running',
        route: 'native',
        purpose: 'compaction',
        startedAt: 't',
      },
    }),
    busy: state('busy', {
      activity: 'working',
      detail: 'read_file',
      active: { id: 'a', messageIds: ['m1'], chargedRoots: ['m1'], startedAt: 't' },
    }),
  });
  const pairs = Object.fromEntries(
    projectRoom(source).agents.map((a) => [a.id, [a.status, a.statusDetail]]),
  );
  expect(pairs).toEqual({
    absent: ['Connecting', 'Starting the provider session'],
    ready: ['Available', 'Ready for your next message'],
    unavailable: ['Unavailable', 'boom'],
    stopped: ['Stopped', 'Recovery interrupted'],
    waiting: ['Waiting for you', 'Ready for your next message'],
    catchup: ['Catching up on the chat', 'Summarizing earlier messages (1 of 2)'],
    compact: ['Compacting context', 'Preparing the chat context'],
    busy: ['Working', 'read_file'],
  });
  const busy = projectRoom(source).agents.find((a) => a.id === 'busy')!;
  expect(busy.active).toEqual({ startedAt: 't', messageIds: ['m1'] });
  expect(Object.keys(busy.active!)).toEqual(['startedAt', 'messageIds']);
});

it('orders agents config-first, retains removed agents and follows session order after reload', async () => {
  const cfg = config({ agents: { beta: agent('beta'), alpha: agent('alpha') } });
  const source = room(cfg);
  Object.assign(source.session.agents, {
    alpha: state('alpha', { draft: 'partial alpha' }),
    gamma: state('gamma', { connection: 'unavailable', detail: 'Removed from config', draft: 'x' }),
    beta: state('beta'),
  });
  const support = vi.spyOn(source, 'initialImageSupport');
  const before = projectRoom(source);
  expect(before.agents.map((a) => a.id)).toEqual(['beta', 'alpha', 'gamma']);
  expect(before.sessionAgentIds).toEqual(['alpha', 'gamma', 'beta']);
  expect(before.agents[2]).toMatchObject({
    id: 'gamma',
    enabled: false,
    model: 'provider default',
    effort: 'provider default',
    draft: 'x',
    status: 'Unavailable',
    statusDetail: 'Removed from config',
  });
  expect(before.agents[2]!.provider).toBeUndefined();
  expect(before.agents[2]!.initialImageSupport).toBeUndefined();
  expect(support.mock.calls.map(([id]) => id)).toEqual(['beta', 'alpha']);
  expect(completionInputs(source)).toEqual({
    workspace: '/workspace',
    enabledAgentIds: ['beta', 'alpha'],
  });
  expect(historyInputs(source).humanName).toBe('You');

  await source.reload(
    config({
      humanName: 'Zoë',
      agents: { alpha: agent('alpha'), beta: agent('beta', false), delta: agent('delta') },
    }),
  );
  const after = projectRoom(source);
  expect(after.humanName).toBe('Zoë');
  expect(after.agents.map((a) => a.id)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  expect(after.agents.map((a) => a.enabled)).toEqual([true, false, true, false]);
  expect(after.sessionAgentIds).toEqual(['alpha', 'gamma', 'beta', 'delta']);
  expect(after.agents[1]).toMatchObject({
    status: 'Unavailable',
    statusDetail: 'Disabled in config',
  });
  expect(after.agents[1]!.initialImageSupport).toBeUndefined();
  expect(completionInputs(source)).toEqual({
    workspace: '/workspace',
    enabledAgentIds: ['alpha', 'delta'],
  });
  expect(historyInputs(source).humanName).toBe('Zoë');
});

it('carries attachment metadata, draft revision and enabled-only initial-image reports', () => {
  const cfg = config({
    agents: {
      codex: agent('codex'),
      claude: agent('claude', true, { provider: 'claude' }),
      grok: agent('grok', true, { provider: 'grok' }),
      antigravity: agent('antigravity', false, { provider: 'antigravity' }),
    },
  });
  const source = room(cfg);
  const image = attachment('a');
  source.session.messages.push(message('m1', 1, 'human', 'look', { attachments: [image] }));
  source.session.composerAttachments = [attachment('b')];
  source.session.composerDraftRevision = 3;
  source.session.composerDraft = 'caption';
  source.session.agents.old = state('old');
  const reports = {
    codex: { available: true as const, status: 'available' as const },
    claude: { available: false as const, status: 'not_observed' as const, reason: 'no turn yet' },
    grok: { available: false as const, status: 'unsupported' as const, reason: 'no route' },
  };
  const support = vi
    .spyOn(source, 'initialImageSupport')
    .mockImplementation((id) => reports[id as keyof typeof reports]);
  const snapshot = projectRoom(source);
  expect(snapshot.session.messages[0]!.attachments).toBe(source.session.messages[0]!.attachments);
  expect(snapshot.session.composerAttachments).toBe(source.session.composerAttachments);
  expect(snapshot.session).toMatchObject({ composerDraftRevision: 3, composerDraft: 'caption' });
  expect(Object.fromEntries(snapshot.agents.map((a) => [a.id, a.initialImageSupport]))).toEqual({
    ...reports,
    antigravity: undefined,
    old: undefined,
  });
  expect(support.mock.calls.map(([id]) => id)).toEqual(['codex', 'claude', 'grok']);
  expect(JSON.parse(JSON.stringify(snapshot)).agents.map((a: { id: string }) => a.id)).toEqual([
    'codex',
    'claude',
    'grok',
    'antigravity',
    'old',
  ]);
});

it('orders the timeline by timestamp with stable ties and lists pins in sequence order', () => {
  const later = message('m1', 1, 'human', 'first written, later stamped', {
    createdAt: '2026-09-19T10:00:09.000Z',
  });
  const early = message('m2', 2, 'codex', 'earlier stamp', {
    createdAt: '2026-09-19T10:00:01.000Z',
  });
  const middle = message('m3', 3, 'human', 'middle', { createdAt: '2026-09-19T10:00:05.000Z' });
  const notice = { id: 'n1', text: 'tie with m2', createdAt: '2026-09-19T10:00:01.000Z' };
  const session = {
    messages: [later, early, middle],
    notices: [notice],
    pinnedMessageIds: ['m3', 'm1'],
  };
  const before = structuredClone(session);
  const entries = timeline(session);
  expect(entries.map((entry) => entry.item.id)).toEqual(['m2', 'n1', 'm3', 'm1']);
  expect(entries.map((entry) => (entry.kind === 'message' ? entry.pinned : entry.kind))).toEqual([
    false,
    'notice',
    true,
    true,
  ]);
  expect(pinnedMessages(session).map((m) => m.id)).toEqual(['m1', 'm3']);
  expect(session).toEqual(before);
  expect(session.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
});

it('adapts the projection to the question helpers equivalently to the source session', () => {
  const cfg = config({
    agents: { claude: agent('claude'), codex: agent('codex'), ghost: agent('ghost') },
  });
  const source = room(cfg);
  Object.assign(source.session.agents, {
    claude: state('claude'),
    codex: state('codex', { paused: true }),
  });
  const question = message('m1', 1, 'claude', 'Which option?', {
    recipients: ['human'],
    question: { choices: ['A', 'B'] },
  });
  const round = message('m2', 2, 'human', 'Opinions?', {
    recipients: ['codex', 'ghost'],
    replyTo: ['m1'],
    consultation: { questionId: 'm1' },
    deliveries: { codex: { status: 'queued' }, ghost: { status: 'queued' } },
  });
  const advice = message('m3', 3, 'codex', 'Pick A', {
    recipients: ['human'],
    recommendation: { questionId: 'm1', answer: 'A', reasoning: 'Cheaper' },
  });
  source.session.messages.push(question, round, advice);
  const open = questionDetails(questionSession(projectRoom(source)), question);
  expect(open).toBe(questionDetails(source.session, question));
  expect(open).toContain('Awaiting your answer');
  expect(open).toContain('@codex: queued · paused');
  expect(open).toContain('@ghost: queued · unavailable');
  expect(open).toContain('Advice from @codex:\nA\nCheaper');
  expect(unansweredQuestions(projectRoom(source).session.messages)).toEqual(
    source.unansweredQuestions(),
  );
  expect(unansweredQuestions(projectRoom(source).session.messages).map((m) => m.id)).toEqual([
    'm1',
  ]);

  source.session.messages.push(
    message('m4', 4, 'human', 'A', {
      recipients: ['claude'],
      replyTo: ['m1'],
      finalAnswer: { questionId: 'm1' },
    }),
  );
  const answered = questionDetails(questionSession(projectRoom(source)), question);
  expect(answered).toBe(questionDetails(source.session, question));
  expect(answered).toContain('Answered in #m4');
  expect(unansweredQuestions(projectRoom(source).session.messages)).toEqual([]);
});

it('borrows the documented references, leaves the source unchanged and needs a fresh read', () => {
  const cfg = config({ agents: { codex: agent('codex') } });
  const source = room(cfg);
  source.session.messages.push(message('m1', 1, 'human', 'hi', { recipients: ['codex'] }));
  source.session.notices.push({ id: 'n1', text: 'note', createdAt: '2026-09-19T10:00:00.000Z' });
  source.session.pinnedMessageIds = ['m1'];
  source.session.composerAttachments = [attachment('a')];
  source.session.checkpoints = [
    {
      version: 1,
      createdAt: 't',
      sourceAgent: 'codex',
      through: 1,
      messageId: 'm1',
      entries: [],
    },
    {
      version: 2,
      createdAt: 't',
      sourceAgent: 'codex',
      through: 1,
      messageId: 'm1',
      entries: [],
    },
  ];
  source.session.agents.codex = state('codex', {
    contextUsage: { usedTokens: 1, updatedAt: 't' },
    maintenance: {
      id: 'c',
      agent: 'codex',
      status: 'completed',
      route: 'native',
      startedAt: 't',
    },
    active: { id: 'a', messageIds: ['m1'], chargedRoots: ['m1'], startedAt: 't' },
  });
  const before = structuredClone(source.session);
  const snapshot = projectRoom(source);
  timeline(snapshot.session);
  pinnedMessages(snapshot.session);
  questionSession(snapshot);
  expect(source.session).toEqual(before);
  const { session } = source;
  expect(snapshot.session.messages).toBe(session.messages);
  expect(snapshot.session.notices).toBe(session.notices);
  expect(snapshot.session.exchanges).toBe(session.exchanges);
  expect(snapshot.session.pinnedMessageIds).toBe(session.pinnedMessageIds);
  expect(snapshot.session.composerAttachments).toBe(session.composerAttachments);
  expect(snapshot.session.checkpoint).toBe(session.checkpoints![1]);
  expect(snapshot.permissions).toBe(session.permissions);
  const codex = snapshot.agents[0]!;
  expect(snapshot.commandAccess).toEqual({ mode: 'off', blockedBy: [] });
  expect(codex.contextUsage).toBe(session.agents.codex!.contextUsage);
  expect(codex.maintenance).toBe(session.agents.codex!.maintenance);
  expect(codex.active!.messageIds).toBe(session.agents.codex!.active!.messageIds);
  expect(codex.active).not.toBe(session.agents.codex!.active);
  expect(snapshot.session).not.toBe(session);
  expect(stagedAttachments(source)).toBe(session.composerAttachments);
  expect(historyInputs(source).messages).toBe(session.messages);

  session.agents.codex!.paused = true;
  session.messages.push(message('m2', 2, 'codex', 'reply'));
  expect(codex.paused).toBe(false);
  expect(snapshot.session.messages).toHaveLength(2);
  expect(projectRoom(source).agents[0]!.paused).toBe(true);
  const fresh: RoomSnapshot = projectRoom(source);
  expect(fresh.agents).not.toBe(snapshot.agents);
});

it('forwards a producer-owned image report and configured command access by reference', () => {
  const access = {
    mode: 'sandboxed' as const,
    source: 'user.yaml',
    blockedBy: [{ permission: 'edits' as const, source: 'project.yaml' }],
  };
  const source = room(
    config({
      permissions: { edits: false, commands: true, network: true },
      commandAccess: access,
      agents: { codex: agent('codex') },
    }),
  );
  const stable = { available: false as const, status: 'not_observed' as const, reason: 'cached' };
  vi.spyOn(source, 'initialImageSupport').mockReturnValue(stable);
  const first = projectRoom(source);
  const second = projectRoom(source);
  expect(first.agents[0]!.initialImageSupport).toBe(stable);
  expect(second.agents[0]!.initialImageSupport).toBe(stable);
  expect(first.commandAccess).toBe(access);
  expect(first.commandAccess.blockedBy).toBe(access.blockedBy);
  expect(first.agents[0]).not.toBe(second.agents[0]);
});

it('serves narrow input reads without projecting, deriving agent state or scanning history', () => {
  const cfg = config({
    agents: { codex: agent('codex'), claude: agent('claude', false, { provider: 'claude' }) },
  });
  const source = room(cfg);
  source.session.messages.push(message('m1', 1, 'human', 'hi'));
  const pending = vi.spyOn(source, 'pending');
  const support = vi.spyOn(source, 'initialImageSupport');
  const idle = vi.spyOn(source, 'isIdle');
  const reads: (string | symbol)[] = [];
  source.session.messages = new Proxy(source.session.messages, {
    get(target, property, receiver) {
      reads.push(property);
      return Reflect.get(target, property, receiver);
    },
  });
  expect(completionInputs(source)).toEqual({ workspace: '/workspace', enabledAgentIds: ['codex'] });
  expect(stagedAttachments(source)).toEqual([]);
  expect(historyInputs(source).humanName).toBe('You');
  expect(reads).toEqual([]);
  expect(pending).not.toHaveBeenCalled();
  expect(support).not.toHaveBeenCalled();
  expect(idle).not.toHaveBeenCalled();
  const enabled = completionInputs(source).enabledAgentIds;
  enabled.push('mutated');
  expect(completionInputs(source).enabledAgentIds).toEqual(['codex']);
  expect(historyInputs(source).messages).toBe(source.session.messages);
  projectRoom(source);
  expect(pending).toHaveBeenCalledTimes(2);
  expect(idle).toHaveBeenCalledTimes(1);
});
