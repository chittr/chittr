import { it, expect } from 'vitest';
import {
  previewText,
  parseOutcomes,
  turnPrompt,
  outputSchema,
  maintenanceOutputSchema,
} from '../src/protocol.js';

it('supplies the strict Codex schema and normalizes nullable optional fields', async () => {
  // Ordinary JSON Schema validation accepts optional properties; Codex does not.
  const strict = (schema: any) => {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'object') {
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    }
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) value.forEach(strict);
      else if (value && typeof value === 'object') strict(value);
    }
  };
  strict(outputSchema);
  strict(maintenanceOutputSchema);
  const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv');
  const validate = new AjvJsonSchemaValidator().getValidator(
    JSON.parse(JSON.stringify(outputSchema)),
  );
  for (const kind of ['reply', 'pass'] as const) {
    const outcome = {
      messageIds: ['m1'],
      recipients: [],
      kind,
      text: 'Done',
      awaitingHuman: false,
    };
    expect(validate({ outcomes: [outcome] }).valid).toBe(false);
    const wire = { outcomes: [{ ...outcome, question: null, recommendation: null, plan: null }] };
    expect(validate(wire).valid).toBe(true);
    expect(parseOutcomes(wire)).toEqual([outcome]);
    expect(parseOutcomes({ outcomes: [outcome] })).toEqual([outcome]);
  }
  const question = {
    outcomes: [
      {
        messageIds: ['m1'],
        recipients: ['human'],
        kind: 'reply',
        text: 'Which?',
        awaitingHuman: true,
        recommendation: null,
        plan: null,
        question: {
          prompt: 'Which implementation should we start with?',
          intent: 'decision',
          choices: ['Keep', 'Change'],
        },
      },
    ],
  };
  expect(validate(question).valid).toBe(true);
  expect(parseOutcomes(question)).toEqual(
    question.outcomes.map(({ recommendation, plan, ...outcome }) => outcome),
  );
});
it('includes the exact older reply target even when it is outside the incremental context', () => {
  const parent = {
    id: 'm1',
    author: 'codex',
    text: 'Which option?\n1. Keep\n2. Remove',
    sequence: 1,
    recipients: ['human'],
    replyTo: [],
    roots: ['m1'],
    createdAt: '',
    deliveries: {},
  };
  const answer = {
    ...parent,
    id: 'm50',
    sequence: 50,
    author: 'human',
    text: 'The second option.',
    recipients: ['codex'],
    replyTo: ['m1'],
  };
  const prompt = JSON.parse(
    turnPrompt({
      messages: [answer],
      context: [],
      history: [parent, answer],
      participants: ['codex'],
    }),
  );
  expect(prompt.requiredMessages).toEqual([
    expect.objectContaining({ id: 'm50', replyTo: ['m1'] }),
  ]);
  expect(prompt.replyTargets).toEqual([expect.objectContaining({ id: 'm1', text: parent.text })]);
  expect(prompt.context).toEqual([]);
});
it('streams decoded JSON text across arbitrary chunk boundaries without exposing syntax or passes', () => {
  const raw = JSON.stringify({
    outcomes: [
      { messageIds: ['m1'], recipients: [], kind: 'reply', text: 'Hello\n"quoted" \\ 🙂' },
      { messageIds: ['m2'], recipients: [], kind: 'pass', text: 'No additional insight' },
    ],
  });
  for (let end = 0; end < raw.length; end++)
    expect('Hello\n"quoted" \\ 🙂'.startsWith(previewText(raw.slice(0, end)))).toBe(true);
  expect(previewText(raw)).toBe('Hello\n"quoted" \\ 🙂');
  expect(parseOutcomes(raw)).toHaveLength(2);
});
it('labels long-history digests and keeps pending messages intact', () => {
  const messages = Array.from({ length: 120 }, (_, i) => ({
    id: `m${i}`,
    author: 'human',
    text: 'Evidence '.repeat(100),
    sequence: i,
    recipients: [],
    replyTo: [],
    roots: [],
    createdAt: '',
    deliveries: {},
  }));
  const result = JSON.parse(
    turnPrompt({ context: messages, messages: [messages[0]!], participants: ['codex'] }),
  );
  expect(result.restoredHistorySummary.label).toMatch(/digest|restored/);
  expect(result.requiredMessages[0].text).toBe(messages[0]!.text);
});
it('bounds even a single huge recent context message and leaves it available through history retrieval', () => {
  const message = {
    id: 'm1',
    sequence: 1,
    author: 'human',
    text: '🐘'.repeat(100000),
    recipients: [],
    replyTo: [],
    roots: [],
    createdAt: '',
    deliveries: {},
  };
  const prompt = turnPrompt({ context: [message], messages: [], participants: ['codex'] });
  expect(Buffer.byteLength(prompt)).toBeLessThan(81000);
  expect(JSON.parse(prompt).restoredHistorySummary.label).toMatch(/digest/);
});
it('gives agents the human display name while preserving stable routing IDs', () => {
  const message = {
    id: 'm1',
    author: 'human',
    recipients: ['codex'],
    text: 'Hello',
    sequence: 1,
    replyTo: [],
    roots: ['m1'],
    createdAt: '',
    deliveries: {},
  };
  const envelope = JSON.parse(
    turnPrompt({ context: [], messages: [message], participants: ['codex'], humanName: 'Bill' }),
  );
  expect(envelope.human).toEqual({ id: 'human', name: 'Bill' });
  expect(envelope.participants).toEqual(['human', 'codex']);
  expect(envelope.requiredMessages[0].author).toBe('human');
});

it('requires exactly one valid process result envelope', async () => {
  const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv');
  const { processOutputSchema } = await import('../src/protocol.js');
  const validate = new AjvJsonSchemaValidator().getValidator(
    JSON.parse(JSON.stringify(processOutputSchema)),
  );
  const maintenance = { operationId: 'operation', text: 'seed accepted' };
  const outcomes = [
    { messageIds: ['m1'], recipients: [], kind: 'pass', text: 'Done', awaitingHuman: false },
  ];
  expect(validate({}).valid).toBe(false);
  expect(validate({ maintenance, outcomes }).valid).toBe(false);
  expect(validate({ maintenance }).valid).toBe(true);
  expect(validate({ outcomes }).valid).toBe(true);
  expect(validate({ outcomes: [] }).valid).toBe(false);
  expect(validate({ maintenance, extra: true }).valid).toBe(false);
});
