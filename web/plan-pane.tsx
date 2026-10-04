import { useEffect, useRef, useState } from 'react';
import type { Message } from '../src/types.js';
import type { PlanAction, PlanCategory, PlanEntry, PlanView } from '../src/plan-types.js';
import type { PlanActionResult, WebPlanAction } from '../src/web-types.js';
import { planSummary } from '../src/plan-view.js';
import { api } from './api';
import { MessageBody } from './message';

interface Editor {
  kind: 'add' | 'edit' | 'comment' | 'resolve' | 'reopen';
  category: PlanCategory;
  entryId?: string;
  revision?: number;
  text: string;
  sources: string;
  roomQuestionId: string;
}
const blank = (): Editor => ({
  kind: 'add',
  category: 'approach',
  text: '',
  sources: '',
  roomQuestionId: '',
});
export function PlanPane({
  view,
  messages,
  sessionId,
  instanceId,
  live,
  open,
  close,
  source,
  refresh,
}: {
  view?: PlanView;
  messages: Message[];
  sessionId: string;
  instanceId: string;
  live: boolean;
  open: boolean;
  close(): void;
  source(id: string): void;
  refresh(): Promise<void>;
}) {
  const key = 'chittr:plan:' + sessionId;
  const [editor, setEditor] = useState<Editor>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key + ':editor') ?? 'null') ?? blank();
    } catch {
      return blank();
    }
  });
  const [pending, setPending] = useState<WebPlanAction | undefined>(() => {
    try {
      return (
        JSON.parse(sessionStorage.getItem(key + ':pending:' + instanceId) ?? 'null') ?? undefined
      );
    } catch {
      return;
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const operation = useRef(false);
  useEffect(() => {
    sessionStorage.setItem(key + ':editor', JSON.stringify(editor));
  }, [editor, key]);
  const savePending = (request?: WebPlanAction) => {
    if (request) sessionStorage.setItem(key + ':pending:' + instanceId, JSON.stringify(request));
    else sessionStorage.removeItem(key + ':pending:' + instanceId);
    setPending(request);
  };
  const run = async (action?: PlanAction, clearEditor = false) => {
    if (!live || operation.current || (pending && action)) return;
    const request = action ? { id: crypto.randomUUID(), sessionId, action } : pending;
    if (!request) return;
    operation.current = true;
    setBusy(true);
    setError('');
    setConflict(false);
    savePending(request);
    try {
      const result = await api<PlanActionResult>('plan', request);
      savePending();
      if (!result.ok) {
        setError(result.error ?? 'Plan action was refused.');
        setConflict(!!result.conflict);
      } else if (
        clearEditor ||
        ['add', 'edit', 'comment', 'resolve', 'reopen'].includes(request.action.kind)
      )
        setEditor(blank());
      try {
        await refresh();
      } catch (failure) {
        setError(
          `Plan result received, but refreshing failed: ${(failure as Error).message}. Reconnect to see current state.`,
        );
      }
    } catch (failure) {
      setError(
        `Acknowledgement not received: ${(failure as Error).message}. Check the same request before another plan action.`,
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  const disabled = !live || busy || !!pending;
  const begin = (kind: Editor['kind'], entry: PlanEntry) => {
    setEditor({
      kind,
      category: entry.category,
      entryId: entry.id,
      revision: entry.revision,
      text: kind === 'edit' ? entry.markdown : '',
      sources: kind === 'edit' ? entry.sourceIds.join(' ') : '',
      roomQuestionId: entry.roomQuestionId ?? '',
    });
    setConflict(false);
    setError('');
  };
  const submit = () => {
    const sourceIds = editor.sources
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((s) => s.replace(/^#/, ''));
    const target = { entryId: editor.entryId!, revision: editor.revision! };
    const action: PlanAction =
      editor.kind === 'add'
        ? {
            kind: 'add',
            category: editor.category,
            markdown: editor.text,
            sourceIds,
            ...(editor.roomQuestionId.trim()
              ? { roomQuestionId: editor.roomQuestionId.trim().replace(/^#/, '') }
              : {}),
          }
        : editor.kind === 'edit'
          ? { kind: 'edit', ...target, markdown: editor.text, sourceIds }
          : editor.kind === 'comment'
            ? { kind: 'comment', ...target, text: editor.text }
            : { kind: editor.kind, ...target, explanation: editor.text };
    void run(action, true);
  };
  const sourceLinks = (ids: string[]) =>
    ids.map((id) => (
      <button className="plan-source" key={id} onClick={() => source(id)}>
        #{id}
      </button>
    ));
  const groups: [string, (entry: PlanEntry) => boolean][] = [
    ['Proposed approach', (e) => e.category === 'approach' && e.status === 'proposed'],
    ['Agreed decisions', (e) => e.category === 'approach' && e.status === 'agreed'],
    ['Open objections', (e) => e.category === 'objection'],
    ['Outstanding questions', (e) => e.category === 'question'],
  ];
  return (
    <aside className="plan-pane" hidden={!open} aria-label="Conversation plan">
      <header>
        <h2>Conversation plan</h2>
        <button onClick={close}>Back to chat</button>
      </header>
      <p>{view ? planSummary(view) : 'No plan yet.'}</p>
      <div className="plan-controls">
        <button
          disabled={disabled}
          onClick={() => void run({ kind: 'focus', enabled: !view?.focus })}
        >
          {view?.focus ? 'Turn planning focus off' : 'Enable planning focus'}
        </button>
        {view && (
          <button
            disabled={disabled}
            onClick={() => void run({ kind: 'agree-all', revision: view.revision })}
          >
            Agree to plan
          </button>
        )}
      </div>
      <p className="plan-note">
        Agreement records the displayed approach revisions. Open work stays open. Implementation
        needs a separate human instruction in chat; planning focus does not change permissions.
      </p>
      {view && (
        <p className="plan-note">
          Revision {view.revision} · {view.bytes.used}/{view.bytes.limit} view bytes ·{' '}
          {view.bytes.live} live bytes · {view.bytes.available} available · {view.bytes.reserved}{' '}
          reserved for bookkeeping
        </p>
      )}
      {view?.agreement && (
        <p>
          {sourceLinks([view.agreement.messageId])} Whole-plan agreement
          {view.agreement.current ? ' is current.' : ': the plan has changed.'}
        </p>
      )}
      {pending && (
        <div role="status">
          <p>Plan request awaiting acknowledgement. Your editor text is kept.</p>
          <button disabled={!live || busy} onClick={() => void run()}>
            Check plan request
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {view &&
        groups.map(([label, matches]) => (
          <section key={label} aria-label={label}>
            <h3>{label}</h3>
            {view.entries.filter(matches).map((entry) => (
              <article
                className="plan-entry"
                id={'plan-' + entry.id}
                key={entry.id}
                aria-label={entry.id}
              >
                <h4>
                  {entry.id}@{entry.revision} · {entry.status}
                </h4>
                <MessageBody text={entry.markdown} />
                <p className="plan-note">
                  By @{entry.author} · Sources {sourceLinks(entry.sourceIds)}
                  {entry.messageId &&
                    !entry.sourceIds.includes(entry.messageId) &&
                    sourceLinks([entry.messageId])}
                </p>
                {entry.agreementId && <p>Agreement {sourceLinks([entry.agreementId])}</p>}
                {entry.roomQuestionId && (
                  <p>
                    Room question {sourceLinks([entry.roomQuestionId])} is{' '}
                    {entry.roomQuestionStatus}. This plan entry resolves separately.
                  </p>
                )}
                <div className="plan-controls">
                  <button disabled={disabled} onClick={() => begin('edit', entry)}>
                    Edit
                  </button>
                  {entry.category === 'approach' && entry.status !== 'agreed' && (
                    <button
                      disabled={disabled}
                      onClick={() =>
                        void run({ kind: 'agree', entryId: entry.id, revision: entry.revision })
                      }
                    >
                      Agree
                    </button>
                  )}
                  {entry.category !== 'approach' && (
                    <button
                      disabled={disabled}
                      onClick={() => begin(entry.status === 'open' ? 'resolve' : 'reopen', entry)}
                    >
                      {entry.status === 'open' ? 'Resolve' : 'Reopen'}
                    </button>
                  )}
                  <button disabled={disabled} onClick={() => begin('comment', entry)}>
                    Comment
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void run({ kind: 'withdraw', entryId: entry.id, revision: entry.revision })
                    }
                  >
                    Withdraw
                  </button>
                </div>
                {messages
                  .filter((m) => m.planReference?.entryId === entry.id)
                  .map((m) => (
                    <p key={m.id}>
                      Comment on revision {m.planReference!.revision} {sourceLinks([m.id])} · @
                      {m.author}: {m.text}
                    </p>
                  ))}
              </article>
            ))}
          </section>
        ))}
      <section aria-label="Pending plan proposals">
        <h3>Pending proposals ({view?.proposals.length ?? 0})</h3>
        {view?.proposals.map((proposal) => (
          <article className="plan-entry" key={proposal.id} aria-label={proposal.id}>
            <h4>
              {proposal.id} → {proposal.target.entryId}@{proposal.target.revision} ·{' '}
              {proposal.status}
            </h4>
            <MessageBody text={proposal.markdown} />
            <p>
              By @{proposal.author} · {sourceLinks(proposal.sourceIds)} · Base revision{' '}
              {sourceLinks([proposal.target.messageId])}
            </p>
            <div className="plan-controls">
              <button
                disabled={disabled || proposal.status !== 'pending'}
                onClick={() =>
                  void run({
                    kind: 'adopt',
                    proposalId: proposal.id,
                    entryId: proposal.target.entryId,
                    revision: proposal.target.revision,
                  })
                }
              >
                Adopt
              </button>
              {view.entries.find((e) => e.id === proposal.target.entryId)?.category ===
                'approach' && (
                <button
                  disabled={disabled || proposal.status !== 'pending'}
                  onClick={() =>
                    void run({
                      kind: 'adopt-agree',
                      proposalId: proposal.id,
                      entryId: proposal.target.entryId,
                      revision: proposal.target.revision,
                    })
                  }
                >
                  Adopt and agree
                </button>
              )}
              <button
                disabled={disabled}
                onClick={() => void run({ kind: 'reject', proposalId: proposal.id })}
              >
                Reject
              </button>
            </div>
          </article>
        ))}
      </section>
      <form
        className="plan-editor"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h3>
          {editor.kind === 'add'
            ? 'Add entry'
            : `${editor.kind[0]!.toUpperCase() + editor.kind.slice(1)} ${editor.entryId}@${editor.revision}`}
        </h3>
        {editor.kind === 'add' && (
          <label>
            Category
            <select
              aria-label="Category"
              value={editor.category}
              disabled={!!pending}
              onChange={(e) => setEditor({ ...editor, category: e.target.value as PlanCategory })}
            >
              <option value="approach">Approach</option>
              <option value="objection">Objection</option>
              <option value="question">Question</option>
            </select>
          </label>
        )}
        <label>
          {editor.kind === 'comment'
            ? 'Comment, with optional @recipients'
            : editor.kind === 'resolve' || editor.kind === 'reopen'
              ? 'Answer or explanation'
              : 'Plan Markdown'}
          <textarea
            aria-label="Plan text"
            value={editor.text}
            disabled={!!pending}
            onChange={(e) => setEditor({ ...editor, text: e.target.value })}
            rows={6}
          />
        </label>
        {['add', 'edit'].includes(editor.kind) && (
          <label>
            Public source message IDs
            <input
              aria-label="Plan sources"
              value={editor.sources}
              disabled={!!pending}
              onChange={(e) => setEditor({ ...editor, sources: e.target.value })}
              placeholder="#m1 #m3"
            />
          </label>
        )}
        {editor.kind === 'add' && editor.category === 'question' && (
          <label>
            Room question ID, optional
            <input
              value={editor.roomQuestionId}
              disabled={!!pending}
              onChange={(e) => setEditor({ ...editor, roomQuestionId: e.target.value })}
              placeholder="#m2"
            />
          </label>
        )}
        <button disabled={disabled || !editor.text.trim()} type="submit">
          {editor.kind === 'comment'
            ? 'Send section comment'
            : editor.kind === 'add'
              ? 'Add entry'
              : editor.kind === 'edit'
                ? 'Save proposed revision'
                : editor.kind === 'resolve'
                  ? 'Resolve entry'
                  : 'Reopen entry'}
        </button>
        {editor.kind !== 'add' && (
          <button type="button" disabled={!!pending} onClick={() => setEditor(blank())}>
            New entry
          </button>
        )}
        {conflict && editor.entryId && view?.entries.some((e) => e.id === editor.entryId) && (
          <button
            type="button"
            onClick={() => {
              const entry = view.entries.find((e) => e.id === editor.entryId)!;
              setEditor({ ...editor, revision: entry.revision });
              setConflict(false);
            }}
          >
            Use displayed current revision, keeping my text
          </button>
        )}
      </form>
      <details>
        <summary>Archived entries, comments and refused contributions</summary>
        {messages
          .filter(
            (m) =>
              m.planAction?.kind === 'withdraw' ||
              m.planReference ||
              ['capacity', 'not-applicable'].includes(m.planContribution?.status ?? ''),
          )
          .map((m) => (
            <div key={m.id}>
              {sourceLinks([m.id])}{' '}
              {m.planContribution?.status === 'capacity'
                ? 'not added to plan: capacity'
                : m.planReference
                  ? `${m.planReference.entryId}@${m.planReference.revision} comment`
                  : 'archived'}
              <MessageBody text={m.planContribution?.input.markdown ?? m.text} />
            </div>
          ))}
      </details>
    </aside>
  );
}
