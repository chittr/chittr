import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import { Room } from '../src/room.js';
import {
  applyPlanContribution,
  normalizePlanContribution,
  validatePlanHistory,
} from '../src/plan.js';
import { planBytes, planLimits, planView } from '../src/plan-view.js';
import { publicMessage } from '../src/checkpoint.js';
import { parseOutcomes, outputSchema, turnPrompt } from '../src/protocol.js';
import { ComposerHistory } from '../src/composer-history.js';
import type { AgentAdapter, Message, Outcome, TurnInput } from '../src/types.js';
import type { PlanContribution } from '../src/plan-types.js';

let base: string, store: SessionStore, controller: RoomController;
let reply: (input: TurnInput) => Promise<Outcome[]>;
const runs: TurnInput[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const addition = (
  markdown = 'Use a small cache',
  category: PlanContribution['category'] = 'approach',
): PlanContribution => ({
  kind: 'add',
  category,
  entryId: null,
  baseRevision: null,
  markdown,
  sourceIds: [],
  roomQuestionId: null,
});
const proposal = (markdown = 'Use an LRU', baseRevision = 1): PlanContribution => ({
  kind: 'revise',
  category: null,
  entryId: 'p1',
  baseRevision,
  markdown,
  sourceIds: [],
  roomQuestionId: null,
});
beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'chittr-plan-'));
  store = new SessionStore(base, join(base, 'state'));
  store.acquire();
  runs.length = 0;
  reply = async (input) =>
    input.messages.map((m) => ({
      kind: 'pass',
      text: 'Noted',
      messageIds: [m.id],
      recipients: [],
    }));
  const adapter: AgentAdapter = {
    async start() {
      return { restored: false, sessionId: 'native-fixture' };
    },
    async run(input) {
      runs.push(input);
      return { outcomes: await reply(input) };
    },
    async close() {},
    async interrupt() {},
  };
  controller = new RoomController(
    {
      workspace: base,
      humanName: 'Planner',
      permissions: { edits: false, commands: false, network: false },
      followUpTurns: 4,
      sources: [],
      provenance: {},
      agents: {
        peer: {
          id: 'peer',
          provider: 'claude',
          enabled: true,
          instructions: '',
          fingerprint: 'fixture',
        },
      },
    },
    store,
    undefined,
    {
      help: '',
      quit: async () => {},
      createRoom: (config, persistence, session) =>
        new Room(config, persistence, session, () => adapter),
    },
  );
  await controller.room.start();
});
afterEach(async () => {
  await controller.close();
  store.release();
  rmSync(base, { recursive: true, force: true });
});
async function contribute(plan: PlanContribution) {
  reply = async (input) =>
    input.messages.map((m) => ({
      kind: 'reply',
      text: 'Proposal for discussion',
      messageIds: [m.id],
      recipients: ['human'],
      plan,
    }));
  await controller.submit('@peer Think');
  await tick();
  expect(controller.room.session.agents.peer!.error).toBeUndefined();
  return controller.room.session.messages.at(-1)!;
}

it('selectively adopts and agrees without dispatch or resetting provider identity; keeps older evidence', async () => {
  await controller.submit('/plan');
  await contribute(addition());
  const first = await contribute(proposal());
  await contribute(proposal('Use a bounded map'));
  await contribute(addition('What happens on eviction?', 'objection'));
  await contribute(addition('How many keys?', 'question'));
  const count = runs.length;
  const state = structuredClone(controller.room.session.agents.peer);
  const revision = controller.room.session.plan!.revision;
  await controller.submit('/plan adopt-agree r1 p1@1');
  let plan = controller.room.session.plan!;
  expect(plan.entries[0]).toMatchObject({ revision: 2, status: 'agreed', markdown: 'Use an LRU' });
  expect(plan.proposals).toHaveLength(1);
  expect(planView(plan, controller.room.session.messages)!.proposals[0]!.status).toBe('stale');
  expect(first.planContribution?.input.markdown).toBe('Use an LRU');
  expect(plan.entries.slice(1).map((e) => e.status)).toEqual(['open', 'open']);
  await expect(controller.submit('/plan agree-all ' + revision)).rejects.toThrow('Plan changed');
  await controller.submit('/plan agree-all ' + plan.revision);
  const evidence = structuredClone(controller.room.session.messages.at(-1)!);
  expect(evidence.planAction?.outstanding).toEqual({
    objections: ['p2'],
    questions: ['p3'],
    proposals: ['r2'],
  });
  await controller.submit('/plan edit p1@2 -- Prefer the map');
  plan = controller.room.session.plan!;
  expect(plan.entries[0]!.status).toBe('proposed');
  expect(planView(plan, controller.room.session.messages)!.agreement?.current).toBe(false);
  expect(controller.room.message(evidence.id)).toEqual(evidence);
  expect(publicMessage(evidence).planAction?.entries[0]!.markdown).toBe('Use an LRU');
  expect(runs).toHaveLength(count);
  expect(controller.room.session.agents.peer).toEqual(state);
  expect(store.load()?.plan).toEqual(plan);
});

