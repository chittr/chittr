# Version-1 saved format contract

`SessionStore` in [`src/store.ts`](../src/store.ts) is the public boundary for
everything Chittr keeps on disk about a conversation. Maintaining that saved
data needs this document, the `Session` declaration and the related saved types
in [`src/types.ts`](../src/types.ts), `Persistence` and `SessionStore` in
`src/store.ts`, [`src/checkpoint.ts`](../src/checkpoint.ts) for the checkpoint,
continuation-note and maintenance-state schemas, and the focused tests below. It
does not require reconstructing `Room`, the compaction and replacement
transaction, or any adapter.

This document describes the implemented contract at the code it cites,
including its limitations. Line references are anchors at this commit; where a
later tree differs, the code is the authority and this document follows it. The
focused tests are deterministic and synthetic: they establish the loader's
classification, not that any particular older release wrote such a file.
[Attachments](attachments-contract.md) owns attachment staging, ownership,
retrieval, crash recovery, cleanup timing and error codes, including the
attachment index's own version. This document defines no attachment index rule
of its own. [Architecture](architecture.md) owns the room, maintenance and
recovery design that produces these records.

## On-disk layout

A storage base holds one directory per workspace, named by the first 24 hex
characters of the workspace fingerprint (`src/store.ts:157`,
[`fingerprint`](../src/config.ts) at `src/config.ts:82`). The base defaults to
`~/.agents/chittr/sessions` (`src/store.ts:155`); `--state-dir PATH`
(`src/cli.ts:38`) replaces it, and the CLI passes it as the base, not as the
workspace directory (`src/cli.ts:224`).

```
<base>/<first 24 hex of the workspace fingerprint>/
  room.lock
  latest.json                       { "id": "<session-uuid>" }
  <session-uuid>/
    session.json
    invalid-auxiliary-<random-uuid>.json
    attachments/index.json
    attachments/blobs/<sha256>.bin
```

Directories are created with mode 0700 (`src/store.ts:161`, `:213`). The atomic
write pattern is a temporary file opened `wx` at mode 0600, write, fsync, close,
rename. `session.json` and `latest.json` use it through `atomicJson`
(`src/store.ts:136-146`); the attachment index and attachment blobs use it
through `atomicFile` (`src/attachments.ts:116-126`). Two files do not. The lock
file is created directly with `wx` at mode 0600, written and fsynced with no
temporary file and no rename (`src/store.ts:166-172`), and the retained
diagnostic copy is made with `copyFileSync` (`src/store.ts:215-218`). The atomic
helpers' guarantees belong to the files that use them and to nothing else.

## The workspace lock

`acquire()` (`src/store.ts:160-197`) creates the workspace's storage directory, takes
`room.lock` and then runs attachment cleanup (`:174`). A lock whose recorded pid
is still alive is held: acquiring throws `A Chittr instance already owns this
workspace. Close it before opening another.` (`:189-192`). A lock is stale, and
is removed and retaken once, when its pid is gone (`ESRCH`, `:184`) or when its
contents cannot be parsed and the file is older than 10 seconds (`:186-188`).
`release()` (`:198-204`) removes the lock only when it still carries this
store's token.

| Operation                                       | Needs the lock                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `save`, `stageAttachment`, `cleanupAttachments` | Yes — `Session storage requires the workspace lock` (`:207`, `:415`, `:422`) |
| `load`, `list`, `attachmentAccess`              | No                                                                           |

`Room` depends on `Persistence` alone (`src/store.ts:126-129`), which exposes
`save` and an optional `attachmentAccess`. `SessionStore` adds `acquire`,
`release`, `load`, `list`, `stageAttachment` and `cleanupAttachments`.

## Save ordering

`save` (`src/store.ts:206-237`) validates identity and question history, freezes
legacy questions, then writes the two files in an order that depends on whether
the session already exists (`:224-230`). An existing session writes
`latest.json` first and `session.json` last, so a failed index write cannot
report a failed swap after the record already changed. A new session writes
`session.json` first and `latest.json` last, so the pointer never names a record
that does not exist. `updatedAt` is stamped at save time (`:221`). A session
marked for diagnosis by a previous load is copied to
`invalid-auxiliary-<random-uuid>.json` before either write (`:214-219`).
Attachment reconciliation runs afterwards and its failures are swallowed
(`:231-236`): saved references are authoritative and reconciliation retries on
the next save or start.

