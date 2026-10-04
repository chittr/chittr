import { PlanPane } from './plan-pane';
import type { PlanReference } from '../src/plan-types.js';
import { QuestionContext, type QuestionDraft } from './question-card';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import { api, nextDraftVersion, subscribeEvents, uploadImage } from './api';
import { ComposerController, byteSize } from './composer';
import { prepareImage } from './image-prepare';
import { HostImage, ImageViewer, imageSummary } from './images';
import type { AttachmentMetadata } from '../src/types.js';
import { Avatar, CopyButton, MessageBody, MessageCard, QuestionActions } from './message';
import { maintenanceLabel } from '../src/participant-status.js';
import { unansweredQuestions } from '../src/questions.js';
import { pinnedMessages as pinnedMessageList, questionSession, timeline } from '../src/snapshot.js';
import { Dialog } from './dialog';
import { currentTheme, saveTheme, themeChoices } from './theme';
import type { CommandResult, WebState } from '../src/web-types.js';
import { contextPercent, formatContextUsage } from '../src/context-usage.js';
import { formatReplyDraft, parseReplyDraft } from '../src/reply.js';
import { ComposerHistory } from '../src/composer-history.js';
import { imageDraftWarning, imageWarningLine } from '../src/image-warning.js';
import {
  completionContext,
  fileReferenceActive,
  type CompletionResult,
} from '../src/completion-context.js';
import './style.css';

type Completion = CompletionResult & { end: number; selected: number; loading?: boolean };
type SavedSession = { id: string; updatedAt: string; preview: string; count: number };

