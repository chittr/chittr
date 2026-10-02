# Display contract

`src/snapshot.ts` is the public boundary between the room engine and every
renderer. A change to how existing conversation facts are presented needs this
document, the public declarations, the renderer being changed and its focused
tests. It does not need `Room`, the adapters, the projection body or the other
renderer. Adding a new source fact may still need a producer change.

The public declarations are the exported types and function signatures of
`src/snapshot.ts` (`npm run build` emits them without bodies as
`dist/snapshot.d.ts`), the shared value types in `src/types.ts` (`Message`,
`Notice`, `AttachmentMetadata`, `Checkpoint`, `Exchange`, `Permissions`,
`CommandAccess`, `MaintenanceState`, `ContextUsage`), `ImagePathSupport` in
`src/image-support.ts`, and the two question helper signatures below.

## Reads

| Export                                                   | Cost                                 | Use                                                                            |
| -------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| `projectRoom(room): RoomSnapshot`                        | Full: scans messages once per agent  | Everything a frame or SSE payload shows. Terminal `draw()`, `WebUI.snapshot()` |
| `completionInputs(room): { workspace, enabledAgentIds }` | Config only                          | Recipient, command and path completion                                         |
| `historyInputs(room): { humanName, messages }`           | Config and the borrowed message list | Composer prefix width and history recall                                       |
| `stagedAttachments(room): AttachmentMetadata[]`          | Session field only                   | Attachment-action completion; `[]` when nothing is staged                      |
| `timeline(session)`, `pinnedMessages(session)`           | Render-time, over `snapshot.session` | Transcript order, pinned dialog and count                                      |
| `questionSession(snapshot)`                              | Render-time                          | The `QuestionSession` argument of `questionDetails` and `consultationStatus`   |
| `providerDefault(value?)`                                | Pure                                 | The `'provider default'` fallback for a missing model or effort                |

`room` is a `RoomSource`: the structural surface `Room` satisfies (`config`,
`session`, `fatal`, `isIdle()`, `pending(id)`, `initialImageSupport(id)`). The
module imports no engine code; its runtime dependencies are `command-access.ts`
and `participant-status.ts`, so browser code can import it.

The narrow reads never project, never derive per-agent status, pending counts or
image support, and never traverse history. Read them where the fact is used, so
a reload or a resumed held display sees current values.

## Freshness and aliasing

A projection is current when read. It is not a detached snapshot and not safe to
keep across asynchronous work: take a new read after anything may have changed.
`projectRoom` performs no mutation or lifecycle action.

Borrowed, by reference, from live engine or config state: `permissions`,
`commandAccess` with its nested `blockedBy` entries when config supplies one,
`session.messages` and every message with its `attachments`, `session.notices`,
`session.exchanges`, `session.pinnedMessageIds` and `session.composerAttachments`
when the session has them, `session.checkpoint`, and each agent's
`contextUsage`, `maintenance` and `active.messageIds`. `initialImageSupport` is
whatever object the producer returns: an adapter may hand back its own cached
report, so treat it as borrowed too. Later engine appends are visible through
these references; replacements are not. Fresh per read: the snapshot object,
`session`, `agents`, each agent object, `active`, `pending`, `sessionAgentIds`,
a `commandAccess` resolved from the fallback, and any resolved default such as
the empty attachment or pin list. Never mutate borrowed data. The helpers do
not sort or mutate their inputs.

The projection is plain JSON data: objects, arrays and primitives, no class
instances, `Map`, `Set` or functions. Optional fields whose value is `undefined`
are omitted by JSON.

## `RoomSnapshot`

Every field of the browser wire state except the transport fields `instanceId`
and `revision`, which `WebState` adds on top.

