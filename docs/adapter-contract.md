# Provider adapter contract

`AgentAdapter` in [`src/types.ts`](../src/types.ts) is the public boundary
between the room engine and a provider. Maintaining an existing provider needs
this document, that declaration, the provider's file under `src/adapters/`,
its transport tests, and the conformance suite below. It does not require
reconstructing `Room`, `ToolService` internals, or the other adapters. Adding a
new capability can require a separate caller change.

This document describes the implemented contract, including its limitations.
The conformance fixtures pin synthetic protocol responses, not live-provider
acceptance. [Image support](image-support.md) owns image eligibility, versions,
and dispatch authority. [Attachments](attachments-contract.md) owns retrieval,
turn authorization, byte handling, and revocation. This document defines no
additional image eligibility rule.

## Required operations

| Member                      | Caller-side meaning                                                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start(sessionId?)`         | Connect and return `{ sessionId?, restored }`. `restored: true` means the previous public context is **not** retained by the provider and needs re-seeding. It does not mean native resume succeeded.                                    |
| `run(input, event, signal)` | Process the required `input.messages`, with public `context`, optional `history`, participant ids, optional summary and human name. Resolve `TurnResult`, or reject. The caller owns the abort signal and the event callback's lifetime. |
| `interrupt()`               | Revoke the current tool turn and interrupt the provider. Adapters call it on cancellation/error paths; tests also call it directly. `Room` does not call it directly.                                                                    |
| `close()`                   | End provider resources and tool authority. `Room` calls it on failure, replacement, stop and room close, sometimes repeatedly. Calling it twice must be safe.                                                                            |

Codex and Claude attempt native resume. A successful resume returns
`restored: false`. A missing-session error matching the adapter's fallback
pattern causes a fresh session and `restored: true`; other errors reject.
Grok and Antigravity do not resume: supplying a previous session id returns
`restored: true`, omitting it returns `false`. At connect, `Room` starts recovery
replacement only when `restored`, a previous session id, and existing public
messages are all present. A retained session needs no recovery seed.

`TurnResult` contains `outcomes` and an optional `sessionId`. Each `Outcome`
accounts for `messageIds`, with `kind: 'reply' | 'pass'`, `text`, and
`recipients`. Optional fields include `awaitingHuman`, `question`,
`recommendation`; their validation is the room protocol in
[`src/protocol.ts`](../src/protocol.ts), not provider-specific parsing policy.
Adapters parse structured provider output before returning it. A pass is an
explicit disposition, not a provider error or missing response.

`AdapterEvent` has these variants:

| Event      | Meaning at the caller                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `received` | Provider receipt of the dispatched input.                                                                                                        |
| `activity` | `considering`, `working`, or `replying` with optional detail, used for live status.                                                              |
| `text`     | Current text preview, not a published outcome.                                                                                                   |
| `context`  | Optional `ContextUsage`, the latest context occupancy rather than cumulative billed tokens; an absent reading invalidates the displayed reading. |
| `notice`   | Public notice text. Declared and handled, but no current adapter emits it.                                                                       |

## Ordering and event authority

A normal sequence is `start`, then sequential `run` calls, then `close`.
Aborting a running turn after receipt rejects with `Interrupted`. Codex sends
`turn/interrupt`; Claude sends an `interrupt` control request. Their processes
stay open. Grok and Antigravity close their provider process. Whether every
adapter must be runnable immediately after direct `interrupt()` is unspecified.

`Room` accepts callbacks only while their captured attempt id is active and
the room is open. If an adapter resolves valid outcomes after its signal was
aborted, `Room` treats it as `Interrupted`, publishes no outcome, and leaves
the deliveries interrupted. A non-abort rejection fails the deliveries, marks
the connection unavailable and closes the adapter.

Each adapter removes its run listener on settlement, so a frame arriving while
idle reaches no run callback. During a later run, correlation is transport-specific:

| Adapter     | Rejected traffic during a run                                           |
| ----------- | ----------------------------------------------------------------------- |
| Codex       | Wrong thread id, wrong accepted turn id, or retired turn id.            |
| Claude      | Foreign `session_id`. Ordinary runs do not correlate by native turn id. |
| Grok        | `session/update` with a foreign session id.                             |
| Antigravity | Steps/results with a foreign `conversation_id`.                         |

Claude uses `user_message_uuid` correlation for maintenance results only. A
same-session frame from an earlier ordinary turn can reach the current run's
callback. `Room` cannot detect that misattribution because adapter events carry
no native turn identity. Its guard rejects retired callbacks, not arbitrary
stale native traffic forwarded through the current callback.

## Resource ownership and revocation

| Adapter     | Owned resources and release                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `codex app-server` stdio process and an in-process `ToolService`; `close()` closes both. No MCP child.                                                                                                                                   |
| Claude      | `claude -p` stream-json process and parent history/tool service. The provider launches its configured room MCP child. `close()` closes the provider and parent service.                                                                  |
| Grok        | ACP stdio process plus `IsolatedRuntime`, which owns a temporary home/workspace and parent `ToolService`; its MCP configuration launches the room child. Interrupt closes the provider; close also removes the runtime and closes tools. |
| Antigravity | `agy` stream-json process plus `IsolatedRuntime`, MCP configuration and a PreToolUse hook. Interrupt closes the provider; close also removes the runtime and closes tools.                                                               |

`src/adapters/isolated.ts` is shared resource support, not a fifth adapter.
MCP children read the parent service's history, maintenance and attachment-turn
files. They do not own independent room-turn authority. A retained MCP reader
cannot keep the old turn alive after its parent revokes it.

Turn authority and capability reports have different lifetimes:

| Transition                            | Turn/result authority                                                                                    | Capability report                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct `interrupt()`                  | Ends the tool turn; earlier `AttachmentResult` objects cannot release bytes.                             | Codex and Claude preserve observations and may remain available. Grok becomes unavailable when its process closes. Antigravity stays unsupported.                                                |
| Abort a running turn                  | Revokes the turn and settles the run with `Interrupted`.                                                 | Claude clears its observed turn model, which is evidence only, and its report is unchanged. Codex retains observations; Grok/Antigravity close the process.                                      |
| `close()`                             | Closes the parent service and ends authority.                                                            | Both image paths unavailable for all providers. Codex/Grok/Claude report `not_observed`; Antigravity reports `unsupported`. Claude clears its identity and reports its process is not connected. |
| `setMaintenance(true)` / `maintain()` | Ends the task turn; task calls reject during maintenance.                                                | Not a promise of capability withdrawal. A capability report alone never authorizes a task call.                                                                                                  |
| Replacement                           | Closes the old adapter; old results and readers stay unauthorized even once a new adapter starts a turn. | Replacement establishes its own observations and bridge registration.                                                                                                                            |
| Reconnect or policy-changing reload   | Old adapter/resources are closed; old turn authority does not transfer.                                  | Availability requires fresh start observations and registration; Claude registers its bridge as available when `start()` succeeds. An unchanged idle reload need not reconnect an adapter.       |

#85/PR #86 changes Claude's post-close missing-evidence status to
`not_observed`. The conformance assertion accepts both statuses to run on
either tree, as #90 requires; it always requires both image paths unavailable.

For Antigravity there is no successful retrieval to revoke. In an authorized
turn the unsupported bridge returns byte-free `retrievalUnavailable` data,
including its reason. After interruption, the inactive turn returns
`attachmentFailure`. A callable MCP reader wraps these returned data as text,
without `isError`. Maintenance exceptions escaping `tools.call` produce
`isError: true`. After replacement, calls on the old parent service reject with
`Tool service closed`. A closed old provider transport need not respond.

For Codex, an obsolete `read_attachment` request sent to the **open current**
transport with a stale `turnId` or `threadId` returns `success: false` and the
serialized `attachmentFailure`, without image bytes. A closed old transport
need not answer. The retained-MCP-reader obligation applies to Claude and
Grok, not Codex.

## Maintenance and optional capabilities

`compact(operationId, signal, instructions?)` returns a `CompactionResult`
whose status is `completed` or `nothing-to-compact`. Native routes are enabled
where the adapter reports them, which since #105 is after every successful
start rather than on a catalogued CLI build. The route flag means the adapter
can safely attempt the operation; only the provider-specific correlated
completion counts as success, and an unknown-method or malformed reply, a
timeout or a cancellation is a failure that keeps the saved reference and
requires explicit recovery. `maintain(request, signal)` takes an id,
a `checkpoint`, `handoff`, or `seed` kind and a prompt, then returns
`MaintenanceResult` with text and optional session id. A checkpoint summarizes
attributed public context; a handoff supplies continuation notes; a seed
installs reconstructed context in a replacement session. These are not task
turns. Parent tool calls and MCP task calls are denied during maintenance;
Codex's dynamic tool route also refuses requests without an authorized turn.

The seed caller requires `result.text.trim() === 'seed accepted'` and a truthy
`result.sessionId`. The type's optional session id is insufficient for that
particular path. See [architecture](architecture.md) for the caller's transaction
and recovery behavior.

| Absent or falsy member                                         | Existing result at the caller boundary                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imageSupport`                                                 | `Room.initialImageSupport` returns `unsupported` with `no initial-image route is enabled for @<id> (<provider> adapter) on this baseline`. Image deliveries fail with a notice before a provider call; status consumers show the report.                                                                                                                                                                                                                          |
| `nativeInitialImages`, `initialImageSupport`                   | No production caller reads them outside the adapters; no dispatch effect.                                                                                                                                                                                                                                                                                                                                                                                         |
| `nativeCompaction` falsy or `compact` absent                   | Compaction route is `replacement`. Claude and Grok set the flag after a successful `start()` on any CLI identity; Codex sets it after `start()` too, and `start()` itself refuses with the failed observations named when any required native policy observation on the thread failed or is missing (`imageEvidence.nativeMaintenancePolicyFailures` records them); all clear it on `close()`. It means the route may be attempted, not that the CLI supports it. |
| `nativeCompactionInstructions` falsy                           | `instructionsSupported: false`; native `compact` receives `undefined` instructions.                                                                                                                                                                                                                                                                                                                                                                               |
| `sourceHandoff` falsy or `maintain` absent on the live adapter | No handoff turn; text is `Continuation note unavailable`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `maintain` absent on a factory-built replacement               | `@<id> does not support safe checkpoint replacement`; compaction or recovery fails.                                                                                                                                                                                                                                                                                                                                                                               |

