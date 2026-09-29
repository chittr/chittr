import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import { Room } from '../src/room.js';
import { transcript } from '../src/ui/terminal.js';
import { projectRoom } from '../src/snapshot.js';
import { complete } from '../src/completion.js';
import { parseOutcomes, processOutputSchema, turnPrompt } from '../src/protocol.js';
import { questionAnswers } from '../src/questions.js';
import { ToolService } from '../src/tools.js';
import type { AgentAdapter } from '../src/types.js';

let base: string, store: SessionStore, controller: RoomController;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'chittr-questions-'));
  store = new SessionStore(base, join(base, 'state'));
  store.acquire();
  const adapter: AgentAdapter = {
    async start() {
      return { restored: false };
    },
    async run(input) {
      return {
        outcomes: input.messages.map((m) =>
          m.consultation
            ? {
                messageIds: [m.id],
                recipients: ['human'],
                kind: 'reply',
                text: 'My advice',
                recommendation: {
                  questionId: m.consultation.questionId,
                  requestId: m.id,
                  answer: 'Keep',
                  reasoning: 'Less work',
                },
              }
            : m.text === 'Ask me'
              ? {
                  messageIds: [m.id],
                  recipients: [],
                  kind: 'reply',
                  text: 'Which approach?',
                  question: {
                    prompt: 'Which implementation should we start with?',
                    intent: 'decision',
                    choices: ['/pause @claude', '@human Keep it'],
                  },
                }
              : { messageIds: [m.id], recipients: [], kind: 'pass', text: 'Noted' },
        ),
      };
    },
    async close() {},
    async interrupt() {},
  };
  controller = new RoomController(
    {
      workspace: base,
      permissions: { edits: false, commands: false, network: false },
      followUpTurns: 8,
      sources: [],
      provenance: {},
      agents: {
        claude: {
          id: 'claude',
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
async function ask() {
  await controller.submit('@claude Ask me');
  await tick();
  return controller.room.unansweredQuestions().at(-1)!;
}

it('lists questions in the terminal and treats option text as a literal answer without granting permissions', async () => {
  await controller.submit('/questions');
  expect(controller.room.session.notices.at(-1)!.text).toBe('No unanswered questions.');
  const question = await ask();
  await controller.submit('/questions');
  expect(controller.room.session.notices.at(-1)!.text).toContain('1. /pause @claude');
  expect(controller.room.session.notices.at(-1)!.text).toContain(`/choose #${question.id} number`);
  expect(
    transcript(projectRoom(controller.room), 100)
      .map((r) => r.text)
      .join('\n'),
  ).toContain('Awaiting your answer');
  const permissions = structuredClone(controller.room.config.permissions);
  await controller.submit(`/choose #${question.id} 1`);
  await tick();
  const answer = controller.room.session.messages.at(-1)!;
  expect(answer).toMatchObject({
    author: 'human',
    text: '/pause @claude',
    recipients: ['claude'],
    replyTo: [question.id],
  });
  expect(controller.room.session.agents.claude!.paused).toBe(false);
  expect(controller.room.config.permissions).toEqual(permissions);
  expect(controller.room.session.permissions).toEqual(permissions);
  expect(
    transcript(projectRoom(controller.room), 100)
      .map((r) => r.text)
      .join('\n'),
  ).toContain(`Answered in #${answer.id}`);
  await expect(controller.submit(`/choose #${question.id} 2`)).rejects.toThrow(
    'already been answered',
  );
  expect(controller.room.session.messages.at(-1)!.id).toBe(answer.id);
  expect(complete(base, [], '/ques', 5).suggestions).toEqual(['/questions ']);
});

it('saves and restores open questions, literal free-text answers and exact reply targets', async () => {
  const question = await ask();
  const sessionId = controller.room.session.id;
  await controller.submit('/new');
  expect(controller.room.unansweredQuestions()).toEqual([]);
  await controller.submit('/sessions ' + sessionId);
  expect(controller.room.unansweredQuestions().map((m) => m.id)).toEqual([question.id]);
  await controller.submit(`/answer #${question.id} @human A different plan\n  Keep indentation`);
  await tick();
  const messages = controller.room.session.messages;
  const answer = messages.at(-1)!;
  expect(answer.text).toBe('@human A different plan\n  Keep indentation');
  expect(answer.recipients).toEqual(['claude']);
  expect(questionAnswers(store.load()!.messages).get(question.id)?.id).toBe(answer.id);
  const envelope = JSON.parse(
    turnPrompt({ messages: [answer], context: [], history: messages, participants: ['claude'] }),
  );
  expect(envelope.replyTargets[0].question).toEqual(question.question);
  expect(envelope.unansweredQuestions).toEqual([]);
  await controller.submit('/new');
  await controller.submit('/sessions ' + sessionId);
  expect(controller.room.unansweredQuestions()).toEqual([]);
});

it('includes older unanswered question IDs in prompts and full choices in history retrieval', async () => {
  const question = await ask();
  const messages = controller.room.session.messages;
  const envelope = JSON.parse(
    turnPrompt({ messages: [], context: [], history: messages, participants: ['claude'] }),
  );
  expect(envelope.unansweredQuestions).toEqual([{ id: question.id, author: 'claude' }]);
  const tools = new ToolService(base, controller.room.config.permissions);
  try {
    tools.setHistory(messages);
    const result = await tools.call('read_conversation', { message_id: question.id });
    expect(result).toMatchObject({ question: question.question });
  } finally {
    tools.close();
  }
});

it('rejects malformed and unavailable answers before changing messages or question state', async () => {
  const question = await ask();
  const before = structuredClone(controller.room.session.messages);
  for (const command of [
    '/answer',
    '/choose',
    '/choose #m2 0',
    '/choose #m2 3',
    '/questions extra',
    '/answer #m1 text',
    '/answer #m999 text',
    '/answer #m2   ',
  ])
    await expect(controller.submit(command)).rejects.toThrow();
  controller.room.config.agents.claude!.enabled = false;
  await expect(controller.submit(`/answer #${question.id} Yes`)).rejects.toThrow(
    'no longer enabled',
  );
  expect(controller.room.session.messages).toEqual(before);
  expect(controller.room.unansweredQuestions().map((m) => m.id)).toEqual([question.id]);
});

it.each([
  { choices: [''] },
  { choices: ['Same', 'Same'] },
  { choices: ['a\nb'] },
  { choices: ['x'.repeat(201)] },
  { choices: Array.from({ length: 7 }, (_, i) => String(i)) },
  { choices: ['x'], answerMessageId: 'm1' },
])('rejects invalid provider questions: %j', (question) => {
  expect(() =>
    parseOutcomes({
      outcomes: [{ messageIds: ['m1'], recipients: [], kind: 'reply', text: 'Question', question }],
    }),
  ).toThrow();
});

it('rejects live legacy questions while admitting explicit questions and maintenance', async () => {
  const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv');
  const validate = new AjvJsonSchemaValidator().getValidator(
    JSON.parse(JSON.stringify(processOutputSchema)),
  );
  const outcome = {
    messageIds: ['m1'],
    recipients: [],
    kind: 'reply',
    text: 'Question',
    awaitingHuman: true,
  };
  expect(() => parseOutcomes({ outcomes: [outcome] })).toThrow();
  const result = {
    outcomes: [
      { ...outcome, question: { prompt: 'What else?', intent: 'free-text', choices: [] } },
    ],
  };
  expect(validate(result).valid).toBe(true);
  expect(parseOutcomes(result)[0]).toMatchObject({
    recipients: ['human'],
    question: result.outcomes[0]!.question,
  });
  expect(validate({ maintenance: { operationId: 'm', text: 'Done' } }).valid).toBe(true);
});

it.each([null, { choices: ['Same', 'Same'] }, { choices: [' spaced '] }, { choices: [42] }])(
  'refuses corrupt saved question metadata without overwriting history: %j',
  async (question) => {
    await ask();
    const saved = store.load()!;
    const path = join(store.directory, saved.id, 'session.json');
    const invalid = {
      ...saved,
      messages: saved.messages.map((m) => (m.id === 'm2' ? { ...m, question } : m)),
    };
    const raw = JSON.stringify(invalid);
    writeFileSync(path, raw);
    expect(() => store.load()).toThrow(/invalid/i);
    expect(readFileSync(path, 'utf8')).toBe(raw);
  },
);

it('ordinary replies stay discussion and consultations and answers retain their distinct links through storage and history tools', async () => {
  const question = await ask();
  await controller.submit(`/reply #${question.id} I am still thinking`);
  await tick();
  expect(controller.room.unansweredQuestions()).toHaveLength(1);
  await controller.submit(`/ask-room #${question.id}`);
  await tick();
  const round = controller.room.session.messages.find((m) => m.consultation)!;
  expect(round.consultation).toEqual({ questionId: question.id });
  expect(round.deliveries.claude!.status).toBe('contributed');
  expect(controller.room.unansweredQuestions()).toHaveLength(1);
  const saved = store.load()!;
  const recommendation = saved.messages.find((m) => m.recommendation)!;
  expect(recommendation).toMatchObject({
    author: 'claude',
    recommendation: { requestId: round.id, questionId: question.id, answer: 'Keep' },
  });
  const tools = new ToolService(base, controller.room.config.permissions);
  try {
    tools.setHistory(saved.messages);
    expect(await tools.call('read_conversation', { message_id: round.id })).toMatchObject({
      consultation: round.consultation,
    });
    expect(await tools.call('read_conversation', { message_id: recommendation.id })).toMatchObject({
      recommendation: recommendation.recommendation,
    });
    const { publicMessage } = await import('../src/checkpoint.js');
    expect(publicMessage(recommendation)).toMatchObject({
      recommendation: recommendation.recommendation,
    });
  } finally {
    tools.close();
  }
  await controller.submit(`/answer #${question.id}   /pause @claude\n  whitespace  `);
  await tick();
  const answer = store.load()!.messages.find((m) => m.finalAnswer)!;
  expect(answer.text).toBe('  /pause @claude\n  whitespace  ');
  await controller.submit('/new');
  await controller.submit('/sessions ' + saved.id);
  await tick();
  expect(controller.room.session.messages.filter((m) => m.recommendation)).toHaveLength(1);
  expect(controller.room.unansweredQuestions()).toHaveLength(0);
});

it('freezes old answered and open questions once across repeated save/load and new discussion', async () => {
  const first = await ask();
  const second = await ask();
  controller.room.send('Historical answer\n  preserved', first.id);
  await tick();
  const original = structuredClone(controller.room.session);
  for (const m of original.messages) if (m.question) m.question = { choices: m.question.choices };
  await controller.submit('/new');
  const path = join(store.directory, original.id, 'session.json');
  writeFileSync(path, JSON.stringify(original));
  const migrated = store.load(original.id)!;
  const historical = migrated.messages.at(-1)!;
  expect(questionAnswers(migrated.messages).get(first.id)?.id).toBe(historical.id);
  expect(migrated.messages.find((m) => m.id === second.id)?.question?.frozenAnswerId).toBeNull();
  expect(
    JSON.parse(readFileSync(path, 'utf8')).messages.find((m: { id: string }) => m.id === first.id)
      .question.frozenAnswerId,
  ).toBe(historical.id);
  await controller.submit('/new');
  await controller.submit('/sessions ' + migrated.id);
  for (let i = 0; i < 2; i++) {
    await controller.submit(`/reply #${second.id} New discussion`);
    await tick();
    await controller.submit(`/ask-room #${second.id}`);
    await tick();
    const again = store.load()!;
    expect(questionAnswers(again.messages).get(first.id)?.text).toBe(
      'Historical answer\n  preserved',
    );
    expect(questionAnswers(again.messages).has(second.id)).toBe(false);
    await controller.submit('/new');
    await controller.submit('/sessions ' + migrated.id);
  }
  await controller.submit(`/answer #${second.id} Explicit now`);
  await tick();
  expect(questionAnswers(store.load()!.messages).get(second.id)?.text).toBe('Explicit now');
});

it.each(['author', 'target', 'purpose', 'ordering', 'attribution', 'routing', 'duplicate'])(
  'rejects corrupt saved %s without overwriting the file',
  async (mode) => {
    const question = await ask();
    await controller.submit(`/ask-room #${question.id}`);
    await tick();
    await controller.submit(`/answer #${question.id} Final`);
    await tick();
    const saved = store.load()!;
    const final = saved.messages.find((m) => m.finalAnswer)!;
    const rec = saved.messages.find((m) => m.recommendation)!;
    if (mode === 'author') final.author = 'claude';
    if (mode === 'target') final.finalAnswer!.questionId = 'm999';
    if (mode === 'purpose') final.consultation = { questionId: question.id };
    if (mode === 'ordering') rec.recommendation!.requestId = final.id;
    if (mode === 'attribution') rec.author = 'codex';
    if (mode === 'routing') rec.recipients = [];
    if (mode === 'duplicate')
      saved.messages.push({
        ...final,
        id: `m${saved.messages.length + 1}`,
        sequence: saved.messages.length + 1,
      });
    const path = join(store.directory, saved.id, 'session.json');
    const raw = JSON.stringify(saved);
    writeFileSync(path, raw);
    expect(() => store.load()).toThrow(/invalid/i);
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(() => store.save(saved)).toThrow(/invalid/i);
    expect(readFileSync(path, 'utf8')).toBe(raw);
  },
);

it.each([
  { prompt: '', intent: 'decision', choices: ['One', 'Two'] },
  { prompt: 'Which?', intent: 'decision', choices: ['Only'] },
  { prompt: 'What?', intent: 'free-text', choices: ['No'] },
  { prompt: 'Which?', intent: 'decision', choices: ['Same', 'Same'] },
])('enforces the live intent and prompt contract: %j', (question) => {
  expect(() =>
    parseOutcomes({
      outcomes: [
        { messageIds: ['m1'], recipients: ['human'], kind: 'reply', text: 'Context', question },
      ],
    }),
  ).toThrow();
});

it('legacy migration during listing preserves latest selection and historical update timestamps', async () => {
  await ask();
  const historical = structuredClone(controller.room.session);
  historical.messages[1]!.question = { choices: historical.messages[1]!.question!.choices };
  await controller.submit('/new');
  const currentId = controller.room.session.id;
  const path = join(store.directory, historical.id, 'session.json');
  writeFileSync(path, JSON.stringify(historical));
  const indexBefore = readFileSync(join(store.directory, 'latest.json'), 'utf8');
  store.list();
  expect(readFileSync(join(store.directory, 'latest.json'), 'utf8')).toBe(indexBefore);
  expect(store.load()!.id).toBe(currentId);
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  expect(persisted.updatedAt).toBe(historical.updatedAt);
  expect(persisted.messages[1].question.frozenAnswerId).toBeNull();
  store.list();
  expect(readFileSync(join(store.directory, 'latest.json'), 'utf8')).toBe(indexBefore);
});

it('rejects null question metadata on save before changing the existing file', async () => {
  await ask();
  const saved = store.load()!;
  const path = join(store.directory, saved.id, 'session.json');
  const original = readFileSync(path, 'utf8');
  (saved.messages[1] as unknown as { question: null }).question = null;
  expect(() => store.save(saved)).toThrow(/invalid/i);
  expect(readFileSync(path, 'utf8')).toBe(original);
});
