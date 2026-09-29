import { legacyQuestionSchema, questionSchema, recommendationSchema } from './protocol.js';
import { questionAnswers } from './questions.js';
import type { Message } from './types.js';
import { z } from 'zod';
const link = z.object({ questionId: z.string().min(1) }).strict();
/** Validate durable authority and linkage on both writes and reads. */
export function validateQuestionHistory(messages: Message[]): void {
  const fail = (): never => {
    throw new Error('Saved question history is invalid; it has not been overwritten');
  };
  const byId = new Map(messages.map((m) => [m.id, m]));
  const answered = new Set<string>();
  for (const [index, m] of messages.entries()) {
    if (m.question !== undefined) {
      if (!m.question || typeof m.question !== 'object') fail();
      const q = m.question;
      const schema = q.prompt === undefined ? legacyQuestionSchema : questionSchema;
      if (
        !schema.safeParse(q).success ||
        m.author === 'human' ||
        m.recipients.length !== 1 ||
        m.recipients[0] !== 'human' ||
        new Set(q.choices).size !== q.choices.length ||
        q.choices.some((c) => c !== c.trim()) ||
        (q.prompt !== undefined &&
          (q.intent === 'decision' ? q.choices.length < 2 : q.choices.length !== 0))
      )
        fail();
      if (q.frozenAnswerId != null) {
        const answer = byId.get(q.frozenAnswerId);
        if (
          !answer ||
          answer.author !== 'human' ||
          answer.sequence <= m.sequence ||
          !answer.replyTo.includes(m.id) ||
          !answer.recipients.includes(m.author) ||
          answer.consultation ||
          answer.recommendation ||
          answer.finalAnswer
        )
          fail();
        answered.add(m.id);
      }
    }
    if (m.finalAnswer !== undefined || m.consultation !== undefined) {
      const data = m.finalAnswer ?? m.consultation;
      if (
        !link.safeParse(data).success ||
        m.author !== 'human' ||
        m.question ||
        m.recommendation ||
        (m.finalAnswer && m.consultation)
      )
        fail();
      const q = byId.get(data!.questionId);
      if (
        !q?.question ||
        q.sequence >= m.sequence ||
        m.replyTo.length !== 1 ||
        m.replyTo[0] !== q.id ||
        !m.text.trim()
      )
        fail();
      if (m.finalAnswer) {
        if (
          Buffer.byteLength(m.text) > 65536 ||
          answered.has(q!.id) ||
          m.recipients.length !== 1 ||
          m.recipients[0] !== q!.author
        )
          fail();
        answered.add(q!.id);
      } else {
        if (
          questionAnswers(messages.slice(0, index)).has(q!.id) ||
          !m.recipients.length ||
          new Set(m.recipients).size !== m.recipients.length ||
          m.recipients.includes('human') ||
          Object.keys(m.deliveries).length !== m.recipients.length ||
          m.recipients.some((id) => !m.deliveries[id])
        )
          fail();
        for (const [agent, delivery] of Object.entries(m.deliveries)) {
          if (delivery.status === 'contributed') {
            const replies = delivery.responseIds;
            if (replies?.length !== 1) fail();
            const response = byId.get(replies![0]!);
            if (
              !response ||
              response.author !== agent ||
              response.recommendation?.requestId !== m.id
            )
              fail();
          } else if (delivery.responseIds?.length) fail();
        }
      }
    }
    if (m.recommendation !== undefined) {
      const rec = m.recommendation;
      if (
        !recommendationSchema.safeParse(rec).success ||
        !rec.answer.trim() ||
        m.author === 'human' ||
        m.recipients.length !== 1 ||
        m.recipients[0] !== 'human' ||
        Object.keys(m.deliveries).length
      )
        fail();
      const q = byId.get(rec.questionId);
      if (!q?.question || q.sequence > m.sequence) fail();
      if (rec.requestId === undefined) {
        if (q !== m || q.author !== m.author) fail();
      } else {
        const request = byId.get(rec.requestId);
        const delivery = request?.deliveries[m.author];
        if (
          !request?.consultation ||
          request.consultation.questionId !== q!.id ||
          request.sequence >= m.sequence ||
          m.question ||
          m.replyTo.length !== 1 ||
          m.replyTo[0] !== request.id ||
          delivery?.status !== 'contributed' ||
          delivery.responseIds?.length !== 1 ||
          delivery.responseIds[0] !== m.id
        )
          fail();
      }
    }
  }
}