function App() {
  const [planOpen, setPlanOpen] = useState(false);
  const [planSource, setPlanSource] = useState<string>();
  // The composer owns recoverable state and its transitions; this component renders it,
  // routes intentions, and keeps connection, history, completion, focus and scroll.
  const [composer] = useState(
    () =>
      new ComposerController(
        {
          command: async (request) => {
            const result = await api<CommandResult>('command', request);
            if (result.ok && /^\/plan\s*$/.test(request.line)) setPlanOpen(true);
            return result;
          },
          state: () => api<WebState>('state'),
          saveDraft: (update, keepalive) => api('draft', update, keepalive),
          upload: uploadImage,
          prepareImage,
          draftVersion: nextDraftVersion,
        },
        sessionStorage,
      ),
  );
  useSyncExternalStore(composer.subscribe, () => composer.changes);
  const [viewing, setViewing] = useState<AttachmentMetadata>();
  const fileInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<WebState>();
  const [theme, setTheme] = useState(currentTheme);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'closed'>(
    'connecting',
  );
  const [completion, setCompletion] = useState<Completion>();
  const [following, setFollowing] = useState(true);
  const [sessions, setSessions] = useState<SavedSession[]>();
  const [config, setConfig] = useState<unknown>();
  const [agentPanel, setAgentPanel] = useState<string>();
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({});
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [compactTarget, setCompactTarget] = useState<string>();
  const [compactInstructions, setCompactInstructions] = useState('');
  const [panelLoading, setPanelLoading] = useState(false);
  const panelRequest = useRef(0);
  const current = useRef<WebState>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastScrollTop = useRef(0);
  const lastViewportHeight = useRef(0);
  const history = useRef(new ComposerHistory());
  const completionRequest = useRef(0);
  const draft = composer.text;
  const replyTo = composer.replyTo;
  const busy = composer.busy;
  const pending = composer.pending;
  const images = composer.images;
  useEffect(
    () =>
      composer.subscribe((event) => {
        if (event.type === 'snapshot') {
          if (event.conversationChanged) {
            history.current.reset();
            setViewing(undefined);
            setPinsOpen(false);
            setPlanSource(undefined);
            setPlanOpen(!!event.state.session.plan);
            setQuestionsOpen(false);
            completionRequest.current++;
            setCompletion(undefined);
            pinned.current = true;
            setFollowing(true);
          }
          current.current = event.state;
          setState(event.state);
        } else if (event.type === 'text-replaced') history.current.reset();
        else if (event.type === 'room-quit') setConnection('closed');
      }),
    [composer],
  );
  useEffect(() => {
    let active = true;
    let stopEvents: (() => void) | undefined;
    void api<WebState>('connect', {})
      .then((initial) => {
        if (!active) return;
        composer.accept(initial);
        stopEvents = subscribeEvents({
          open: () => setConnection('live'),
          error: () => setConnection('reconnecting'),
          state: (value) => {
            composer.accept(value);
            setConnection('live');
          },
          closed: () => setConnection('closed'),
        });
      })
      .catch((failure) => {
        if (active) composer.report(failure.message);
      });
    return () => {
      active = false;
      stopEvents?.();
    };
  }, [composer]);

  const dismissCompletion = () => {
    completionRequest.current++;
    setCompletion(undefined);
  };
  const changeDraft = (
    value: string,
    caret?: number,
    options: { replyTo?: string; recalling?: boolean } = { replyTo },
  ) => {
    if (!composer.edit(value, { replyTo: options.replyTo })) return;
    if (!options.recalling) history.current.reset();
    pendingCaret.current = caret;
    dismissCompletion();
  };
  const selectReply = (id?: string) => {
    if (!composer.selectReply(id)) return;
    history.current.reset();
    dismissCompletion();
    input.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (pendingCaret.current !== undefined && input.current) {
      input.current.focus({ preventScroll: true });
      input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = undefined;
    }
  }, [draft]);
  useLayoutEffect(() => {
    if (!busy && !pending) input.current?.focus({ preventScroll: true });
  }, [busy, pending, state?.session.id]);
  useEffect(() => {
    const capture = composer.captureSave();
    if (!capture) return;
    const timer = setTimeout(() => capture.save(), 250);
    const hide = () => {
      if (document.visibilityState === 'hidden') capture.save(true);
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [composer, draft, replyTo, state?.session.id, pending, busy]);
  useLayoutEffect(() => {
    const selection = window.getSelection();
    const reading =
      selection && !selection.isCollapsed && scroll.current?.contains(selection.anchorNode);
    const viewport = scroll.current;
    if (pinned.current && !reading && viewport) {
      // A scroll event can arrive after a state update. Respect a movement toward history
      // immediately, before following an incoming message can undo it.
      if (
        viewport.clientHeight === lastViewportHeight.current &&
        viewport.scrollTop < lastScrollTop.current - 2 &&
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 70
      ) {
        pinned.current = false;
        setFollowing(false);
      } else viewport.scrollTop = viewport.scrollHeight;
      lastScrollTop.current = viewport.scrollTop;
    }
    if (viewport) lastViewportHeight.current = viewport.clientHeight;
  }, [state, draft, composer.imageChanges]);
  const live = connection === 'live';
  const command = (line: string) => void composer.command(line, live);
  const send = () => {
    if (/^\/plan\s+show\s*$/.test(composer.text)) {
      if (images.attachments.length) {
        composer.report('Plan viewing does not send staged images.');
        return;
      }
      setPlanOpen(true);
      changeDraft('');
      return;
    }
    const exact = /^\/message\s+#?(m[1-9]\d*)\s*$/.exec(composer.text);
    if (exact) {
      if (!state?.session.messages.some((m) => m.id === exact[1])) {
        composer.report('Unknown public message');
        return;
      }
      if (images.attachments.length) {
        composer.report('Message viewing does not send staged images.');
        return;
      }
      setPlanSource(exact[1]);
      changeDraft('');
      return;
    }
    if (composer.submit(live)) dismissCompletion();
  };
  const openPlanEntry = (reference: PlanReference) => {
    if (
      state?.session.plan?.entries.some(
        (e) => e.id === reference.entryId && e.revision === reference.revision,
      )
    ) {
      setPlanOpen(true);
      requestAnimationFrame(() =>
        document.getElementById('plan-' + reference.entryId)?.scrollIntoView({ block: 'center' }),
      );
    } else setPlanSource(reference.messageId);
  };
  const accept = (choice: string, candidate = completion, directory = false) => {
    if (!candidate) return;
    const value =
      composer.text.slice(0, candidate.start) + choice + composer.text.slice(candidate.end);
    const cursor = candidate.start + choice.length;
    changeDraft(value, cursor);
    if (
      directory ||
      candidate.files?.entries.some((entry) => entry.value === choice && entry.directory)
    )
      void complete(true, value, cursor);
  };
  const complete = async (
    automatic = false,
    value = composer.text,
    cursor = input.current?.selectionStart ?? value.length,
  ) => {
    if (!current.current || !input.current) return;
    const request = ++completionRequest.current;
    const key = composer.roomKey;
    if (automatic)
      setCompletion({
        start: completionContext(value, cursor).start,
        end: cursor,
        suggestions: [],
        selected: 0,
        files: { directory: '', entries: [] },
        loading: true,
      });
    try {
      const result = await api<CompletionResult>('complete', {
        sessionId: current.current.session.id,
        value,
        cursor,
      });
      if (
        request !== completionRequest.current ||
        key !== composer.roomKey ||
        composer.text !== value ||
        input.current?.selectionStart !== cursor
      )
        return;
      const candidate = { ...result, end: cursor, selected: 0 };
      if (!automatic && result.suggestions.length === 1) accept(result.suggestions[0]!, candidate);
      else setCompletion(candidate);
    } catch (failure) {
      if (request === completionRequest.current && key === composer.roomKey) {
        dismissCompletion();
        composer.report((failure as Error).message);
      }
    }
  };
  useLayoutEffect(() => {
    document
      .getElementById(`completion-${completion?.selected}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [completion?.selected, completion?.files?.directory, completion?.loading]);
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (completion?.files?.parent && event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      accept(completion.files.parent, completion, true);
    } else if (
      completion?.suggestions.length &&
      ['ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)
    ) {
      event.preventDefault();
      if (event.key === 'Tab' && (completion.files || completion.suggestions.length === 1)) {
        accept(completion.suggestions[completion.selected]!);
        return;
      }
      const direction = event.key === 'ArrowUp' || event.shiftKey ? -1 : 1;
      setCompletion({
        ...completion,
        selected:
          (completion.selected + direction + completion.suggestions.length) %
          completion.suggestions.length,
      });
    } else if (
      !completion &&
      state &&
      ['ArrowUp', 'ArrowDown'].includes(event.key) &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.currentTarget.selectionStart === event.currentTarget.selectionEnd
    ) {
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      const caret = event.currentTarget.selectionStart;
      const atEdge =
        direction === -1
          ? !draft.slice(0, caret).includes('\n')
          : !draft.slice(caret).includes('\n');
      if (history.current.browsing || atEdge) {
        const value = history.current.move(
          direction,
          state.session.messages,
          formatReplyDraft(draft, replyTo),
        );
        if (value !== undefined) {
          event.preventDefault();
          const recalled = parseReplyDraft(value);
          changeDraft(recalled.text, recalled.text.length, {
            replyTo: recalled.replyTo,
            recalling: true,
          });
        } else if (history.current.browsing) event.preventDefault();
      }
    } else if (event.key === 'Escape') {
      if (completion) dismissCompletion();
      else if (replyTo) selectReply(undefined);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      void complete();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (completion?.suggestions.length) accept(completion.suggestions[completion.selected]!);
      else if (!completion?.files) send();
    } else if (
      (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) ||
      (event.key === 'j' && event.ctrlKey)
    ) {
      event.preventDefault();
      const start = event.currentTarget.selectionStart,
        end = event.currentTarget.selectionEnd;
      changeDraft(draft.slice(0, start) + '\n' + draft.slice(end), start + 1);
    } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) dismissCompletion();
  };
  const mention = (name: string) => {
    const leading = /^(?:@[a-z][a-z0-9_-]*\s+)*/.exec(draft)?.[0] ?? '';
    if (!leading.split(/\s+/).includes('@' + name))
      changeDraft(leading + '@' + name + ' ' + draft.slice(leading.length));
    input.current?.focus();
  };
  const closePanel = () => {
    panelRequest.current++;
    setSessions(undefined);
    setConfig(undefined);
    setAgentPanel(undefined);
  };
  const openPanel = (kind: 'sessions' | 'config') => {
    closePanel();
    const request = panelRequest.current;
    setPanelLoading(true);
    if (kind === 'sessions') setSessions([]);
    else setConfig(null);
    void api<SavedSession[]>(kind)
      .then((result) => {
        if (panelRequest.current !== request) return;
        if (kind === 'sessions') setSessions(result);
        else setConfig(result);
      })
      .catch((failure) => {
        if (panelRequest.current === request) {
          closePanel();
          composer.report(failure.message);
        }
      })
      .finally(() => {
        if (panelRequest.current === request) setPanelLoading(false);
      });
  };
  const disabled = connection !== 'live' || busy || Boolean(pending);
  const replyTarget = state?.session.messages.find((message) => message.id === replyTo);
  const imageWarning = state
    ? imageDraftWarning({
        line: formatReplyDraft(draft, replyTo),
        hasImages: Boolean(images.attachments.length),
        participants: state.agents,
        messages: state.session.messages,
        invalidRoom: connection === 'closed' || Boolean(state.fatal),
      })
    : undefined;
  const humanName = state?.humanName ?? 'You';
  const questions = state ? unansweredQuestions(state.session.messages) : [];
  const pinnedMessages = state ? pinnedMessageList(state.session) : [];
  const providers = Object.fromEntries(
    state?.agents.map((agent) => [agent.id, agent.provider]) ?? [],
  );
  const name = state?.workspace.split('/').filter(Boolean).at(-1) ?? 'Your workspace';
  const items = state ? timeline(state.session) : [];

  const questionKey = (id: string) => `${state?.instanceId}:${state?.session.id}:question:${id}`;
  const getQuestionDraft = (id: string): QuestionDraft => {
    const key = questionKey(id);
    if (questionDrafts[key]) return questionDrafts[key];
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? { text: '', editing: false };
    } catch {
      return { text: '', editing: false };
    }
  };
  const setQuestionDraft = (id: string, value: QuestionDraft) => {
    const key = questionKey(id);
    sessionStorage.setItem(key, JSON.stringify(value));
    setQuestionDrafts((old) => ({ ...old, [key]: value }));
  };
  const content = (
    <div className={`app-shell ${planOpen ? 'plan-open' : ''}`}>
      <aside className="sidebar">
        <a className="brand" href="/" onClick={(event) => event.preventDefault()}>
          <img src="/favicon.svg" alt="" />
          <span>
            Chittr<small>A room for thinking together</small>
          </span>
        </a>
        <div className="sidebar-label">WORKSPACE</div>
        <div className="workspace-card">
          <span className="folder-icon" aria-hidden="true">
            ⌑
          </span>
          <div>
            <strong>{name}</strong>
            <small title={state?.workspace}>{state?.workspace ?? 'Connecting…'}</small>
          </div>
        </div>
        <div className="sidebar-label">CONVERSATION</div>
        <button className="nav-item active" onClick={closePanel}>
          ◉ <span>Current room</span>
          <span className="count">{state?.session.messages.length ?? 0}</span>
        </button>
        <button className="nav-item" disabled={disabled} onClick={() => openPanel('sessions')}>
          ◷ <span>Saved conversations</span>
        </button>
        <button
          className="nav-item"
          disabled={disabled || !state?.idle}
          onClick={() => command('/new')}
        >
          ＋ <span>New conversation</span>
        </button>
        <div className="sidebar-label participants-label">
          IN THIS ROOM <span>{(state?.agents.filter((a) => a.enabled).length ?? 0) + 1}</span>
        </div>
        <div className="sidebar-person">
          <Avatar name={humanName} human />
          <div>
            <strong>{humanName}</strong>
            <small>You · @human</small>
          </div>
          <span className="presence" />
        </div>
        {state?.agents
          .filter((agent) => agent.provider !== undefined)
          .map((agent) => (
            <div
              className="sidebar-person"
              key={agent.id}
              role="group"
              aria-label={`Participant ${agent.id}`}
            >
              <Avatar name={agent.id} provider={agent.provider} />
              <div>
                <strong>{agent.id}</strong>
                <small>
                  {agent.provider ?? 'Removed agent'} · @{agent.id}
                  {!agent.enabled ? ' · disabled' : ''}
                </small>
                <dl className="participant-settings">
                  <div>
                    <dt>Model</dt>
                    <dd>{agent.model}</dd>
                  </div>
                  <div>
                    <dt>Effort</dt>
                    <dd>{agent.effort}</dd>
                  </div>
                </dl>
              </div>
              <span className={`presence ${agent.connection !== 'ready' ? 'offline' : ''}`} />
            </div>
          ))}
        <div className="sidebar-bottom">
          <button className="nav-item" disabled={disabled} onClick={() => openPanel('config')}>
            ⚙ <span>Room configuration</span>
          </button>
          <div className="theme-picker" role="group" aria-label="Theme">
            {themeChoices.map((choice) => (
              <button
                key={choice}
                aria-pressed={theme === choice}
                onClick={() => {
                  saveTheme(choice);
                  setTheme(choice);
                }}
              >
                {choice[0]!.toUpperCase() + choice.slice(1)}
              </button>
            ))}
          </div>
          <div className="local-note">
            <span className="presence" /> Running on your machine
          </div>
        </div>
      </aside>
      <main className="room">
        <header className="room-header">
          <div>
            <div className="eyebrow">
              {name} <span>/</span> conversation
            </div>
            <h1>
              Current room{' '}
              <span className={`connection ${connection}`}>
                {connection === 'live'
                  ? state?.session.paused
                    ? 'Paused'
                    : 'Live'
                  : connection === 'closed'
                    ? 'Saved & closed'
                    : connection === 'reconnecting'
                      ? 'Reconnecting…'
                      : 'Connecting…'}
              </span>
            </h1>
          </div>
          <div className="room-controls">
            <button disabled={!state} onClick={() => setPlanOpen(true)}>
              Plan
            </button>
            <button disabled={!state} onClick={() => setQuestionsOpen(true)}>
              Unanswered questions ({questions.length})
            </button>
            <button disabled={!state} onClick={() => setPinsOpen(true)}>
              Pinned messages ({pinnedMessages.length})
            </button>
            <button
              disabled={disabled}
              onClick={() => {
                setCompactInstructions('');
                setCompactTarget('');
              }}
            >
              Compact all
            </button>
            <button disabled={disabled} onClick={() => setCheckpointOpen(true)}>
              Checkpoint
            </button>
            <button
              disabled={disabled}
              onClick={() => command(state?.session.paused ? '/continue' : '/pause')}
            >
              {state?.session.paused ? '▷ Continue' : 'Ⅱ Pause'}
            </button>
            <button disabled={disabled} onClick={() => command('/stop')}>
              □ Stop
            </button>
            <button disabled={disabled} onClick={() => command('/quit')} className="quiet">
              Quit
            </button>
          </div>
        </header>
        <section className="participant-strip" aria-label="Agent activity">
          {state?.agents
            .filter((a) => a.enabled)
            .map((agent) => {
              const { status, statusDetail: detail } = agent;
              return (
                <div className={`agent-card ${agent.active ? 'is-active' : ''}`} key={agent.id}>
                  <div className="agent-status">
                    <Avatar name={agent.id} provider={agent.provider} />
                    <div>
                      <strong>{agent.id}</strong>
                      <span className="agent-activity" role="status">
                        {agent.active && <span className="pulse-dot" />}
                        {status}
                        {agent.paused ? ' · replies paused' : ''}
                      </span>
                    </div>
                    <button
                      className="agent-more"
                      aria-label={`Controls for ${agent.id}`}
                      onClick={() => setAgentPanel(agent.id)}
                    >
                      ···
                    </button>
                  </div>
                  <div className="agent-detail" title={detail}>
                    {detail}
                  </div>
                  <div className="agent-queue">
                    {agent.pending.queued ? `${agent.pending.queued} queued` : 'No queued messages'}
                    {agent.pending.capped ? ` · ${agent.pending.capped} at follow-up limit` : ''}
                    {agent.pending.unresolved ? ` · ${agent.pending.unresolved} unresolved` : ''}
                  </div>
                  <div
                    className="agent-context"
                    title={
                      agent.contextUsage
                        ? `Last reported ${new Date(agent.contextUsage.updatedAt).toLocaleString()}. Latest provider reading; updates when the provider reports usage.`
                        : 'No context reading has been reported for this session.'
                    }
                  >
                    <span>Context: {formatContextUsage(agent.contextUsage)}</span>
                    <button
                      aria-label={`Compact context for ${agent.id}`}
                      disabled={disabled || agent.connection !== 'ready' || agent.stopped}
                      onClick={() => {
                        setCompactInstructions('');
                        setCompactTarget(agent.id);
                      }}
                    >
                      Compact context
                    </button>
                    {agent.maintenance && (
                      <span role="status" title={agent.maintenance.detail}>
                        {maintenanceLabel(agent.maintenance)}: {agent.maintenance.status}
                        {agent.maintenance.status === 'waiting' && agent.maintenance.detail
                          ? ` · ${agent.maintenance.detail}`
                          : agent.maintenance.purpose !== 'recovery' &&
                            ` · ${agent.maintenance.route}`}
                        {agent.maintenance.instructions &&
                          (agent.maintenance.instructionsSupported
                            ? ' · custom focus requested'
                            : ' · custom focus unsupported; using default')}
                      </span>
                    )}
                    {agent.contextUsage?.maxTokens && (
                      <meter
                        aria-label={`Context usage for ${agent.id}`}
                        aria-valuetext={formatContextUsage(agent.contextUsage)}
                        min={0}
                        max={agent.contextUsage.maxTokens}
                        value={Math.min(
                          agent.contextUsage.usedTokens,
                          agent.contextUsage.maxTokens,
                        )}
                        className={
                          (contextPercent(agent.contextUsage) ?? 0) >= 90 ? 'context-high' : ''
                        }
                      />
                    )}
                  </div>
                </div>
              );
            })}
        </section>
        <div
          className="transcript"
          ref={scroll}
          aria-label="Conversation"
          tabIndex={0}
          onWheel={(event) => {
            if (event.deltaY < 0) {
              pinned.current = false;
              setFollowing(false);
            }
          }}
          onScroll={() => {
            const element = scroll.current!;
            lastScrollTop.current = element.scrollTop;
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 70;
            setFollowing(pinned.current);
          }}
        >
          <div className="transcript-inner">
            <div className="conversation-start">
              <span />
              {state
                ? new Date(state.session.createdAt).toLocaleDateString([], {
                    month: 'long',
                    day: 'numeric',
                  })
                : 'Your conversation'}
              <span />
            </div>
            {state && !items.length && (
              <div className="welcome">
                <div className="welcome-mark">✳</div>
                <h2>Bring everyone into the conversation.</h2>
                <p>
                  Ask a question, explore an idea, or point your agents at a file. Each agent can
                  contribute, collaborate, or let you know it has nothing to add.
                </p>
                <div className="suggested-prompts">
                  {['Help me understand this project.', 'What should we work on next?'].map(
                    (text) => (
                      <button
                        key={text}
                        onClick={() => {
                          changeDraft(text);
                          input.current?.focus();
                        }}
                      >
                        {text} ↗
                      </button>
                    ),
                  )}
                </div>
              </div>
            )}
            {items.map((entry) =>
              entry.kind === 'message' ? (
                <MessageCard
                  key={entry.item.id}
                  message={entry.item}
                  sessionId={state!.session.id}
                  view={setViewing}
                  humanName={humanName}
                  providers={providers}
                  command={command}
                  reply={selectReply}
                  planEntry={openPlanEntry}
                  planLinks={state!.session.plan?.entries
                    .filter((e) => e.roomQuestionId === entry.item.id)
                    .map((e) => ({ entryId: e.id, revision: e.revision, messageId: e.messageId }))}
                  pinned={entry.pinned}
                  disabled={disabled}
                />
              ) : (
                <details className="notice" key={entry.item.id}>
                  <summary>{entry.item.text.split('\n')[0]}</summary>
                  <pre>{entry.item.text}</pre>
                </details>
              ),
            )}
            {state?.agents
              .filter((agent) => agent.draft)
              .map((agent) => (
                <article className="message streaming" key={agent.id + ':draft'}>
                  <Avatar name={agent.id} provider={agent.provider} />
                  <div className="message-content">
                    <div className="message-heading">
                      <strong>{agent.id}</strong>
                      <span className="stream-label">
                        {agent.active ? 'Replying…' : 'Incomplete response'}
                      </span>
                    </div>
                    <MessageBody text={agent.draft} />
                  </div>
                </article>
              ))}
            {state &&
              Object.entries(state.session.exchanges)
                .filter(
                  ([id, exchange]) =>
                    exchange.used >= exchange.allowance &&
                    state.session.messages.some(
                      (m) =>
                        m.roots.includes(id) &&
                        Object.values(m.deliveries).some((d) => d.status === 'queued'),
                    ),
                )
                .map(([id]) => (
                  <div className="limit-notice" key={id}>
                    Exchange #{id} reached its follow-up limit.
                    <button disabled={disabled} onClick={() => command(`/continue #${id}`)}>
                      Allow more replies
                    </button>
                  </div>
                ))}
            {state?.fatal && (
              <div className="error-banner" role="alert">
                {state.fatal}
              </div>
            )}
          </div>
        </div>
        {!following && (
          <button
            className="jump-latest"
            onClick={() => {
              pinned.current = true;
              setFollowing(true);
              scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
            }}
          >
            ↓ Jump to latest
          </button>
        )}
        <footer className="composer-area">
          {composer.error && (
            <div className="error-banner" role="alert">
              {composer.error}
              <button aria-label="Dismiss error" onClick={() => composer.dismissError()}>
                ×
              </button>
            </div>
          )}
          {connection === 'closed' ? (
            <div className="closed-card">
              <strong>Conversation saved.</strong>
              <p>Launch chittr from this workspace to resume. You can close this tab.</p>
            </div>
          ) : (
            <>
              {pending && !busy && (
                <div className="pending-banner">
                  Checking the result of your last action is required before sending another.
                  <button disabled={!live} onClick={() => void composer.retryPending()}>
                    Check last action
                  </button>
                </div>
              )}
              <div
                className="composer-box"
                onDragOver={(event) => {
                  if (event.target !== input.current || event.dataTransfer.types.includes('Files'))
                    event.preventDefault();
                }}
                onDrop={(event) => {
                  const files = Array.from(event.dataTransfer.files);
                  if (!files.length && event.target === input.current && !disabled) return;
                  event.preventDefault();
                  if (disabled) return;
                  if (files.length) composer.stage(files);
                  else composer.report('Drop image files to attach them. URLs are not fetched.');
                }}
              >
                {replyTo && (
                  <div className="reply-preview" role="group" aria-label="Reply preview">
                    <div>
                      <strong>
                        Replying to{' '}
                        {replyTarget?.author === 'human'
                          ? humanName
                          : '@' + (replyTarget?.author ?? 'unknown')}{' '}
                        #{replyTo}
                      </strong>
                      <p>
                        {replyTarget ? imageSummary(replyTarget) : 'Original message unavailable'}
                      </p>
                      <small>Use leading @names to choose different recipients.</small>
                    </div>
                    <button
                      disabled={disabled}
                      aria-label="Cancel reply"
                      onClick={() => selectReply(undefined)}
                    >
                      ×
                    </button>
                  </div>
                )}
                <div className="composer-heading">
                  <span className="composer-author">{humanName}</span>
                  <span>{replyTo ? 'Reply to message' : 'Message the room'}</span>
                  <div className="mention-buttons">
                    {state?.agents
                      .filter((a) => a.enabled)
                      .map((agent) => (
                        <button
                          disabled={disabled}
                          key={agent.id}
                          onClick={() => mention(agent.id)}
                        >
                          @{agent.id}
                        </button>
                      ))}
                  </div>
                </div>
                <textarea
                  ref={input}
                  aria-label="Message"
                  placeholder="What's on your mind? Use @ to address an agent."
                  value={draft}
                  disabled={!state || busy || Boolean(pending)}
                  aria-autocomplete="list"
                  aria-controls={completion ? 'completion-options' : undefined}
                  aria-activedescendant={
                    completion?.suggestions.length ? `completion-${completion.selected}` : undefined
                  }
                  onChange={(event) => {
                    const browsing = Boolean(completion?.files);
                    changeDraft(event.target.value);
                    const cursor = event.target.selectionStart;
                    const match = /@[a-z0-9_-]*$/.exec(event.target.value.slice(0, cursor));
                    if (
                      fileReferenceActive(event.target.value, cursor) ||
                      (browsing && completionContext(event.target.value, cursor).token)
                    )
                      void complete(true, event.target.value, cursor);
                    else if (match && state)
                      setCompletion({
                        start: cursor - match[0].length,
                        end: cursor,
                        selected: 0,
                        suggestions: [
                          'human',
                          ...state.agents.filter((a) => a.enabled).map((a) => a.id),
                        ]
                          .filter((n) => n.startsWith(match[0].slice(1)))
                          .map((n) => '@' + n + ' '),
                      });
                  }}
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.files);
                    if (files.length) {
                      event.preventDefault();
                      composer.stage(files);
                    }
                  }}
                  onKeyDown={keyDown}
                  onClick={dismissCompletion}
                  onBlur={dismissCompletion}
                  rows={3}
                />
                <div className="draft-images" aria-label="Draft images">
                  {images.attachments.map((attachment) => (
                    <div
                      className="image-tile"
                      key={attachment.id}
                      data-attachment-id={attachment.id}
                    >
                      <HostImage attachment={attachment} sessionId={state!.session.id} />
                      <span>{attachment.filename}</span>
                      <button
                        disabled={disabled}
                        aria-label={`Remove image ${attachment.filename}`}
                        onClick={() => composer.removeAttachment(attachment.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {images.uploads.map((item) => (
                    <div className="image-tile upload-item" key={item.operationId}>
                      <span>{item.filename}</span>
                      <span role="status">
                        {item.status === 'pending' ? 'Uploading…' : item.error}
                      </span>
                      {item.status === 'failed' && (
                        <>
                          {item.file || item.attachment ? (
                            <button
                              disabled={disabled}
                              aria-label={`Retry upload ${item.filename}`}
                              onClick={() => composer.retryUpload(item)}
                            >
                              Retry upload
                            </button>
                          ) : (
                            <label>
                              Retry {item.source?.name ?? item.filename}
                              <input
                                aria-label={`Reselect ${item.source?.name ?? item.filename}`}
                                type="file"
                                accept="image/*"
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  if (file) composer.retryUpload(item, file);
                                }}
                              />
                            </label>
                          )}
                        </>
                      )}
                      <button
                        disabled={disabled}
                        aria-label={`Remove image ${item.filename}`}
                        onClick={() => composer.removeUpload(item)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                {imageWarning && (
                  <div className="image-status-warning" role="status">
                    {imageWarning.recipients.map((recipient) => (
                      <div key={recipient.id}>{imageWarningLine(recipient)}</div>
                    ))}
                    <details>
                      <summary>Details</summary>
                      <ul>
                        {imageWarning.recipients.map((recipient) => (
                          <li key={recipient.id}>
                            @{recipient.id}: {recipient.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                )}
                {images.error && (
                  <div role="alert">
                    {images.error}
                    {images.removalId ? (
                      <button onClick={() => composer.retryRemoval()}>Retry image removal</button>
                    ) : (
                      <button onClick={() => composer.dismissAttachmentError()}>
                        Dismiss attachment error
                      </button>
                    )}
                  </div>
                )}
                {images.saveStatus && (
                  <div role="status">
                    {images.saveStatus}
                    <button onClick={() => composer.retryDraftSave()}>Retry draft save</button>
                  </div>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  aria-label="Select images"
                  onChange={(event) => {
                    composer.stage(Array.from(event.target.files ?? []));
                    event.target.value = '';
                  }}
                />
                <button
                  className="attach-button"
                  disabled={disabled}
                  onClick={() => fileInput.current?.click()}
                >
                  Attach images
                </button>
                {completion && (completion.files || completion.suggestions.length > 0) && (
                  <div
                    className={`completions${completion.files ? ' file-explorer' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    {completion.files && (
                      <div className="file-explorer-heading">
                        {completion.files.parent && (
                          <button
                            type="button"
                            aria-label="Up one folder"
                            onClick={() => accept(completion.files!.parent!, completion, true)}
                          >
                            ↑
                          </button>
                        )}
                        <div>
                          <strong>File explorer</strong>
                          <span title={completion.files.directory}>
                            {completion.files.directory || './'}
                          </span>
                        </div>
                        <button
                          type="button"
                          aria-label="Close file explorer"
                          onClick={dismissCompletion}
                        >
                          ×
                        </button>
                      </div>
                    )}
                    <div
                      id="completion-options"
                      role="listbox"
                      aria-label={completion.files ? 'File explorer' : 'Completions'}
                    >
                      {completion.suggestions.map((item, index) => (
                        <button
                          id={`completion-${index}`}
                          key={item}
                          role="option"
                          aria-label={
                            completion.files
                              ? `${completion.files.entries[index]?.directory ? 'Open folder' : 'Insert file'} ${completion.files.entries[index]?.label}`
                              : undefined
                          }
                          aria-selected={index === completion.selected}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => accept(item)}
                        >
                          {completion.files ? (
                            <>
                              <span aria-hidden="true" className="file-explorer-icon">
                                {completion.files.entries[index]?.directory ? '▸' : '·'}
                              </span>
                              {completion.files.entries[index]?.label}
                            </>
                          ) : item.trim() === '@human' ? (
                            `${humanName} (@human)`
                          ) : (
                            item
                          )}
                        </button>
                      ))}
                    </div>
                    {completion.files && (
                      <div className="file-explorer-hint">
                        {completion.loading
                          ? 'Loading…'
                          : (completion.files.error ??
                            (completion.suggestions.length
                              ? completion.files.truncated
                                ? 'First 200 matches. Keep typing to filter.'
                                : 'Type to filter · Enter or Tab to select · Esc to close'
                              : 'No matching files or folders.'))}
                      </div>
                    )}
                  </div>
                )}
                <div className="composer-toolbar">
                  <span>
                    Enter to send{' '}
                    <span className="hint-extra">
                      · Shift+Enter for newline · ./ to browse files
                    </span>
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      disabled ||
                      (!draft.trim() && !images.attachments.length) ||
                      Boolean(images.uploads.length)
                    }
                    onClick={send}
                  >
                    {busy ? 'Sending…' : 'Send'} <span aria-hidden="true">↑</span>
                  </button>
                </div>
              </div>
              <div className="composer-note">
                {state?.commandAccess.mode === 'trusted' ? (
                  <span className="command-access" role="status">
                    {state.commandAccessDescription}
                  </span>
                ) : (
                  <>
                    <span>
                      Agents can inspect files in <strong>{name}</strong>.
                    </span>
                    <span>
                      {state?.permissions.edits ? 'Edits allowed' : 'Edits off'} ·{' '}
                      {state?.permissions.commands ? 'Commands sandboxed' : 'Commands off'} ·{' '}
                      {state?.permissions.network ? 'Network allowed' : 'Network off'}
                    </span>
                    {state?.commandAccess.source && (
                      <span className="command-access" role="status">
                        {state.commandAccessDescription}
                      </span>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </footer>
      </main>
      {state && (
        <PlanPane
          key={state.session.id}
          view={state.session.plan}
          messages={state.session.messages}
          sessionId={state.session.id}
          instanceId={state.instanceId}
          live={live && !state.fatal}
          open={planOpen}
          close={() => setPlanOpen(false)}
          source={setPlanSource}
          refresh={async () => {
            composer.accept(await api<WebState>('state'));
          }}
        />
      )}
      {planSource && state && (
        <Dialog title={'Public message #' + planSource} close={() => setPlanSource(undefined)}>
          {state.session.messages
            .filter((m) => m.id === planSource)
            .map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                sessionId={state.session.id}
                view={setViewing}
                humanName={humanName}
                providers={providers}
                command={command}
                reply={selectReply}
                pinned={state.session.pinnedMessageIds.includes(message.id)}
                disabled={disabled}
                planEntry={openPlanEntry}
              />
            ))}
        </Dialog>
      )}
      {viewing && state && (
        <ImageViewer
          key={`${state.session.id}:${viewing.id}`}
          attachment={viewing}
          sessionId={state.session.id}
          close={() => setViewing(undefined)}
        />
      )}
      {compactTarget !== undefined && (
        <Dialog
          title={compactTarget ? `Compact context for ${compactTarget}` : 'Compact all agents'}
          close={() => setCompactTarget(undefined)}
        >
          <p>
            Wait for each agent's current turn, then compact its context. Stopped or unavailable
            agents are skipped when compacting all. Stop cancels compaction.
          </p>
          <label htmlFor="compact-instructions">Optional focus instructions</label>
          <textarea
            id="compact-instructions"
            value={compactInstructions}
            onChange={(e) => setCompactInstructions(e.target.value)}
            placeholder="Remember the epic and ticket details"
          />
          <p>
            Providers that support custom focus receive these instructions. Others compact normally
            and report that the focus is unsupported.
          </p>
          <button
            disabled={disabled || byteSize(compactInstructions.trim()) > 4096}
            onClick={() => {
              command(
                `/compact${compactTarget ? ` @${compactTarget}` : ''} --${compactInstructions.trim() ? ` ${compactInstructions.trim()}` : ''}`,
              );
              setCompactTarget(undefined);
            }}
          >
            Start compaction
          </button>
          {byteSize(compactInstructions.trim()) > 4096 && (
            <p role="alert">Focus instructions must fit within 4096 UTF-8 bytes.</p>
          )}
        </Dialog>
      )}
      {questionsOpen && (
        <Dialog title="Unanswered questions" close={() => setQuestionsOpen(false)}>
          {questions.length ? (
            questions.map((message) => (
              <section className="pinned-message" key={message.id}>
                <h3>
                  #{message.id} · @{message.author}
                </h3>
                <MessageBody text={imageSummary(message)} />
                <QuestionActions message={message} disabled={disabled} />
                <button
                  onClick={() => {
                    setQuestionsOpen(false);
                    pinned.current = false;
                    setFollowing(false);
                    requestAnimationFrame(() =>
                      document.getElementById(message.id)?.scrollIntoView({ block: 'center' }),
                    );
                  }}
                >
                  Go to message
                </button>
              </section>
            ))
          ) : (
            <p>No unanswered questions.</p>
          )}
        </Dialog>
      )}
      {pinsOpen && (
        <Dialog title="Pinned messages" close={() => setPinsOpen(false)}>
          {pinnedMessages.length ? (
            pinnedMessages.map((message) => (
              <section className="pinned-message" key={message.id}>
                <h3>
                  #{message.id} · {message.author === 'human' ? humanName : '@' + message.author}
                </h3>
                <MessageBody text={imageSummary(message)} />
                <div className="pin-actions">
                  <button
                    onClick={() => {
                      setPinsOpen(false);
                      pinned.current = false;
                      setFollowing(false);
                      requestAnimationFrame(() =>
                        document.getElementById(message.id)?.scrollIntoView({ block: 'center' }),
                      );
                    }}
                  >
                    Go to message
                  </button>
                  <button disabled={disabled} onClick={() => command(`/unpin #${message.id}`)}>
                    Unpin
                  </button>
                  {message.text && <CopyButton text={message.text} />}
                </div>
              </section>
            ))
          ) : (
            <p>No pinned messages. Use a message's Pin button or /pin #message-id.</p>
          )}
        </Dialog>
      )}
      {checkpointOpen && (
        <Dialog title="Shared context checkpoint" close={() => setCheckpointOpen(false)}>
          {state?.session.checkpoint ? (
            <>
              <p>
                Version {state.session.checkpoint.version} · through #
                {state.session.checkpoint.messageId} · source @
                {state.session.checkpoint.sourceAgent}
              </p>
              <p>Fallible conversation evidence. Original messages remain in the conversation.</p>
              {state.session.checkpoint.entries.map((entry, index) => (
                <section key={index}>
                  <h3>{entry.category}</h3>
                  <p>{entry.text}</p>
                  <p>
                    Sources:{' '}
                    {entry.sources
                      .map((source) => `#${source.messageId} @${source.author}`)
                      .join(', ')}
                  </p>
                </section>
              ))}
            </>
          ) : (
            <p>No checkpoint has been accepted for this conversation.</p>
          )}
        </Dialog>
      )}
      {agentPanel && (
        <Dialog title={`Controls for ${agentPanel}`} close={() => setAgentPanel(undefined)}>
          <p>
            Pause lets the active turn finish. Stop interrupts it. Reconnect restores the agent with
            queued work paused. Compact context waits for this agent's turn, then reclaims its
            context while peers keep working. Stop cancels compaction.
          </p>
          <div className="agent-actions">
            {['pause', 'stop', 'continue', 'reconnect', 'compact'].map((action) => (
              <button
                key={action}
                disabled={disabled}
                onClick={() => {
                  if (action === 'compact') {
                    setCompactInstructions('');
                    setCompactTarget(agentPanel);
                  } else command(`/${action} @${agentPanel}`);
                  setAgentPanel(undefined);
                }}
              >
                {action[0]!.toUpperCase() + action.slice(1)}
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {(sessions || config !== undefined) && (
        <Dialog title={sessions ? 'Saved conversations' : 'Room configuration'} close={closePanel}>
          {panelLoading ? (
            <p role="status">Loading…</p>
          ) : sessions ? (
            <>
              <p>Pause or stop active agents before changing conversations.</p>
              {sessions.length ? (
                sessions.map((saved) => (
                  <button
                    className="saved-session"
                    key={saved.id}
                    disabled={disabled || !state?.idle}
                    onClick={() => {
                      setSessions(undefined);
                      command('/sessions ' + saved.id);
                    }}
                  >
                    <strong>{saved.preview}</strong>
                    <span>
                      {saved.count} messages · {new Date(saved.updatedAt).toLocaleString()}
                      {saved.id === state?.session.id ? ' · Current' : ''}
                    </span>
                  </button>
                ))
              ) : (
                <p>No saved conversations yet.</p>
              )}
            </>
          ) : (
            <>
              <p>Change the YAML files, then reload while agents are idle.</p>
              <pre>{JSON.stringify(config, null, 2)}</pre>
              <button
                disabled={disabled || !state?.idle}
                onClick={() => {
                  setConfig(undefined);
                  command('/reload');
                }}
              >
                Reload configuration
              </button>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
  return (
    <QuestionContext.Provider
      value={{
        session: state ? questionSession(state) : undefined,
        getDraft: getQuestionDraft,
        setDraft: setQuestionDraft,
        submit: async (id, line) => {
          const run = composer.command(line, live);
          if (!run) return;
          const key = questionKey(id);
          const draft = getQuestionDraft(id);
          const error = await run;
          const value = { ...draft, error };
          sessionStorage.setItem(key, JSON.stringify(value));
          setQuestionDrafts((old) => ({ ...old, [key]: value }));
        },
      }}
    >
      {content}
    </QuestionContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
