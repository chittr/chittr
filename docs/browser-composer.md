# Browser composer module

`web/composer.ts` owns the browser's recoverable composer state and its transitions.
`web/main.tsx` is a thin React binding: it renders the observable state, routes user
intentions, and keeps everything that is not recovery. This is A3 of the chaired
architecture decision in #37; it consumes the
[composer submission result](attachments-contract.md#composer-submission-result) that A2
(#94) added and reuses `AttachmentDraft` for upload and ownership work.

## Boundary

| Owner                | Responsibility                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ComposerController` | Text and reply target, the 64 KiB limit, local draft persistence, snapshot acceptance and conversation change, `AttachmentDraft` lifecycle, save eligibility and captured text, submission eligibility, command identity and retention, retry, acknowledgement mapping, command feedback. |
| `AttachmentDraft`    | Upload ordering and queueing, upload retry identity, host-reference ownership and reconciliation, persisted failed-upload metadata. Unchanged; composed, not copied.                                                                                                                      |
| `web/api.ts`         | Authentication, HTTP, the per-tab draft version allocator. Injected into the module as concrete mechanisms (`ComposerTransport`).                                                                                                                                                         |
| `web/main.tsx`       | Event-stream subscription and connection presentation, history navigation, completion, layout, scroll, focus, caret, keyboard, clipboard events, question UI, the 250 ms save timer and page-hide event, and the disabled-unless-live retry button.                                       |

The binding supplies connection liveness as an input to `submit` and `command`; the module
does not observe the event stream. It receives snapshots through `accept` and is told, through
events, when a snapshot was accepted and whether the conversation changed, when an
acknowledgement replaced the composer text (so `ComposerHistory` resets), and when a
successful `/quit` produced no snapshot (so the connection is presented as closed).

## Lifecycle, identity and storage

The JSDoc on `ComposerController` is the reference. In short: one controller per page;
`accept` takes every host snapshot, rejects one older than the presented snapshot for the same
instance, and on an instance/session change deactivates the previous `AttachmentDraft` and
restores the new conversation's local draft, pending command and interrupted uploads from
storage. Instance/session scoped keys are `chittr:<instanceId>:<sessionId>:draft` and
`:pending`; session scoped keys are `chittr:<sessionId>:image-send` (an unresolved attachment
send, preferred over `:pending`) and `chittr:<sessionId>:uploads`. No `File` bytes are stored.
The host revision protocol, the draft version allocator and the request `baseRevision` are
transport inputs and stay as they were.

## Intentions and outcomes

| Intention                                  | Outcome                                                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit(text, {replyTo})`, `selectReply(id)` | `true` and the formatted draft is stored, or `false` with the existing limit message as feedback.                                                                                                                |
| `captureSave()`                            | `undefined` before a snapshot, while pending, or while busy; otherwise a capture whose `save(keepalive)` writes the captured text unless the text or conversation moved on.                                      |
| `submit(live)`                             | `undefined` when not eligible; otherwise waits for attachment work, rechecks the conversation and text, allocates one command id and draft version, sends, and settles after the acknowledgement or its failure. |
| `retryPending()`                           | Resends the retained request unchanged. The binding supplies no recovery input.                                                                                                                                  |
| `command(line, live)`                      | `undefined` when not eligible (no snapshot, not live, pending, or sending); otherwise the error string, including transport errors, or `undefined` on success. Never clears composer text.                       |

## Acknowledgement mapping

Three sources are kept apart. A2's `CommandResult.submission` describes operation A; the
snapshot fetched after a successful command describes current host state; the local text has
its own freshness. The result of the last answered command is retained unchanged as
`outcome` (request, originating conversation key, and the four facts), so the command error
in `error` never stands in for the commitment, recovery or resulting-session facts. Every
valid A2 combination maps as follows:

| `ok` / dispatch                     | commitment                        | recovery                                     | Browser state                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true` / `sent`, text-only send     | `not-applicable`                  | `not-needed`                                 | State fetched and accepted. Stored text is cleared to empty while it still equals the submitted line; in-memory text and reply target are cleared while the conversation and submitted line still match. Intervening host text is not adopted. Pending cleared.                                                                          |
| `true` / `sent`, attachment send    | `committed`                       | `not-needed`                                 | State fetched and accepted. In the same instance and session the snapshot's composer text replaces matching submitted text under the same freshness guards, and `AttachmentDraft.reconcile` adopts its references. For another instance or session, matching submitted text is cleared to empty and nothing is adopted. Pending cleared. |
| `true` / `sent`, `/quit`            | `not-applicable`                  | `not-needed`                                 | No state fetch; the binding presents the connection as closed. Pending cleared.                                                                                                                                                                                                                                                          |
| `false` / `failed`, `command-error` | `not-applicable` or `uncommitted` | `restored`, `skipped` (any reason), `failed` | The original command error is the feedback; the recovery error is not presented. Local text, reply target and stored draft are kept. Pending and its storage are cleared. A later submission is a new operation.                                                                                                                         |
| `false` / `failed`, `command-error` | `committed`                       | any                                          | As above: the error is kept, pending is cleared, the text is kept. Committed work is not acknowledged as a UI success, and the next submission carries a new identity. The real HTTP cache and commit guarantee is A2's acceptance evidence; the module tests inject this response shape.                                                |
| `operation-conflict`                | any                               | `skipped` / `ineligible`                     | Arrives as an HTTP 409 exception (below), never as a result.                                                                                                                                                                                                                                                                             |
| Exception before the result         |                                   |                                              | A transport error or an error status is not a result. Pending, its storage and its identity are retained; `retryPending` resends the identical request. The error message is the feedback.                                                                                                                                               |
| Exception in the state fetch        |                                   |                                              | The command succeeded but the acknowledgement path did not finish. Pending is retained for the same retry, which replays through the host's request cache.                                                                                                                                                                               |

Nothing is inferred from message history, client version equality or revision arithmetic.
Cached results describe A; a fresh snapshot describes current host state; a locally newer
draft is a third source. The stored and in-memory guards above, the preparation and pending
gates, and the instance/session capture keep those apart. A snapshot older than the presented
one for the same instance is rejected in `accept`.

### Equivalence of the attachment-success replacement

The previous binding decided whether to adopt host text after an acknowledged attachment
send by comparing the snapshot's `composerDraftRevision` with the request's `baseRevision + 1`.
`Room.send` commits an attachment send with a draft identity atomically: it requires the
revision to equal `baseRevision`, clears `composerDraft` and `composerAttachments`, and
advances the revision exactly once. A replay of a committed operation returns the committed
message without clearing again. So after an acknowledged attachment success the
same-conversation snapshot's composer text is either empty (revision `baseRevision + 1`) or a
draft accepted afterwards (a higher revision). Adopting the snapshot text is therefore
observably equivalent to the old arithmetic on that path, without reading counters. The
argument does not extend to text-only sends, where the old code always cleared to empty and
the module still does. The `/api/draft` and `Room.send` behaviour this rests on was rechecked
on `main` after #94 merged.

## Maintenance locality

A change to lost-acknowledgement handling edits `web/composer.ts` and its focused tests. The
pending banner only routes a click to `retryPending`, question UI only awaits `command`, and
no rendering code holds a request, a draft flag or a revision comparison.