| Field                      | Meaning                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`                | Launch directory                                                                                                                        |
| `humanName`                | Configured display name, resolved to `'You'`                                                                                            |
| `permissions`              | The room-wide policy the session carries, copied from current config                                                                    |
| `commandAccess`            | Config value, or `resolveCommandAccess(config)` when config has none; `mode` is the header's command mode, `source` marks a trust grant |
| `commandAccessDescription` | `commandAccessSummary(config)`, the single description authority                                                                        |
| `idle`                     | No run, connection or maintenance in progress                                                                                           |
| `fatal`                    | Present only when the room stopped; renderers show it verbatim                                                                          |
| `sessionAgentIds`          | Every session agent in insertion order, including agents removed from config                                                            |
| `agents`                   | Config-first union of configured and session agents, see below                                                                          |

`session`: `id`, `createdAt`, `paused`, optional `recoveryRequired`,
`composerDraft` (`''` when unset), `composerAttachments` (`[]` when unset),
`composerDraftRevision` (`0` when unset), `messages`, `pinnedMessageIds` (`[]`
when unset), `notices`, `exchanges`, and the latest `checkpoint` when one exists.

Attachment metadata on messages and in `composerAttachments` is display data:
an opaque host id, a filename that is never a path, media type, byte size and
dimensions. Staged metadata lives until the draft is sent or the reference is
removed; message metadata is permanent. `composerDraftRevision` is the draft
clock a client echoes back on attachment sends. Reference semantics and
ownership are in [the attachment contract](attachments-contract.md).

## Agents

Membership is the config-first union: configured agents in config order, then
session-only agents in session order. A retained session-only agent keeps its
state, has no `provider`, is `enabled: false` and carries no image report. A
configured agent absent from session state gets the defaults `connecting`,
`available`, unpaused, unstopped, empty draft, and the status pair `Connecting` /
`Starting the provider session`.

| Field                                       | Meaning                                                                                                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`, `enabled`                       | From config; `provider` is absent only for session-only agents                                                                                                                                                       |
| `model`, `effort`                           | Config values through `providerDefault`                                                                                                                                                                              |
| `connection`, `activity`, `detail`, `error` | Raw state: transport state, what the agent is doing, its current tool or note, and its last failure                                                                                                                  |
| `paused`, `stopped`, `recoveryRequired`     | Holds on this agent, below; `paused` and `stopped` are resolved booleans, `recoveryRequired` is optional                                                                                                             |
| `contextUsage`, `maintenance`               | Raw state, borrowed                                                                                                                                                                                                  |
| `draft`, `active`                           | Streaming text (`''` when none) and `{ startedAt, messageIds }` of the running turn; no provider-private state                                                                                                       |
| `pending`                                   | `{ queued, capped, unresolved }` delivery counts for this recipient, below                                                                                                                                           |
| `initialImageSupport`                       | The engine's current report for configured enabled agents only, with its availability, status and reason preserved; read by the staged-image warning and `/participants`, not rendered in the sidebar or agent cards |
| `status`, `statusDetail`                    | `participantStatus` applied to the projected fields, once per agent                                                                                                                                                  |

Holds. `paused` means replies to this agent are held: queued deliveries are not
dispatched, while a turn already running finishes. `stopped` means its provider
session was ended and `/continue` reconnects it: a manual `/stop` also pauses
it and sets `detail` to `Stopped; /continue reconnects`, while a session
restored under a recovery hold sets `Recovery hold; /reconnect or /continue
reconnects`; show `status` and `statusDetail` rather than assuming one text. An
agent
`recoveryRequired` means interrupted context maintenance holds that agent until
`/reconnect`; the session-level `recoveryRequired` holds every agent until the
affected ones are reconnected. `session.paused` is the room-wide hold from
`/pause` with no agent. Each is absent or `false` when not in force.

Queues. `pending.queued` counts messages whose delivery to this agent is still
`queued`; `capped` is the subset of those, from agents rather than the human,
whose originating exchange has used its follow-up allowance and waits for
`/continue #id`; `unresolved` counts `failed` and `interrupted` deliveries,
which only an explicit `/retry` re-dispatches.

Status ladder, as `src/participant-status.ts` implements it: running maintenance
on an unstopped agent wins, showing `Catching up on the chat` for recovery or a
connecting agent and `Compacting context` otherwise, with the maintenance detail
or `Preparing the chat context`. Otherwise `Stopped`, `Connecting`,
`Unavailable`, `Waiting for you`, `Available`, or the capitalised activity.
`statusDetail` is `error`, then `detail`, then `Starting the provider session`
while connecting, `Working on the conversation` while a turn is active, else
`Ready for your next message`. Only the projection computes this pair;
renderers show it, and the `Catch-up` / `Compaction` label comes from
`maintenanceLabel(maintenance)`.

Two orders exist. `agents` is config-first and drives notices, browser lists and
`/participants`. The terminal strip and streaming drafts follow
`sessionAgentIds`, filtered to agents with a `provider` for the strip. Reload can
change config order while session order stays put.

## Messages