it('keeps an entry action valid when another entry changes; frozen comments survive withdrawal', async () => {
  await controller.submit('/plan add approach -- Original');
  await controller.submit('/plan add question -- Research');
  await controller.submit('/plan comment p1@1 -- @human Original comment');
  const comment = controller.room.session.messages.at(-1)!;
  await controller.submit('/plan edit p2@1 -- Further research');
  await controller.submit('/plan agree p1@1');
  await controller.submit('/plan withdraw p1@1');
  await controller.submit('/plan add approach -- New section');
  expect(controller.room.session.plan!.entries.map((e) => e.id)).toEqual(['p2', 'p3']);
  expect(comment.planReference).toEqual({ entryId: 'p1', revision: 1, messageId: 'm1' });
  const result = await contribute(proposal('Archived proposal'));
  expect(result.planContribution?.status).toBe('not-applicable');
  expect(store.load()?.messages.find((m) => m.id === comment.id)?.planReference).toEqual(
    comment.planReference,
  );
});

it('includes a fixed exact view on turns with focus off; edits do not alter an in-flight view', async () => {
  await controller.submit('/plan add approach -- Original');
  await controller.submit('/plan off');
  let finish!: (outcomes: Outcome[]) => void;
  reply = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await controller.submit('@peer Think');
  await tick();
  const input = runs.at(-1)!;
  await controller.submit('/plan edit p1@1 -- Changed while thinking');
  expect(JSON.parse(turnPrompt(input)).plan.entries[0].markdown).toBe('Original');
  expect(input.plan!.focus).toBe(false);
  expect(input.plan!.guidance).toBeUndefined();
  finish([
    {
      kind: 'reply',
      text: 'Older proposal',
      recipients: ['human'],
      messageIds: input.messages.map((m) => m.id),
      plan: proposal(),
    },
  ]);
  await tick();
  expect(controller.room.session.messages.at(-1)!.planContribution?.status).toBe('stale');
  expect(controller.room.session.agents.peer!.connection).toBe('ready');
});

it('validates the whole result before publishing; refuses spoofed metadata and future references', async () => {
  controller.room.pause();
  reply = async (input) =>
    input.messages.map((m, i) => ({
      kind: 'reply',
      text: 'Visible only if all valid',
      messageIds: [m.id],
      recipients: ['human'],
      plan: i === 0 ? addition() : { ...proposal(), baseRevision: 100 },
    }));
  await controller.submit('@peer First');
  await controller.submit('@peer Second');
  await controller.room.continue();
  await tick();
  expect(controller.room.session.messages).toHaveLength(2);
  expect(controller.room.session.plan).toBeUndefined();
  expect(controller.room.session.agents.peer!.error).toContain('Unknown plan entry');
  expect(() =>
    normalizePlanContribution({ ...addition(), author: 'human' } as PlanContribution),
  ).toThrow();
  expect(() =>
    parseOutcomes({
      outcomes: [
        { kind: 'pass', text: 'Skip', recipients: [], messageIds: ['m1'], plan: addition() },
      ],
    }),
  ).toThrow('pass');
  const properties = (outputSchema as any).properties.outcomes.items;
  expect(properties.required).toContain('plan');
  expect(
    parseOutcomes({
      outcomes: [{ kind: 'reply', text: 'Ordinary', recipients: [], messageIds: ['m1'] }],
    })[0]!.plan,
  ).toBeUndefined();
});

it('refuses unpersisted human actions, preserves both drafts and holds dispatch', async () => {
  await controller.submit('/plan add approach -- Saved');
  controller.room.saveDraft('Unsent chat');
  const before = structuredClone(controller.room.session.plan);
  vi.spyOn(store, 'save').mockImplementation(() => {
    throw new Error('Disk full');
  });
  await expect(
    controller.planAction(
      { kind: 'edit', entryId: 'p1', revision: 1, markdown: 'Uncommitted text', sourceIds: [] },
      controller.room.session.id,
    ),
  ).rejects.toThrow('Disk full');
  expect(controller.room.session.plan).toEqual(before);
  expect(controller.room.session.composerDraft).toBe('Unsent chat');
  expect(controller.room.session.messages).toHaveLength(1);
  expect(controller.room.fatal).toContain('Work is paused');
  vi.restoreAllMocks();
});