## Version and format authority

`savedSession` (`src/store.ts:40-125`) declares `version: z.literal(1)` at
`:41`, and `Session` declares `version: 1` (`src/types.ts:254-287`).
`newSession` produces it (`src/room.ts:68-89`). Any other value — `2`, `0`, the
string `"1"`, or an absent field — fails the core gate before any write.

Two other version numbers exist and neither is a saved-format version. The
checkpoint `version` (`src/checkpoint.ts:39`) is a positive integer sequence
number, compared monotonically as records load (`src/store.ts:330-335`). The
attachment index carries its own `version: 1` in a strict schema
(`src/attachments.ts:57-66`); it is owned by
[the attachment contract](attachments-contract.md) and is not restated here.

Neither `savedSession` nor its nested message and agent objects are `.strict()`,
and `load` returns the raw parsed object rather than zod's output: it parses into
`session` (`src/store.ts:245-247`), uses `savedSession.safeParse` only as a
boolean gate (`:249`), and returns that same object (`:390`). Fields outside
`savedSession` therefore pass the core gate, and they then split two ways:

- **Recognized auxiliary fields** — `checkpoints`, `handoffs`,
  `recoveryRequired`, and each agent's `checkpointVersion`, `maintenance` and
  `recoveryRequired` — are validated, rebuilt or coerced by auxiliary recovery
  (`src/store.ts:314-389`). They do not round-trip unvalidated.
- **Fields no loader branch handles** — `summary`, `summaryThrough`,
  `activities`, and any unrecognized key — round-trip unvalidated.

`checkpointSchema`, `handoffSchema` and `maintenanceStateSchema` are themselves
`.strict()` (`src/checkpoint.ts:37-82`), and `parseCheckpoint` and `parseHandoff`
(`:130-144`) additionally enforce coverage, attribution and the byte budgets in
`contextBudgets` (`:5-13`).

## Load classification

`Session.launchBrief` is optional version-1 core data with exactly `text` and
`source` string fields. `text` may be empty and is bounded to 1 MiB in UTF-8;
`source` must be nonblank and is descriptive provenance, never a path to read
on resume. `src/instructions.ts` owns this strict nested schema. Save validates
it before writes, and load validates it at the core gate before normalization
or auxiliary recovery. Missing data in an older session means no brief.

| Class    | Brief condition                                                            | Result                                                                 | File effect                        | Evidence                                                                           |
| -------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| accepted | Field absent or valid                                                      | Load the session; preserve saved brief text when present               | Normal existing load rules         | `test/room-instructions.test.ts` and legacy fixture in `test/saved-format.test.ts` |
| rejected | Present field has an invalid shape, types, blank origin or text over 1 MiB | `Saved session is invalid or unsupported; it has not been overwritten` | No session or latest-index rewrite | `test/room-instructions.test.ts` malformed-brief cases                             |

The launch brief is saved before any participant adapter is created. If that
initial save fails, Room enters its existing fatal/paused storage-failure state
without delivering the brief to a provider. Subsequent save failures retain
the existing dispatch hold.

`load(id?)` (`src/store.ts:238-391`) runs in a fixed order: resolve the pointer,
check the id shape, parse the file, apply the core gate, apply the history and
draft gates, normalize legacy questions, then recover auxiliary records. Every
throw below happens before any write. Each row names the test that asserts its
result, message and file effect.

`Class` is one of **pointer** (no session is produced), **rejected** (nothing is
written), **normalized** (accepted, rewritten under the lock) and **recovered**
(accepted, the auxiliary record dropped or coerced, a notice pushed, the
original retained at the next `save`).

Every auxiliary notice has the form
`Invalid saved <detail>. The original file will be retained for diagnosis; valid conversation history remains available.`
(`src/store.ts:314-321`); the table gives each `<detail>`.