There is no common unsupported-result type. Do not infer a native capability
from the presence of another optional member.

## Worked maintenance example and validation

Suppose a Grok transport release adds a new activity notification without
changing outcome semantics. Keep its translation in
[`src/adapters/grok.ts`](../src/adapters/grok.ts): correlate the notification's
session id before calling `event({ type: 'activity', ... })`. Add the frame to
the Grok scripted transport and verify a current-session event is delivered,
an idle event reaches no callback, and a foreign-session frame during the next
run is ignored while that run still completes. No Room change is needed for
an existing event kind. A behavior change revealed by this exercise needs its
own scope decision rather than silently widening this contract.

Run from the repository root:

```sh
npm run build
npx vitest run test/adapter-contract.test.ts test/attachment-adapter-lifecycle.test.ts test/maintenance.test.ts test/image-preflight.test.ts
npm run check
npm test
npm run build
```

The first build supplies the actual MCP child used by the tests.
[`test/adapter-contract.test.ts`](../test/adapter-contract.test.ts) constructs
all four real adapters through `createAdapter` and shares the lifecycle and
capability-parameterized assertions. The per-provider wire scripts live in
[`test/adapter-contract-wire.ts`](../test/adapter-contract-wire.ts), replacing
only the external process seam. No provider executable, network request,
fake CLI executable, or recorded provider stream is used. Codex executable
discovery uses a symlink; execution remains mocked. Host sandbox readiness and
Antigravity's hook response are scripted, so this suite does not prove their
policy enforcement. MCP tools, attachment storage and result revocation are
real. All provider cases call the real `ToolService.check()` and require macOS;
the real MCP children also need host access for their sandbox startup probe.
Antigravity cases run on macOS only, matching `test/providers.test.ts`.