it('rejects corrupted saved plan and action evidence without rewriting bytes; older and switched sessions remain valid', async () => {
  await controller.submit('/plan add approach -- Saved');
  const original = structuredClone(controller.room.session);
  const path = join(store.directory, original.id, 'session.json');
  for (const corrupt of [
    (s: typeof original) => {
      s.plan!.entries[0]!.sourceIds = ['m999'];
    },
    (s: typeof original) => {
      s.messages[0]!.planAction!.entries[0]!.author = 'peer';
    },
    (s: typeof original) => {
      s.plan!.nextEntry = 1;
    },
    (s: typeof original) => {
      s.messages[0]!.planReference = { entryId: 'p1', revision: 50, messageId: 'm1' };
    },
  ]) {
    const candidate = structuredClone(original);
    corrupt(candidate);
    const bytes = JSON.stringify(candidate);
    writeFileSync(path, bytes);
    expect(() => store.load(original.id)).toThrow('Invalid saved plan');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  }
  store.save(original);
  await controller.submit('/new');
  expect(controller.room.session.plan).toBeUndefined();
  await controller.submit('/sessions ' + original.id);
  expect(controller.room.session.plan).toEqual(original.plan);
});

it('measures UTF-8 metadata exactly and rejects over-limit metadata before capacity handling', () => {
  const value = addition('é');
  value.markdown = 'é'.repeat(Math.floor((planLimits.contribution - planBytes(value) + 2) / 2));
  const spare = planLimits.contribution - planBytes(value);
  value.markdown += 'a'.repeat(spare);
  expect(planBytes(value)).toBe(8192);
  expect(normalizePlanContribution(value)).toEqual(value);
  expect(() => normalizePlanContribution({ ...value, markdown: value.markdown + 'x' })).toThrow(
    '8 KiB',
  );
});

it('reclaims bytes through rejection/withdrawal and agrees at capacity without losing evidence', async () => {
  await controller.submit('/plan');
  for (let i = 0; i < 10; i++) await contribute(addition('é'.repeat(3400)));
  const session = controller.room.session;
  expect(session.messages.some((m) => m.planContribution?.status === 'capacity')).toBe(true);
  const plan = session.plan!;
  const count = plan.entries.length;
  await controller.submit('/plan agree-all ' + plan.revision);
  const evidence = publicMessage(session.messages.at(-1)!);
  expect(evidence.planAction!.entries).toHaveLength(count);
  expect(planBytes(evidence)).toBeLessThanOrEqual(planLimits.action);
  const before = planView(session.plan, session.messages)!.bytes.available;
  await controller.submit('/plan withdraw p1@1');
  expect(planView(session.plan, session.messages)!.bytes.available).toBeGreaterThan(before);
  expect(
    session.messages.some(
      (m) =>
        m.planAction?.kind === 'withdraw' && m.planAction.entries[0]!.markdown === 'é'.repeat(3400),
    ),
  ).toBe(true);
  expect(() => validatePlanHistory(session)).not.toThrow();
  expect(controller.room.session.agents.peer!.connection).toBe('ready');
});

it('excludes action records from previews and composer recall', async () => {
  await controller.submit('/plan');
  await controller.submit('/plan add approach -- Draft');
  await controller.submit('@human Actual conversation');
  expect(store.list()[0]!.preview).toContain('Actual conversation');
  const history = new ComposerHistory();
  expect(history.move(-1, controller.room.session.messages, 'Draft')).toBe(
    '@human Actual conversation',
  );
  expect(history.move(-1, controller.room.session.messages, 'Draft')).toBeUndefined();
});

it('keeps plan and room question authority independent, including a host-resolved self link', async () => {
  reply = async (input) =>
    input.messages.map((m) => ({
      kind: 'reply',
      text: 'Research context',
      recipients: ['human'],
      messageIds: [m.id],
      question: { prompt: 'How much capacity?', intent: 'free-text', choices: [] },
      plan: { ...addition('Determine the capacity', 'question'), roomQuestionId: 'self' },
    }));
  await controller.submit('@peer Ask');
  await tick();
  const question = controller.room.session.messages.at(-1)!;
  expect(controller.room.session.plan!.entries[0]!.roomQuestionId).toBe(question.id);
  await controller.submit('/plan resolve p1@1 -- Research completed');
  expect(controller.room.unansweredQuestions().map((m) => m.id)).toContain(question.id);
  await controller.submit('/plan reopen p1@1 -- Need human confirmation');
  reply = async (input) =>
    input.messages.map((m) => ({
      kind: 'pass',
      text: 'Noted',
      messageIds: [m.id],
      recipients: [],
    }));
  await controller.submit(`/answer #${question.id} Ten`);
  await tick();
  expect(controller.room.session.plan!.entries[0]!.status).toBe('open');
  expect(
    planView(controller.room.session.plan, controller.room.session.messages)!.entries[0]!
      .roomQuestionStatus,
  ).toBe('answered');
  await controller.submit(`/plan add question question:#${question.id} -- Follow-up research`);
  expect(store.load()?.plan!.entries[1]!.roomQuestionId).toBe(question.id);
});

