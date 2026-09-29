import { createContext, useContext } from 'react';
import type { Message } from '../src/types.js';
import {
  type QuestionSession,
  consultationPending,
  consultationRounds,
  consultationStatus,
  questionAnswers,
  questionPrompt,
} from '../src/questions.js';
export interface QuestionDraft {
  text: string;
  editing: boolean;
  error?: string;
}
export const QuestionContext = createContext<{
  session?: QuestionSession;
  getDraft: (id: string) => QuestionDraft;
  setDraft: (id: string, draft: QuestionDraft) => void;
  submit: (id: string, line: string) => Promise<void>;
}>({ getDraft: () => ({ text: '', editing: false }), setDraft: () => {}, submit: async () => {} });
export function QuestionActions({ message, disabled }: { message: Message; disabled: boolean }) {
  const { session, getDraft, setDraft, submit } = useContext(QuestionContext);
  if (!message.question || !session) return null;
  const draft = getDraft(message.id);
  const answer = questionAnswers(session.messages).get(message.id);
  const rounds = consultationRounds(session.messages, message.id);
  const pending = rounds.some(consultationPending);
  const recommendations = session.messages.filter(
    (m) => m.recommendation?.questionId === message.id,
  );
  const edit = (text: string) => setDraft(message.id, { text, editing: true });
  return (
    <div className="question-card" role="group" aria-label={`Question #${message.id}`}>
      <h3>{questionPrompt(message)}</h3>
      {answer ? (
        <>
          <p>
            Answered in <a href={'#' + answer.id}>#{answer.id}</a>
          </p>
          <div className="question-answer">{answer.text}</div>
        </>
      ) : (
        <p>Awaiting your answer</p>
      )}
      {!answer && (
        <>
          <div className="question-choices">
            {message.question.choices.map((choice, i) => (
              <button
                key={i}
                disabled={disabled}
                aria-pressed={draft.editing && draft.text === choice}
                onClick={() => edit(choice)}
              >
                {choice}
              </button>
            ))}
            {message.question.choices.length > 0 && (
              <button
                disabled={disabled}
                onClick={() => setDraft(message.id, { ...draft, editing: true })}
              >
                Write a different answer
              </button>
            )}
          </div>
          {(draft.editing || !message.question.choices.length) && (
            <label className="question-editor">
              Your answer
              <textarea
                aria-label={`Your answer to #${message.id}`}
                value={draft.text}
                disabled={disabled}
                onChange={(event) => edit(event.target.value)}
              />
            </label>
          )}
          <div className="question-controls">
            <button
              disabled={disabled || pending}
              onClick={() => void submit(message.id, `/ask-room #${message.id}`)}
            >
              {pending ? 'Asking the room…' : 'Ask the room'}
            </button>
            <button
              disabled={disabled || !draft.text.trim()}
              onClick={() => void submit(message.id, `/answer #${message.id} ${draft.text}`)}
            >
              Send answer
            </button>
          </div>
          {draft.error && <p role="alert">{draft.error}</p>}
        </>
      )}
      {rounds.map((round) => (
        <div className="question-round" key={round.id}>
          <p>
            Opinion round <a href={'#' + round.id}>#{round.id}</a>
          </p>
          {Object.keys(round.deliveries).map((agent) => (
            <p key={agent}>
              @{agent}: {consultationStatus(session, round, agent)}
            </p>
          ))}
        </div>
      ))}
      {recommendations.map((m) => (
        <div className="question-advice" key={m.id}>
          <p>
            Advice from @{m.author}
            {answer && m.sequence > answer.sequence ? ' · received after submission' : ''}
          </p>
          <div className="question-answer">{m.recommendation!.answer}</div>
          <p className="question-reason">{m.recommendation!.reasoning}</p>
          {!answer && (
            <button disabled={disabled} onClick={() => edit(m.recommendation!.answer)}>
              Use this answer
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