Every recovered row's file effect is written **retained**, which means: auxiliary recovery
itself writes nothing, and whatever `session.json` holds at the next `save` is copied to
`invalid-auxiliary-<random-uuid>.json` before that save overwrites it
(`src/store.ts:214-219`). It does not mean the load wrote nothing. When the same record is
also legacy and the store holds the lock, the normalized row above still applies and runs
first, so the retained copy is the rewritten file rather than the pre-load bytes — see
["When loading writes"](#when-loading-writes) and the test named there.

| Class      | Input condition                                                                                                                                                 | Result through `SessionStore`                                                                                                         | Exact message or notice detail                                            | File effect                                                                                                                       | Asserted by                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pointer    | `latest.json` absent, `load()` (`:240-241`)                                                                                                                     | returns `undefined`                                                                                                                   | none                                                                      | none                                                                                                                              | [`test/saved-format.test.ts`](../test/saved-format.test.ts), "resolves the latest pointer without ever writing to it"                                                                                             |
| pointer    | `latest.json` is not JSON (`:242`)                                                                                                                              | throws the runtime `SyntaxError`                                                                                                      | the runtime's own parse message                                           | none                                                                                                                              | same test                                                                                                                                                                                                         |
| pointer    | `latest.json` has no `id`, or `load(id)` with an id failing `/^[\da-f-]{36}$/` (`:244`)                                                                         | throws                                                                                                                                | `Invalid saved session ID`                                                | none                                                                                                                              | same test; [`test/store.test.ts`](../test/store.test.ts) `:25`                                                                                                                                                    |
| pointer    | `latest.json` names a session directory that does not exist (`:245-247`)                                                                                        | throws the file-system error                                                                                                          | the runtime's `ENOENT` message                                            | none                                                                                                                              | same test                                                                                                                                                                                                         |
| rejected   | `session.json` is not JSON (`:245-247`)                                                                                                                         | throws the runtime `SyntaxError`                                                                                                      | the runtime's own parse message                                           | none                                                                                                                              | "rejects non-JSON saved content with the runtime parse error and no write"; `test/store.test.ts:27-29`                                                                                                            |
| rejected   | `version` is anything but the number `1` — `2`, `0`, `"1"`, absent (`:41`, `:249`)                                                                              | throws; a locked store behaves identically                                                                                            | `Saved session is invalid or unsupported; it has not been overwritten`    | none; no `invalid-auxiliary-*` file; the session directory listing is unchanged                                                   | "rejects … without overwriting anything, locked or unlocked"                                                                                                                                                      |
| rejected   | `id` or `workspace` mismatch, missing `messages`, `agents`, `exchanges` or `notices`, or any other `savedSession` failure (`:248-257`)                          | throws                                                                                                                                | `Saved session is invalid or unsupported; it has not been overwritten`    | none                                                                                                                              | "rejects … with its own message and leaves the file byte-identical"                                                                                                                                               |
| rejected   | message history broken: wrong id or sequence order, duplicate id, unknown root or reply target, misrouted question, invalid message attachment set (`:258-293`) | throws                                                                                                                                | `Saved message history is invalid; it has not been overwritten`           | none                                                                                                                              | same test; [`test/questions.test.ts`](../test/questions.test.ts) `:338-369`                                                                                                                                       |
| rejected   | composer attachment draft fails `validateAttachmentSet` (`:294-298`)                                                                                            | throws                                                                                                                                | `Saved attachment draft is invalid; it has not been overwritten`          | none                                                                                                                              | same test                                                                                                                                                                                                         |
| rejected   | more than 1000 `composerDraftVersions` writers (`:299-300`)                                                                                                     | throws                                                                                                                                | `Saved attachment draft writers are invalid; it has not been overwritten` | none                                                                                                                              | same test                                                                                                                                                                                                         |
| rejected   | pins duplicated or naming no message (`:301-308`)                                                                                                               | throws                                                                                                                                | `Saved message pins are invalid; the session has not been overwritten`    | none                                                                                                                              | same test; [`test/pins.test.ts`](../test/pins.test.ts) `:114-125`                                                                                                                                                 |
| rejected   | question history invalid (`:309`, [`src/question-history.ts`](../src/question-history.ts) `:7-10`)                                                              | throws                                                                                                                                | `Saved question history is invalid; it has not been overwritten`          | none                                                                                                                              | same test; `test/questions.test.ts:239-254`                                                                                                                                                                       |
| normalized | legacy question record (no `prompt`, no `frozenAnswerId`), store holds no lock (`:312`, `src/questions.ts:21-43`)                                               | returns the session with `frozenAnswerId` set to the answering message id, or `null`                                                  | none                                                                      | none                                                                                                                              | "freezes legacy questions in memory always and on disk only under the lock"                                                                                                                                       |
| normalized | the same record while the store holds the lock (`:312-313`)                                                                                                     | same in memory                                                                                                                        | none                                                                      | `session.json` rewritten in place; `updatedAt` and `latest.json` unchanged                                                        | same test; `test/questions.test.ts:300-336`, `:386-403`                                                                                                                                                           |
| recovered  | `checkpoints` is not an array (`:322-325`)                                                                                                                      | `checkpoints` becomes `[]`                                                                                                            | `checkpoints`                                                             | retained                                                                                                                          | "drops or coerces … with its own notice, and retains the original at the next save"                                                                                                                               |
| recovered  | a checkpoint record fails `parseCheckpoint`, or its version or coverage moves backward (`:326-341`)                                                             | that record is dropped; valid ones are kept                                                                                           | `checkpoint record`                                                       | retained                                                                                                                          | same test; [`test/checkpoint-store.test.ts`](../test/checkpoint-store.test.ts) `:60-104`, `:105-124`; "rewrites a locked legacy record before auxiliary recovery, so the retained copy is not the original bytes" |
| recovered  | `handoffs` is not an object (`:342-346`)                                                                                                                        | `handoffs` becomes `{}`                                                                                                               | `continuation notes`                                                      | retained                                                                                                                          | same test                                                                                                                                                                                                         |
| recovered  | one continuation note fails `parseHandoff` (`:347-355`)                                                                                                         | that note is dropped                                                                                                                  | `continuation note for @<agent>`                                          | retained                                                                                                                          | same test; `test/checkpoint-store.test.ts:60-104`                                                                                                                                                                 |
| recovered  | `agents[<agent>].checkpointVersion` matches no retained checkpoint (`:357-363`)                                                                                 | the field is deleted                                                                                                                  | `checkpoint reference for @<agent>`                                       | retained                                                                                                                          | same test                                                                                                                                                                                                         |
| recovered  | `agents[<agent>].maintenance` is invalid, names another agent, or references no retained checkpoint (`:364-380`)                                                | the field is deleted and that agent's `recoveryRequired` becomes `true`; the room's becomes `true` when the raw `agent` field differs | `maintenance state for @<agent>; explicit recovery is required`           | retained                                                                                                                          | "holds the agent and the room when saved maintenance names another agent"; `test/checkpoint-store.test.ts:60-104`                                                                                                 |
| recovered  | `agents[<agent>].recoveryRequired` is not a boolean (`:381-384`)                                                                                                | coerced to `true`                                                                                                                     | `recovery hold for @<agent>`                                              | retained                                                                                                                          | "drops or coerces … with its own notice, and retains the original at the next save"                                                                                                                               |
| recovered  | `session.recoveryRequired` is not a boolean (`:386-389`)                                                                                                        | coerced to `true`                                                                                                                     | `room recovery hold`                                                      | retained                                                                                                                          | same test                                                                                                                                                                                                         |
| rejected   | one session in the workspace matches any rejecting row, and `list()` runs (`:392-396`)                                                                          | `list()` throws that row's error for the whole workspace; no summary is returned for any session                                      | that row's message                                                        | the rejected session is untouched; a legacy session `list()` reached first may already have been normalized in place (`:312-313`) | "normalizes the session a failed listing reaches first and never writes the rejected one"                                                                                                                         |

A rejected load produces no notice, because no session is returned. A recovered
load pushes its notice onto the returned session and adds that session to the
store's `preserveOriginal` set (`:314-321`), which the next `save` consumes.

The attachment index sits outside this classification. A corrupt
`attachments/index.json` changes no row: cleanup on `acquire()` skips that
session and leaves the file intact (`src/attachments.ts:388-391`), and
`load(id)` still returns the session. The failure surfaces only when bytes are
requested — `attachmentAccess(id).resolve(<att-id>)` validates the id shape and
then reads the index (`src/attachments.ts:317-322`), which throws
`AttachmentError` with code `attachment-corrupt` (`:440-448`). That boundary is
asserted by "keeps a corrupt attachment index intact and reports
attachment-corrupt"; everything beyond it belongs to
[the attachment contract](attachments-contract.md).

## When loading writes

Loading is not read-only. There are exactly two write paths on a read.

1. **Lock-conditioned legacy normalization in `load`** (`src/store.ts:312-313`).
   When `freezeLegacyQuestions` changed anything _and_ the store holds the lock,
   `session.json` is rewritten in place with `atomicJson`. It does not change
   `updatedAt` and does not touch `latest.json`, so listing or loading an old
   conversation cannot re-point the store at it or move its timestamp. Without
   the lock the in-memory record is normalized and the file is untouched.
   `list()` calls `load(id)` for every session, so this applies during listing
   too.
2. **Attachment cleanup on `acquire`** (`src/store.ts:174`,
   `src/attachments.ts:367-434`). Cleanup visits every uuid-named session
   directory that has an `attachments` folder, reads `session.json` with a raw
   `JSON.parse` and no version or schema check (`:378-386`), reconciles
   ownership, and rewrites `attachments/index.json` for each readable session
   (`:403`). An unreadable index or session is skipped intact (`:388-391`). It
   never writes `session.json`.

The retained diagnostic copy is not the pre-load bytes. Legacy normalization
runs before auxiliary recovery, and the copy is made by the next `save` from the
then-current `session.json` (`src/store.ts:214-219`).
A locked load of a record that is both legacy and auxiliary-invalid therefore
rewrites the file first, so `invalid-auxiliary-<random-uuid>.json` can already
contain normalized questions and re-serialized JSON rather than the bytes that
were on disk before the load. It still contains the invalid auxiliary record,
which is what it is kept for.

## Historical fields grant no authority

The saved launch brief is restored user-supplied prompt guidance. It grants
no tool permissions or routing authority. Current YAML room instructions and
permissions are still loaded on resume; only the CLI brief's text is frozen
with the conversation. Reload keeps it, `/new` omits it, and `/sessions` uses
the destination's record. Its origin is never reread, even after the source
file changes or disappears.

The inspected older version-1 loader at `f2978814ecab86d4aab452f07ce26a256c924ca5`
preserves unknown top-level fields through load/save but does not apply
`launchBrief` to prompts. This is a property of that baseline, not a general
downgrade guarantee. Resuming with an older build does not preserve the new
instruction behavior.

Saved `permissions`, `commandMode`, each agent's `fingerprint` and each agent's
provider `sessionId` are data about the past. They are not authorization and not
a capability claim on resume. Current configuration, trust and permission policy
govern: `commandMode` is declared "Historical display information only; never
authorization on resume" (`src/types.ts:274`), and
[architecture's description of `src/command-access.ts`](architecture.md#runtime-map)
records that saved command mode is historical metadata and that the controller
reloads current configuration when switching conversations. A restored provider
`sessionId` is an attempt at native resume, not evidence that the provider
retained anything; the room is the recovery authority. Neither a checkpoint nor
a continuation note grants tools or permissions.

## Backup and restore

The recovery unit is the whole workspace session directory under the storage
base, `<base>/<workspace-fingerprint>/`: `latest.json`, every
`<session-uuid>/session.json`, and every `<session-uuid>/attachments/index.json`
with its `attachments/blobs/`. A lone `session.json` is not a recovery unit,
because the index and the bytes live beside it. Copying the whole storage base,
every workspace directory at once, is the simplest complete backup.

1. Back up with every Chittr process that owns the storage closed, and confirm
   that no workspace directory in the copy holds a `room.lock`. Keep the backup
   private: it contains conversation text and image bytes.
2. Restore into separate storage, never over the live directory, preserving the
   layout `<restore-base>/<workspace-fingerprint>/…`.
3. Open the copy with `--state-dir <restore-base>` — the parent of the workspace
   directory, because `SessionStore` appends the workspace fingerprint to the
   supplied base (`src/store.ts:157`) — launched from the same canonical
   workspace directory the sessions were recorded for, because the CLI derives
   the workspace from `realpathSync(process.cwd())` (`src/cli.ts:209`) and
   passes `--state-dir` as the base (`:224`). Use the explicit entry point of
   the build you mean to use. Pointing `--state-dir` at the copied workspace
   directory itself, or launching from another directory, makes the store look
   in a different fingerprint directory and find nothing.
4. Work done after the backup exists only in the live directory. Copy that
   directory aside before any restore.

[Compatibility](compatibility.md#rollback-and-recovery) is the dated record:
the concrete rollback commands, build identities and the two cross-version
cycles. Those cycles are evidence about the specific builds their records name —
candidates `5f5811e` and `fa84e6e` against the previous build `c6f7676` — and
they found that the storage needed no conversion between each candidate and that
previous build. Any applicability to the later `98bb697` release is stated
separately there. **This is not a general downgrade promise: older builds are not
guaranteed to read data written by newer ones.**

## Worked example and validation

Suppose a maintenance change adds one optional session field, `lastReviewedAt`,
to the saved record. Declare it on `Session` in
[`src/types.ts`](../src/types.ts) and add it to `savedSession` in
[`src/store.ts`](../src/store.ts) as an optional field; leaving it out of the
schema does not reject it, but it then round-trips unvalidated, which is the
gap below rather than a design. Decide its load class before writing code: an
optional field whose absence is normal belongs in no gate, so an older record
without it must load unchanged. Add a row to the table above and a case to
[`test/saved-format.test.ts`](../test/saved-format.test.ts) that loads the
checked-in fixture — which has no such field — and asserts both that it loads
and that a malformed value takes the class you chose. Do not repair old records
on read: a new write path on load would join the two above, and both of those
are deliberate and bounded. A behavior change this exercise reveals needs its own
scope decision rather than a silent widening of this contract.

Run from the repository root:

```sh
npm run build
npx vitest run test/saved-format.test.ts test/store.test.ts test/checkpoint-store.test.ts test/questions.test.ts test/pins.test.ts
npm run check
npm test
npm run build
npm run format:check
```

[`test/saved-format.test.ts`](../test/saved-format.test.ts) establishes, case by
case:

| Test                                                                                                      | What it establishes                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| loads, lists and round-trips the checked-in older-shape version-1 fixture                                 | the fixture is genuinely older-shaped, and `load()`, `load(id)`, `list()` and `save()` preserve its core state                               |
| rejects … without overwriting anything, locked or unlocked                                                | the `version` rows, and that `list()` throws for the whole workspace                                                                         |
| normalizes the session a failed listing reaches first and never writes the rejected one                   | the `list()` row: the rejected record is untouched, and the legacy record the listing reached first was normalized in place before the throw |
| rejects non-JSON saved content with the runtime parse error and no write                                  | the raw `SyntaxError` row and the malformed-id row                                                                                           |
| rejects … with its own message and leaves the file byte-identical                                         | every remaining rejecting gate, each with its own message                                                                                    |
| freezes legacy questions in memory always and on disk only under the lock                                 | both normalized rows, including the `null` frozen answer and the untouched `updatedAt` and `latest.json`                                     |
| rewrites a locked legacy record before auxiliary recovery, so the retained copy is not the original bytes | the ordering gap below: the retained copy carries the normalized question, not the pre-load bytes                                            |
| drops or coerces … with its own notice, and retains the original at the next save                         | every recovered row's notice text and in-memory effect, that an unlocked load writes nothing, and the retained copy at the next `save`       |
| holds the agent and the room when saved maintenance names another agent                                   | the maintenance row's two recovery holds                                                                                                     |
| keeps a corrupt attachment index intact and reports attachment-corrupt                                    | the attachment-index boundary above                                                                                                          |
| resolves the latest pointer without ever writing to it                                                    | all four pointer rows                                                                                                                        |

The first build supplies the built workers and MCP children the full suite
launches (`src/tools.ts:288-289` rejects a missing `tool-worker.js`), exactly as
[the adapter contract](adapter-contract.md) sequences it at `:166-176`.
[`test/saved-format.test.ts`](../test/saved-format.test.ts) drives
`SessionStore`'s public methods only, in a fresh `mkdtempSync` base per case,
over the synthetic fixture
[`test/fixtures/saved-format-legacy-session.json`](../test/fixtures/saved-format-legacy-session.json)
and variants derived from it in memory. No test reads personal conversation
storage or any path under the user's home directory. The existing
[`test/store.test.ts`](../test/store.test.ts),
[`test/checkpoint-store.test.ts`](../test/checkpoint-store.test.ts),
[`test/questions.test.ts`](../test/questions.test.ts) and
[`test/pins.test.ts`](../test/pins.test.ts) carry the cases the table cites from
them and are not duplicated here. These deterministic checks establish the
contract at this code. They are not live acceptance and not a downgrade
guarantee; the build-specific storage evidence stays with
[compatibility](compatibility.md#cross-version-sessions-and-drafts).

## Gap register

These are current behaviors or gaps recorded for a separate scope decision under
[#37](https://github.com/mcgloneb/ai-chat/issues/37). This contract work fixes
none of them.

- `list()` throws for the whole workspace when one `session.json` is non-JSON,
  core-invalid or of an unknown version (`src/store.ts:392-396`). One damaged
  conversation hides every other conversation in that workspace. The listing is
  not atomic either: `.map` loads sessions one at a time in `readdirSync` order
  (`:394-397`), so a locked listing that throws can already have normalized a
  legacy record it reached first.
- A non-JSON `session.json` surfaces the runtime's `SyntaxError` rather than a
  named "has not been overwritten" message (`src/store.ts:245-247`).
- `latest.json` is parsed and dereferenced without validation
  (`src/store.ts:240-242`): its own corruption surfaces as a raw `SyntaxError`,
  a missing `id` reaches the generic `Invalid saved session ID`, and a pointer
  to a removed directory surfaces the file-system `ENOENT` error.
- Cleanup on `acquire()` reads every `session.json` with no version or schema
  check and rewrites `attachments/index.json` for each readable session
  (`src/attachments.ts:378-403`), so a session the loader rejects can still have
  its index re-serialized when its `session.json` parses as JSON.
- A locked load rewrites a legacy record before auxiliary recovery, so the
  retained diagnostic copy is not the pre-load bytes (`src/store.ts:312-313`,
  `:314-389`, `:214-219`).
- Fields no loader branch handles — `summary`, `summaryThrough`, `activities`,
  and any unrecognized top-level key — pass the core gate and round-trip
  unvalidated, because `savedSession` is not `.strict()` and `load` returns the
  raw parsed object (`src/store.ts:245-247`, `:249`, `:390`). The recognized
  auxiliary fields are validated at `:314-389` and are not part of this gap.
- Directory entries are not fsynced after rename; the atomic write covers the
  file only (`src/store.ts:136-146`).

One entry from #92's list is deliberately absent, because this change closes it
rather than recording it: [architecture](architecture.md) named the retained
diagnostic file `invalid-auxiliary-<id>.json` while the code uses a random UUID
(`src/store.ts:217`). That line now reads `invalid-auxiliary-<uuid>.json`. It was
a documentation error, not a behavior gap, so nothing about it remains open.

## Plan records

An absent `Session.plan` is valid for older version-1 sessions. A present plan
contains focus, a plan revision, monotonic never-reused entry/proposal counters,
current entries, pending proposals and the latest whole-plan agreement reference.
Current entries keep only their applicable agreement marker. Withdrawn entry
content, older agreements and completed proposal dispositions stay in typed
public messages rather than accumulate in the live record.

`Message.planAction` is human-authored, with its own human root/exchange and
empty deliveries. It records the action, affected IDs/revisions, frozen entries
where needed, proposal source locators, outstanding work, human attribution and
public message time. `Message.planContribution` retains the agent's validated
flat input plus host-assigned status and references. Ordinary section comments
carry `planReference`, which includes the exact revision and its public source
message locator. These records survive public-history projection and exact
history lookup; they do not grant permissions or synthesize question answers.

`validatePlanHistory` validates these structures and reconstructs current state
from their ordered evidence. It checks sources, known revisions, agreement and
disposition evidence, archived references, action authority, counters and current
state consistency. Any failure is a core plan-specific saved-data error.
`SessionStore.load` runs it before legacy question normalization or auxiliary
recovery writes, leaving invalid saved bytes untouched. `save` validates before
writing as well. New conversations have no plan; switching restores only the
destination's plan. No downgrade guarantee is added.

Plan actions and whole agent results build a candidate, validate it and use the
existing synchronous atomic save before publication. Save failure leaves the
previous plan public and holds dispatch. Limits are 8 KiB per agent metadata,
64 KiB each for the live record and complete current view, and 80 KiB per
serialized public human action. Admission reserves bounded bookkeeping space
for later agreement, resolution, rejection, withdrawal and smaller edits. These
UTF-8 limits are independent of compaction/recovery's 128 KiB complete next-turn
bound. A plan overflow never evicts evidence or unresolved work automatically.
