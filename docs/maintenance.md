# Maintenance guides

Use the [architecture map](architecture.md) to choose a boundary. Follow the
[quality checks](quality.md) for a fresh install and the complete credential-free
suite. `npm run quality` builds before tests that launch workers or MCP children.
`npm run check` covers `src/` and `web/`; `npm run check:tests` separately checks
all TypeScript tests and their imported helpers. Node tests use NodeNext;
Playwright, composer and attachment-draft tests use Bundler and DOM settings.
Vitest alone does not typecheck tests.

Run `npm run format:check` for the full formatting gate, or
`npx prettier --check` followed by changed paths while iterating. Historical
archive removal means there is no evidence-tree formatting exception.
The provider and sandbox checks require macOS and host access for sandbox
startup probes. A parent sandbox denial is not a passing check.

## Change rendering

1. Read the [display contract](display-contract.md) and public declarations in
   `src/snapshot.ts`. `npm run build` emits signatures in `dist/snapshot.d.ts`.
   Shared value declarations come from `src/types.ts` and `src/image-support.ts`.
2. Choose the consumer: `src/ui/terminal.ts` or `web/main.tsx`. Import snapshot
   exports with a relative `.js` path, such as `../src/snapshot.js` from `web/`.
   The pure terminal renderer is `transcript(snapshot, width)`, exported from
   `src/ui/terminal.ts`; the focused test imports `../src/ui/terminal.js`.
   Terminal `draw()` obtains one projection per frame with `projectRoom`.
   `WebUI.snapshot()` in `src/web.ts` adds browser transport fields before SSE
   delivery.