`Message` is the saved public record, unchanged by the projection. Renderers
read `id` (`m1`, `m2`, …), `sequence` (the monotonic order), `author` (`human`
or an agent id), `recipients` (`human` or agent ids), `text`, `createdAt`,
`replyTo` (message ids), `deliveries` (per recipient `{ status, rationale? }`)
and optional `attachments`; `roots` (originating exchange ids) is engine
bookkeeping that renderers ignore but fixtures must supply. A question is a message with
`question: { choices, prompt?, frozenAnswerId? }`, where `prompt` replaces
`text` when present and `frozenAnswerId` is a legacy question's frozen
historical answer (`null` when it stayed open). A consultation round is a human
message with `consultation: { questionId }`; a recommendation is an agent
message with `recommendation: { questionId, answer, reasoning }`; a resolving
answer is a human message with `finalAnswer: { questionId }`. `Notice` is
`{ id, text, createdAt }`.

## Timeline and pins

`timeline(session)` lists messages then notices, stable-sorted by `createdAt`
with `localeCompare`, and adds `pinned` to message entries. Equal timestamps keep
each list's own order and put messages before notices. `pinnedMessages(session)`
returns pinned messages in `session.messages` order, which is sequence order,
even when timestamps tie or run backwards. Neither becomes a snapshot field and
neither is sent over SSE.

## Questions

Import from `src/questions.ts`:

- `unansweredQuestions(messages: Message[]): Message[]` is the only unanswered
  filter. A question is a message with `question` from an agent. It is resolved
  only by a later human message `answer` that has `author: 'human'`, no
  `consultation`, no `recommendation`, a higher `sequence`, `replyTo` containing
  the question id and `recipients` containing the asker, and that either
  - is an explicit final answer: `finalAnswer.questionId` equals the question
    id, `answer` carries no `question`, and both `replyTo` and `recipients`
    have exactly one entry; or
  - is the frozen historical answer: `answer.id` equals the question's
    `question.frozenAnswerId` and `answer` has no `finalAnswer`.

  Consultation rounds and recommendations are advice and leave it open. A
  plain-data resolving answer to `m1` asked by `codex`:

  ```ts
  { id: 'm2', sequence: 2, author: 'human', recipients: ['codex'], replyTo: ['m1'],
    finalAnswer: { questionId: 'm1' }, text: 'Left', createdAt: '…', roots: ['m1'], deliveries: {} }
  ```

- `questionDetails(session: QuestionSession, question: Message): string` renders
  the prompt, numbered choices, the answered or awaiting block, each opinion
  round with a per-agent `consultationStatus`, and any advice. Pass
  `questionSession(snapshot)`: it supplies `messages`, `paused`,
  `recoveryRequired` and `agents` keyed by id from the projected agents, so a
  queued delivery to a paused agent reads `queued · paused` and one to an agent
  absent from the session reads `queued · unavailable`, exactly as the engine's
  own session would.

## Renderer example

```ts
import { timeline, type RoomSnapshot } from '../src/snapshot.js';
import { unansweredQuestions } from '../src/questions.js';

export function headers(snapshot: RoomSnapshot): string[] {
  const open = new Set(unansweredQuestions(snapshot.session.messages).map((m) => m.id));
  return timeline(snapshot.session).flatMap((entry) =>
    entry.kind === 'message'
      ? [
          `${entry.item.author === 'human' ? snapshot.humanName : entry.item.author}  #${entry.item.id}` +
            `${entry.pinned ? '  [pinned]' : ''}${open.has(entry.item.id) ? '  [open]' : ''}`,
        ]
      : [],
  );
}
```

`test/terminal-display.test.ts` builds `RoomSnapshot` fixtures this way and calls
`transcript()` without a `Room`.

## Consumers

`RoomController.snapshot()` returns `projectRoom(room)`; `WebUI.snapshot()` adds
the transport fields; `/participants`, `/pins` and `/config` read the snapshot's
human name, command access, description and status pair. The terminal takes one
projection per frame after its held-display early return, and uses the narrow
reads in completion and vertical movement. The browser renders `timeline`,
`pinnedMessages`, `unansweredQuestions` and agent `status` / `statusDetail`, and
passes `questionSession(state)` to its question cards. `imageDraftWarning`
receives the projected agents and messages and remains the warning authority:
only a staged image shows image status before send. Both interfaces render one
`imageWarningLine` per affected recipient; the browser keeps each full reason
behind a collapsed **Details** control, and the terminal points to
`/attach --status`, which prints them through `formatImageRecipientStatus`.
`/participants` lists every agent's report. The browser sidebar and agent cards
show no image status.