it('applies fitting outcomes in order and publishes later capacity refusals without disconnecting', async () => {
  await controller.submit('/plan add approach -- ' + 'x'.repeat(51000));
  controller.room.pause();
  reply = async (input) =>
    input.messages.map((m) => ({
      kind: 'reply',
      text: 'Capacity candidate',
      recipients: ['human'],
      messageIds: [m.id],
      plan: addition('y'.repeat(6900)),
    }));
  await controller.submit('@peer First');
  await controller.submit('@peer Second');
  await controller.room.continue();
  await tick();
  const statuses = controller.room.session.messages
    .filter((m) => m.planContribution)
    .map((m) => m.planContribution!.status);
  expect(statuses).toEqual(['added', 'capacity']);
  expect(controller.room.session.agents.peer!.connection).toBe('ready');
  expect(controller.room.session.plan!.entries).toHaveLength(2);
});

it('projects exact terminal views, links room questions and completes plan subcommands', async () => {
  const { projectRoom } = await import('../src/snapshot.js');
  const { planDocument, transcript } = await import('../src/ui/terminal.js');
  const { complete } = await import('../src/completion.js');
  await controller.submit('/plan');
  await controller.submit('/plan add approach -- **Readable** plan');
  await controller.submit('/plan agree p1@1');
  const snapshot = projectRoom(controller.room);
  const before = JSON.stringify(controller.room.session);
  expect(
    planDocument(snapshot, 100)
      .map((r) => r.text)
      .join('\n'),
  ).toContain('p1@1');
  expect(
    planDocument(snapshot, 100, 'm3')
      .map((r) => r.text)
      .join('\n'),
  ).toContain('Readable');
  expect(
    transcript(snapshot, 100)
      .map((r) => r.text)
      .join('\n'),
  ).toContain('Human plan action');
  expect(JSON.stringify(controller.room.session)).toBe(before);
  expect(complete(base, ['peer'], '/plan ad', 8).suggestions).toEqual([
    'add ',
    'adopt ',
    'adopt-agree ',
  ]);
  expect(complete(base, ['peer'], '/plan add q', 11).suggestions).toEqual(['question ']);
});

it('keeps historical agreement and proposal evidence available through exact read_conversation lookup', async () => {
  const { ToolService } = await import('../src/tools.js');
  await contribute(addition());
  const proposalMessage = await contribute(proposal());
  await controller.submit('/plan adopt-agree r1 p1@1');
  const old = controller.room.session.messages.at(-1)!;
  await controller.submit('/plan edit p1@2 -- Later version');
  await controller.submit('/plan agree p1@3');
  const tools = new ToolService(base, controller.room.config.permissions);
  try {
    tools.setHistory(controller.room.session.messages);
    expect(await tools.call('read_conversation', { message_id: old.id })).toEqual(
      publicMessage(old),
    );
    expect(await tools.call('read_conversation', { message_id: proposalMessage.id })).toMatchObject(
      { planContribution: { input: { markdown: 'Use an LRU' } } },
    );
  } finally {
    tools.close();
  }
});

it('rejects foreign source IDs before any outcome is published, even at capacity', async () => {
  await controller.submit('/plan add approach -- ' + 'x'.repeat(58000));
  const before = structuredClone(controller.room.session.plan);
  reply = async (input) =>
    input.messages.map((m) => ({
      kind: 'reply',
      text: 'Invalid source',
      recipients: ['human'],
      messageIds: [m.id],
      plan: { ...addition('y'.repeat(6000)), sourceIds: ['m99999'] },
    }));
  await controller.submit('@peer Think');
  await tick();
  expect(controller.room.session.messages.at(-1)!.text).toBe('Think');
  expect(controller.room.session.agents.peer!.error).toContain('Invalid plan public source');
  expect(controller.room.session.plan).toEqual(before);
});

it('retains plan data across reload and reconnect without changing its entries or agreement', async () => {
  await controller.submit('/plan add approach -- Keep this plan');
  await controller.submit('/plan agree-all 1');
  const before = structuredClone(controller.room.session.plan);
  await controller.submit('/reload');
  await controller.submit('/reconnect @peer');
  expect(controller.room.session.plan).toEqual(before);
  expect(store.load()?.plan).toEqual(before);
  await controller.submit('/continue @peer');
  await contribute(addition('After reconnect', 'objection'));
  expect(runs.at(-1)!.plan!.entries[0]!.markdown).toBe('Keep this plan');
  expect(runs.at(-1)!.plan!.agreement!.current).toBe(true);
});
