import type { Message, AgentState } from './types.js';

export interface QuestionSession {
  messages: Message[];
  paused: boolean;
  recoveryRequired?: boolean;
  agents: Record<
    string,
    Pick<AgentState, 'connection' | 'paused'> &
      Partial<Pick<AgentState, 'stopped' | 'recoveryRequired' | 'maintenance'>> & {
        active?: unknown;
      }
  >;
}

export function questionPrompt(message: Message): string {
  return message.question?.prompt ?? message.text;
}

/** Convert the old reply rule once, before accepting any post-upgrade messages. */
export function freezeLegacyQuestions(messages: Message[]): boolean {
  let changed = false;
  for (const question of messages) {
    if (
      !question.question ||
      question.question.prompt !== undefined ||
      question.question.frozenAnswerId !== undefined
    )
      continue;
    question.question.frozenAnswerId =
      messages.find(
        (m) =>
          m.author === 'human' &&
          !m.consultation &&
          !m.finalAnswer &&
          m.sequence > question.sequence &&
          m.replyTo.includes(question.id) &&
          m.recipients.includes(question.author),
      )?.id ?? null;
    changed = true;
  }
  return changed;
}

/** Only a room-stamped human final submission or a frozen historical answer resolves. */
export function questionAnswers(messages: Message[]): Map<string, Message> {
  const answers = new Map<string, Message>();
  for (const question of messages) {
    if (!question.question || question.author === 'human') continue;
    const answer = messages.find(
      (m) =>
        m.author === 'human' &&
        !m.consultation &&
        !m.recommendation &&
        m.sequence > question.sequence &&
        m.replyTo.includes(question.id) &&
        m.recipients.includes(question.author) &&
        ((m.finalAnswer?.questionId === question.id &&
          !m.question &&
          m.replyTo.length === 1 &&
          m.recipients.length === 1) ||
          (m.id === question.question!.frozenAnswerId && !m.finalAnswer)),
    );
    if (answer) answers.set(question.id, answer);
  }
  return answers;
}
export function unansweredQuestions(messages: Message[]): Message[] {
  const answers = questionAnswers(messages);
  return messages.filter((message) => message.question && !answers.has(message.id));
}
export function consultationPending(message: Message): boolean {
  return (
    !!message.consultation &&
    Object.values(message.deliveries).some((d) => ['queued', 'sent', 'received'].includes(d.status))
  );
}
export function consultationRounds(messages: Message[], questionId: string): Message[] {
  return messages.filter((m) => m.consultation?.questionId === questionId);
}
export function consultationStatus(
  session: QuestionSession,
  round: Message,
  agent: string,
): string {
  const delivery = round.deliveries[agent]!;
  const state = session.agents[agent];
  let reason = '';
  if (delivery.status === 'queued') {
    reason = session.paused
      ? 'room paused'
      : state?.stopped
        ? 'stopped'
        : state?.paused
          ? 'paused'
          : state?.recoveryRequired || session.recoveryRequired
            ? 'recovery required'
            : state?.maintenance &&
                ['requested', 'waiting', 'running'].includes(state.maintenance.status)
              ? 'context maintenance'
              : state?.connection !== 'ready'
                ? 'unavailable'
                : state.active
                  ? 'busy'
                  : 'awaiting dispatch';
  }
  return [
    delivery.status === 'sent' || delivery.status === 'received' ? 'in progress' : delivery.status,
    reason,
    delivery.rationale,
  ]
    .filter(Boolean)
    .join(' · ');
}
export function questionDetails(session: QuestionSession, question: Message): string {
  const answer = questionAnswers(session.messages).get(question.id);
  return [
    questionPrompt(question),
    ...question.question!.choices.map((choice, i) => `${i + 1}. ${choice}`),
    answer
      ? `Answered in #${answer.id}\n${answer.text}`
      : `Awaiting your answer\n/answer #${question.id} text${question.question!.choices.length ? ` · /choose #${question.id} number` : ''}\n/ask-room #${question.id} gathers advice only`,
    ...consultationRounds(session.messages, question.id).flatMap((round) => [
      `Opinion round #${round.id}`,
      ...Object.keys(round.deliveries).map(
        (agent) => `@${agent}: ${consultationStatus(session, round, agent)}`,
      ),
    ]),
    ...session.messages
      .filter((m) => m.recommendation?.questionId === question.id)
      .map(
        (m) =>
          `Advice from @${m.author}${answer && m.sequence > answer.sequence ? ' · received after submission' : ''}:\n${m.recommendation!.answer}\n${m.recommendation!.reasoning}`,
      ),
  ].join('\n');
}