3. For an existing fact, work in that renderer and its tests. For a new producer
   fact, trace its owner and extend the projection contract explicitly. Preserve
   borrowed-data immutability, read-time freshness and narrow input reads; the
   contract owns those rules and helper examples.
   For browser composer state or recovery, use `ComposerController` from
   `web/composer.ts`, imported as `./composer` inside `web/`. Read the
   [browser composer contract](browser-composer.md) and its public JSDoc.
   The module owns text/reply state, local persistence, submission eligibility,
   pending identity and retry, and acknowledgement mapping. It consumes the
   [submission result](attachments-contract.md#composer-submission-result) and
   composes `AttachmentDraft` from `web/attachment-draft.ts` for upload ownership.
   `web/main.tsx` renders state and routes intentions; it subscribes to the
   authenticated event stream through `web/api.ts` and owns keyboard, focus,
   layout and save-timer events. Keep recovery decisions in
   the composer module, not in JSX or renderer-side history/counter checks.
4. Start with `test/terminal-display.test.ts` for plain `RoomSnapshot` fixtures.
   Run `npm test -- test/terminal-display.test.ts test/snapshot.test.ts`.
   Terminal interaction changes also use `test/terminal-ui.test.ts` and
   `test/terminal-input.test.ts`. Browser changes use `npm run test:web` after
   the build. This runs both `test/browser/web.spec.ts` and
   `test/browser/command-recovery.spec.ts`, including same-operation retry.
   Composer transitions use `npm test -- test/composer.test.ts`; upload
   ownership also uses `test/attachment-draft.test.ts`. Playwright requires a
   browser installed with `npx playwright install chromium`, or set
   `CHITTR_BROWSER` to an installed compatible browser executable.

[PR #87](https://github.com/mcgloneb/ai-chat/pull/87) records a prior rendering
exercise and its limitations; it is not verification of the current tree.

## Add a room command

1. Start at `RoomController.submit` in `src/controller.ts`, imported as
   `../src/controller.js` from tests. Submission enters its serialized queue,
   checks a supplied session ID against the current conversation and invokes
   private `execute`. Extend that dispatch following an adjacent command's
   argument validation and Room operation. Test through `submit`, not `execute`.
2. Composer clients call `RoomController.submitDraft`, which dispatches through
   `submit`. Its `DraftSubmission` input is exported from `src/controller.ts`;
   the JSON-safe `DraftSubmissionResult` is a type-only import from
   `src/web-types.ts`, such as `../src/web-types.js` from `web/` or tests.
   Follow the [composer submission contract](attachments-contract.md#composer-submission-result)
   for clearing, capture points, queue boundaries and guarded recovery. Its
   dispatch, attachment commitment, recovery and resulting-session facts are
   independent; a dispatch failure can accompany an already committed operation.
   Preserve the contract rather than adding client-side history scans or revision
   arithmetic to interpret the result.
3. Check the three `submitDraft` routes: `src/cli.ts` supplies the terminal-text
   callback to `src/ui/terminal.ts`; `src/ui/terminal-attachments.ts` supplies
   terminal attachment identity; and `src/web.ts` handles HTTP input and returns
   `CommandResult.submission`. The terminal clears its local text input, but
   the controller owns the saved-draft clear and recovery. Browser intentions
   and acknowledgement handling live in `web/composer.ts`; transport and draft
   version allocation live in `web/api.ts`. Preserve stale-conversation checks,
   operation IDs, draft identities and attachment options. Ordinary messages
   and `/reply` can carry attachments; other commands reject them. `//` escapes
   a leading slash as message text.
4. Update shared completion in `src/completion.ts`, help in `src/cli.ts` and
   the README command table. Terminal-local `/attach` is separate: parsing and
   help/completion live in `src/ui/attachment-input.ts`, with actions in
   `src/ui/terminal-attachments.ts`. The browser `/api/complete` endpoint
   rejects `/attach`; it is not a new controller command.
5. Add focused cases beside the public controller scenarios in
   `test/draft-submission.test.ts`, HTTP scenarios in `test/web.test.ts`,
   completion cases in `test/completion.test.ts`, and
   attachment/input cases in `test/terminal-attachments.test.ts` and
   `test/terminal-input.test.ts`. Check `test/terminal-ui.test.ts` for terminal
   submission behavior. Exercise valid input, invalid arguments,
   stale conversation IDs, attachments and both client paths where affected.
   Run `npm test -- test/draft-submission.test.ts test/web.test.ts test/completion.test.ts test/terminal-attachments.test.ts test/terminal-input.test.ts test/terminal-ui.test.ts test/composer.test.ts`.
   Browser interaction changes also use `npm run test:web` after a build.

Test command dispatch through `submit` and composer outcomes through
`submitDraft`, not private helpers. The existing dispatch is not a command registry.

## Maintain a provider

Start with the [provider adapter contract](adapter-contract.md), then
`AgentAdapter`, `TurnInput`, `TurnResult` and `AdapterEvent` in
`src/types.ts`, imported as types from `../types.js` inside `src/adapters/`.
Choose `src/adapters/codex.ts`, `claude.ts`, `grok.ts` or `antigravity.ts`;
`src/adapters/index.ts` constructs them. `src/room.ts` is the lifecycle caller.
Use the contract for required/optional capabilities, event ordering,
cancellation, restoration, resource ownership, maintenance tool denial and
image-retrieval revocation. It includes a worked transport-maintenance example.
An existing-event translation should need that provider and its transport tests,
not reconstruction of Room or another adapter. Read the caller when changing
its interaction or adding a capability.

The conformance checks in `test/adapter-contract.test.ts` construct the real
adapters; `test/adapter-contract-wire.ts` scripts only the external process seam.
The fake adapter lives in tests only and checks the shared assertions. It is not
evidence that a real provider supports a capability. Unsupported capabilities
must retain their explicit caller-visible results described in the contract;
there is no common unsupported-result type and no invented success fallback.

Run `npm test -- test/adapter-contract.test.ts test/attachment-adapter-lifecycle.test.ts test/maintenance.test.ts test/image-preflight.test.ts`
after the build. Also use `test/providers.test.ts` and the matching provider's
image/maintenance tests.
For example, a Claude image change starts with
`npm test -- test/claude-images.test.ts test/attachment-adapter-lifecycle.test.ts`;
maintenance uses `test/claude-maintenance.test.ts`. Keep transport and permission
policy specific to each provider. The contract distinguishes deterministic
conformance from live acceptance and records current gaps; neither a fake nor
a scripted startup proves live policy enforcement. Live probes and tested
compatibility limits are documented in [compatibility](compatibility.md).

## Evolve saved data

Start with the [version-1 saved-format contract](saved-format-contract.md), then
`SessionStore` and the `Persistence` interface in `src/store.ts`,
imported as `../src/store.js` from tests, and saved `Session` types in
`src/types.ts`. Room is the save/recovery caller; the controller loads sessions
when switching conversations. `src/attachments.ts` and `src/checkpoint.ts`
cover adjacent storage records. Follow the
[attachment contract](attachments-contract.md) for indexes, blobs and references.

Use its load-classification table and worked example to distinguish legacy
normalization, unsupported-version rejection, core corruption and auxiliary
recovery. Loading is not universally read-only: the contract records locked
legacy normalization and attachment cleanup on lock acquisition. An auxiliary
diagnostic copy can contain already-normalized data, not the original pre-load
bytes. Preserve those limits rather than promising stronger recovery behavior.

`test/saved-format.test.ts` exercises public store methods with the synthetic
`test/fixtures/saved-format-legacy-session.json` and a fresh temporary storage
base per case. Extend those cases and the related store, checkpoint, question,
pin or attachment tests for the affected boundary. Never use personal storage
as a fixture. Run
`npm test -- test/saved-format.test.ts test/store.test.ts test/checkpoint-store.test.ts test/questions.test.ts test/pins.test.ts test/attachments.test.ts`.
A format maintenance change needs evidence for older version-1 loads, future
version rejection without overwriting, and the affected corruption cases.
Navigation work authorizes no schema change or stronger durability guarantee.

Use the [backup and restore procedure](saved-format-contract.md#backup-and-restore)
and [dated compatibility evidence](compatibility.md#rollback-and-recovery):
close every process that owns the storage, preserve the complete session storage
including attachment indexes and blobs, and restore into separate storage.
A session JSON file alone is insufficient. Use the intended build's explicit
entry point, launched from the same canonical workspace directory, and point
`--state-dir` at the separate restore base, not its workspace-fingerprint
subdirectory. Historical tested build pairs do not promise general downgrade
support. Saved permissions remain historical data, not current authority.