The test-local conformance fake passes the same lifecycle assertion body; the
fresh-start restoration mutation must fail it. This checks the assertions,
not provider behavior. Only the real-adapter cases establish adapter evidence.
Room obligations and missing capabilities are checked in
`test/maintenance.test.ts` and `test/image-preflight.test.ts`. The existing
`test/attachment-adapter-lifecycle.test.ts` additionally holds MCP reads at the
byte-read boundary across completion, cancellation, replacement and session
switch. Deterministic checks are not live acceptance. That remains with
`test:live`, `test:interrupt`, `test:compaction`, `test:room` and
[compatibility evidence](compatibility.md).

## Gap register

These are current differences or unspecified behavior for a separate scope
decision under #37. This contract work does not fix them.

- `restored` has the two routes described above, fallback after failed native
  resume versus always-new sessions with a prior id.
- `MaintenanceResult.sessionId` is optional, but the seed path needs a truthy
  value and the trimmed acknowledgement.
- Grok/Antigravity interrupt closes the process; Codex/Claude interrupt does
  not. Post-interrupt runnability without `start()` is unspecified.
- Claude observes its native tool inventory in each turn's init event. A failing
  inventory re-registers the retrieval bridge as unavailable mid-turn, which ends
  that turn's attachment authority; a passing one leaves the turn untouched.
- Claude ordinary frames correlate by session only. Maintenance results alone
  require user-message UUID correlation, and Room cannot detect stale native
  traffic attributed to the current attempt.
- `start()` re-entrancy is unspecified. Claude's missing-session fallback
  calls `this.start()` on the same instance.
- `notice` events are declared and handled but emitted by no adapter.
- `nativeInitialImages` and `initialImageSupport()` have no caller outside
  adapters and tests.
- Antigravity `execute` has no image guard. Initial-image safety depends on
  Room's preflight and dispatch invariant.
- Grok maintenance-output overflow closes the process instead of returning
  the transport-limit error the other adapters raise.
- Codex `compact` ignores instructions, consistent with the caller only
  because Codex lacks `nativeCompactionInstructions`.
- Codex `sourceHandoff` and `nativeCompaction` are both set after a successful
  `start()` and cleared on `close()`; neither reads the CLI version. A handoff
  that the live session cannot complete records `Continuation note unavailable:
<reason>` and keeps the replacement transaction. This is not an image gate.
- Turn and compaction timeouts are per-adapter constants, not a shared definition.
- Post-`close()` behavior is unspecified beyond repeated close, unavailable
  image paths and revoked old authority as checked by the suite.
