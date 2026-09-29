# Compatibility and validation

Historical run records named below are held privately under
[#99](https://github.com/mcgloneb/ai-chat/issues/99). They are not files in this
checkout or acceptance evidence for a new build. Preserve their dated results
and limitations; record new sanitized acceptance on the owning open issue.

Provider text integration verified on 2026-09-07, with skill access verified on 2026-09-08, macOS arm64, Node 25.8.2, Codex CLI 0.153.4, Claude Code 2.1.263. Image support has its own runtime requirements and its own status, in the next section. The source targets Node 22.12+. Treat CLI upgrades as a reason to rerun `chittr doctor` and the opt-in live checks. These adapters depend on version-sensitive CLI protocols.

Grok Build **1.0.5** and Antigravity CLI **1.1.27** were verified on 2026-09-08 using the same macOS environment and existing subscription logins. Since #105 no adapter admits or refuses a CLI by its version: Codex keeps a forward-compatible minimum of 0.153.0 for app-server restricted-read support, and Antigravity startup depends on its live selected-profile enforcement probe, described under [Grok Build and Antigravity CLI](#grok-build-and-antigravity-cli), which has not yet been exercised on a live CLI.

## Image release status (issue #58)

**Status on 2026-09-19: released as the local pilot.** [PR42](https://github.com/mcgloneb/ai-chat/pull/42) merged the epic branch into `main` at `98bb697` with a merge commit, the clone that the `ai-chat` command resolves to was moved to that commit and rebuilt, and its build identity is the candidate's exactly. On that activated executable, one newly sent image, one later image and one fresh historical retrieval passed for Codex, Claude and Grok in the restricted room, and a mixed send reached all three while Antigravity stayed queued as not observed. The release record (`image-release-2026-09-19.json`, private historical record) pins the released commit, the activated executable identity, the post-activation results and the rollback target.

Two facts about the host's CLIs on release day: the linked `codex` had moved to 0.155.0 and the managed `claude` to 2.1.278, and neither was a recorded image build. Under the exact-build policy in force that day the product kept their image paths closed; the post-activation runs used the still-installed 0.154.0 and 2.1.277 first on PATH, by the owner's decision, and the first Claude run on 2.1.278 is retained as evidence of that closure. No gate was widened at release. #85 has since removed the CLI build from both providers' image eligibility: an upgraded Codex or Claude keeps its image paths open when the runtime requirements in the table below still pass, and the recorded builds stay what was actually exercised. Someone who wants images from Codex or Claude on this host today runs it on whatever build is installed and reads the live reason if a requirement is unmet.

What this release verifies for Claude, in plain terms: Claude receives newly sent images and historically retrieved images in both rooms, on first and later turns, through the browser and the terminal. Claude checkpoint replacement and post-restart historical retrieval are blocked by an Anthropic safeguard on the tested builds and are not part of this release's verified coverage. The refusal category is `reasoning_extraction`; it was reproduced on Claude Code 2.1.274 and twice on 2.1.277, once with realistic human-only filler, so the harness content is ruled out as the cause. The product fails the affected turn with the provider's own refusal text and keeps the participant otherwise usable after a reconnect.

The candidate record (`image-release-candidate-2026-09-18.json`, private historical record) pins the candidate identities below and says which evidence was kept and why; the release record carries them forward. The 2026-09-17 record (`image-release-candidate-2026-09-17.json`, private historical record) is its predecessor and is kept as history. This section describes what the candidate's code enables. It is current status. The dated [native image delivery probe](#native-image-delivery-probe) further down is history, and those probes did not enable anything.

### Candidate and reconciliation

The continuing branch `codex/epic-29-persistent-image-sharing` was merged with `origin/main` at `3754c7d`, fetched through the identity wrapper, in merge commit `85dd0bf` on 2026-09-17. Both parents are kept and no published history was rewritten. `origin/main` had not moved when it was fetched again on 2026-09-18, so that merge is still the reconciliation. Main's side since the merge base `c6ba943` is PRs #47 to #49: the website, its deployment note and the deploy-website skill, none under `src/`, `web/`, `scripts/` or `test/`. #23, #30 and #37 were still open, so nothing of theirs existed to preserve. Stale local `main` was not used.

The candidate is the branch head `fa84e6e`. Its product source is the `src` tree `64a5842e6432`, the `web` tree `ac3aa6915f47`, and unchanged `package.json` and `package-lock.json`. Built with Node 25.8.2, `npm ci` and `npm run build`, its `dist/` has 151 files and build identity `ad3540e5f7e5609cb95d7baabc02bad3065280b94494308284b052c5502edb63`. The candidate record defines that hash. The `dist/cli.js` entry is byte-identical to the 2026-09-17 candidate's, because the changed files compile elsewhere, so the entry hash alone does not identify this build. No patch was applied.

Since #57's recorded build `207e242`, product source changed in exactly two files: `src/adapters/claude.ts` (PR 77, fail fast on a Claude provider refusal) and the Claude entries of `src/image-support.ts` (PR 78 and PR 79, the 2.1.276 and 2.1.277 tested builds). Nothing under `web/`, nothing in the Codex or Grok adapters, and nothing in the shared attachment, store, room or policy code. So the Codex and Grok rows stay applicable by source equivalence. The Claude first, later and fresh-retrieval rows stay applicable on the strength of the 2.1.277 six-run set (`claude-images-2026-09-18-b.json`, private historical record), which ran in both rooms on the installed CLI on a build that already carried the PR 77 change. The two Claude continuity rows are failures, as stated above. The four provider executables were checked on 2026-09-18: Claude 2.1.277, Grok 1.0.34 and `agy` 1.2.5 match the records by version and SHA-256; the linked Codex is 0.155.0, and the 0.154.0 release the matrix ran on is still installed with its recorded hash. After any later change to the candidate, a provider CLI or a room configuration, repeat this comparison before keeping a row. A clean merge and a passing build are not image acceptance.

### Enabled image paths

Each participant reports initial delivery and historical retrieval separately. When initial delivery is unavailable for a participant, a message that carries an image is not delivered to that participant at all, caption included. Its delivery fails for that participant only, with a reason and a notice, and nothing is charged or retried automatically. The participant stays connected, messages without images still reach it, and the other recipients are unaffected.

| Provider    | Image paths open only when                                                                                                                                                                                                                          | Rooms                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex       | The native session reported its model and effort; the thread is fresh; the native policy checks passed. The CLI version, model and effort are evidence, not gates; 0.154.0 with `gpt-6-astra` at `xhigh` is what the runs exercised                 | All task permissions off, skills off, command mode `off`. Or all on, skills on, command mode `trusted`                                           |
| Claude      | A completed text turn in this connection observed the turn model and a verified tool inventory. The CLI version, model and effort are evidence, not gates; 2.1.268, 2.1.274, 2.1.276 and 2.1.277 with `opus` at `xhigh` are what the runs exercised | The same two rooms as Codex                                                                                                                      |
| Grok        | The adapter observed its full isolated-room runtime contract on the live process, with a verified native inventory and an observed session model. The CLI version and model are evidence, not gates, except that 1.0.13 stays restricted            | All off, skills off, command mode `off`. Or all on with skills on and command mode `sandboxed` or `trusted`. 1.0.13 is limited to the first room |
| Antigravity | Never. Antigravity images are unsupported in this release                                                                                                                                                                                           | None                                                                                                                                             |

A resumed Codex thread, a mixed room configuration and a missing observation all stay closed. An unrecorded Codex or Claude build does not: since #85 their CLI version does not decide image eligibility in either direction. Since #105 neither does any provider's requested or observed model or effort: an explicit Grok model request, Codex `gpt-6-astra` at `high`, or a Claude model other than `opus` keeps its paths open when the live checks pass, and a model that cannot take images fails the delivery with the provider's own error. Grok retains its recognized live-identity requirement and legacy 1.0.13 restricted-room limit. A build or model the dated probes once exercised gains no support from that, and an unlisted build or untested model that keeps its paths open has not been visually tested. Codex `view_image` and `image_generation`, Grok `image_gen` and Antigravity's native task tools stay denied.

### Tested coverage

Requested and observed values are separate facts, and so are a requested effort and a native acknowledgement of it. The provider records hold them per run. [Image support](image-support.md) is the full inventory with the rerun commands for every provider.

| Provider and CLI                                                           | Requested                                            | Observed                                                                                         | Entry points and rooms that passed                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex `codex-cli 0.154.0`                                                  | `gpt-6-astra`, `xhigh`                               | Native session reported `gpt-6-astra` and `xhigh`                                                | Controller, browser and PTY in the restricted and trusted rooms, #52 (`codex-images-2026-09-16.md`, private historical record)                                                                                                                                                                                                                                |
| Claude `2.1.268` and, as separate sets, `2.1.274`, `2.1.276` and `2.1.277` | `opus`, `xhigh`                                      | Turn model `claude-opus-5`. This CLI does not acknowledge effort natively, so it stays `unknown` | Controller, browser and PTY in both rooms, #53 (`claude-images-2026-09-16.json`, private historical record), #57 for 2.1.274 (`claude-images-2026-09-17.json`, private historical record) and #57 for 2.1.276 (`claude-images-2026-09-18.json`, private historical record) and #57 for 2.1.277 (`claude-images-2026-09-18-b.json`, private historical record) |
| Grok `1.0.30 (04b7ffed98c6)` and `1.0.34 (3736acbc8658)`                   | Provider default; effort `high` in the trusted rooms | `grok-4.6`; the native session selected `high` in every room                                     | 1.0.30 in the restricted and sandboxed rooms, #56 (`grok-images-2026-09-16.json`, private historical record). 1.0.34 in all three rooms, #69 (`grok-images-2026-09-17.json`, private historical record)                                                                                                                                                       |

Each of those runs covers a first image, a later image in the same provider session and a fresh historical retrieval in a distinct session, with a private visual assertion correlated to the native delivery by content hash. They are per-provider coverage. #57's integrated matrix (`integrated-images-2026-09-17.json`, private historical record) is the release bar: 40 of 42 in-release rows passed and the two Claude continuity rows failed upstream, as stated above. Its mixed-recipient runs confirm the image never reached Antigravity, but the product's refusal for a connected Antigravity recipient has never run live, because `agy` 1.2.5 cannot connect past the 1.1.27 gate. That is recorded as unproved, not as a fourth passing provider and not as a pass.

### Cross-version sessions and drafts

The cycle record (`cross-version-cycle-2026-09-18.json`, private historical record) is the result of running two different builds on 2026-09-18, on the candidate build identified above, against one isolated `--state-dir` for one workspace. The 2026-09-17 cycle (`cross-version-cycle-2026-09-17.json`, private historical record) ran the same experiment on the previous candidate and is kept as history. Both cycles ran two different builds against one isolated `--state-dir` for one workspace, each invoked by the path of its own `dist/cli.js`. The previous build is the one the `ai-chat` command resolved to on this host: source `c6f7676`, clean, build identity `0ce4d4fe6fb94b9eed2494f5783223f5ae4911ba3b6d1a30b5e99bc2cec6a18c`, 121 files. It matches neither local `main` nor `origin/main`. A clean checkout of `c6f7676` rebuilt to the identical hash, so that checkout is a runnable copy of the rollback build.

Nine processes ran in order: new, previous, new, through a raw-mode PTY and through the served page in headless Chrome. Each closed with the product's own Ctrl+D or Quit, exited 0 and released the workspace lock before the next one started. No agent was enabled, so no provider CLI started and no model was called. This is storage evidence. Image delivery is #57's.

1. The new build created three sessions, two in the terminal and one in the browser. Each has a sent image message and an unsent draft with text and ordered image references.
2. With nothing owning the storage, the whole workspace session directory was copied as the backup: `latest.json` and every session folder with its `session.json`, `attachments/index.json` and `attachments/blobs`. No lock file was in it. Neither build ever opened that copy.
3. The previous build reopened each session with `resume <ID>`. It reported the requested ID, created no session and used the same session directory. It saved a terminal draft edit, a browser draft edit and a browser pin. In the third session it sent the draft text as a message and pinned a message.
4. The new build reopened all three. The terminal listed every draft image ID, and the page decoded both draft previews and the sent image through its authenticated reads. It then saved further draft edits.

Every saved session differed from its comparison record only by those edits plus `updatedAt` and `notices`. Message history, sent-image references, send operation identities, draft image order and metadata, agent state and every other key were unchanged, and the previous build left the draft revision counters exactly as it found them. All eight expected attachment IDs were still in their session's `attachments/index.json` with no `orphanedAt`, and the candidate's own store resolved each to its original SHA-256 and byte size. The verdict is `direct-compatible`.

A control keeps the time check honest. One image was staged and removed again, which leaves an orphaned index entry. On a separate copy of the final state, `cleanupAttachments` ran 25 hours after the product check, past the 24-hour orphan grace. It deleted that one entry and its blob and nothing else, and all eight references still resolved. This is a supporting fixture. The process cycle above is the product evidence. Nobody changed the clock or the retention policy.

Demonstrated limits of using the previous build on this storage:

- It has no image UI. Images do not render, and it cannot stage, remove or send one.
- When it sends a draft that has staged images, only the text goes. The images stay staged in the draft and the new build shows them again.
- Its draft edits do not advance the draft revision counter. The new build accepted the saved state and its next edit advanced the counter normally.
- The cycle had no connected agent. Sessions holding live provider session state were not cycled, and the previous build was not asked to deliver a message that carries an image to an agent.

Rerun it against whatever build is installed at the time:

```sh
npm ci && npm run build
npx tsx scripts/cross-version-cycle.ts \
  --previous "$(dirname "$(readlink -f "$(command -v chittr)")")/cli.js" \
  --output /private/tmp/cross-version-cycle.json
npx tsx scripts/evidence-sanitization.ts /private/tmp/cross-version-cycle.json
npm test -- test/cross-version-outcomes.test.ts
```

It needs installed Chrome or `CHITTR_BROWSER`, and Python 3. It refuses to compare a build with itself, because a same-build restart is a different check. Add `--private <directory>` to keep the fixtures, working storage, backup and recovery copies for inspection. They are deleted otherwise, and they never belong in the repository.

### Rollback and recovery

Sessions live under `~/.agents/ai-chat/sessions/`, one directory per workspace. Do these with every AI Chat process closed. The [saved format contract](saved-format-contract.md) states the general recovery unit and restore procedure; the steps here are the dated record for these specific builds.

1. The `ai-chat` command resolves through an npm global link to a separate clone's `dist/cli.js`. Before the 2026-09-19 activation that clone was at `c6f7676`, entry `0d72d73a…`, build identity `0ce4d4fe…`, and a clean checkout of that commit reproduces the identical build identity. Activation was `git checkout 98bb697`, `npm ci`, `npm run build` in that clone. After any later activation, record the same three facts first: `readlink -f "$(command -v ai-chat)"`, that clone's `git rev-parse HEAD`, and its build identity from the rerun command above.
2. Back up the session storage while nothing owns it: `cp -R ~/.agents/ai-chat/sessions ~/ai-chat-sessions-before-images`. Check that no workspace directory in it has a `room.lock`. A lone `session.json` is not a recovery unit, because the blobs and the index live beside it. Keep the backup private.
3. To roll back, with every AI Chat process closed, run `git checkout c6f7676 && npm ci && npm run build` in that same clone. Confirm `readlink -f "$(command -v ai-chat)"` still ends in that clone's `dist/cli.js` and that `shasum -a 256 dist/cli.js` is `0d72d73a7e0f0bd5e1e808512f309c80ff35554cca60623c442040a2af651f0a`. To return to the release, `git checkout 98bb697 && npm ci && npm run build`. The storage needs no conversion in either direction, within the limits above.
4. If storage is ever damaged, restore into separate storage and never over the live directory: `cp -R ~/ai-chat-sessions-before-images ~/ai-chat-sessions-restored`. Open it with the new build by the path of its own entry point, because after step 3 the bare `ai-chat` command is the previous build, which cannot show or verify images. From the same launch directory, run `node <new build checkout>/dist/cli.js resume <ID> --state-dir ~/ai-chat-sessions-restored`, after confirming that checkout's build identity matches the candidate's. The cycle rehearsed exactly this with the new build's explicit entry point. The restored copy matched the backup byte for byte, the new build opened the session and listed its draft images, and every reference resolved to its original bytes. The rehearsal used the terminal only.
5. Work done after the backup exists only in the live directory. Copy that directory aside before any restore, and open either copy with `--state-dir` and the explicit entry point of the build you mean to use. The cycle kept the pre-downgrade backup and the post-downgrade state as separate copies, and the backup was still byte-identical at the end.

Recovery was not needed, because direct compatibility held on both cycles. It stays the fallback. This is the local private pilot that `package.json` and the README describe: no npm publication, tag, distribution pipeline or website deployment is part of this release.

## Provider behavior

Codex app-server is launched with a named restricted permission profile and,
since #105, `default_permissions` set to that same profile. Codex 0.156.1
refuses to load a configuration that defines permission profiles without a
default one (`config defines [permissions] profiles but does not set
default_permissions`); the 2026-09-10 probe (`image-compatibility-probe.md`, private historical record)
recorded the same refusal. Every thread still selects the profile explicitly
and the policy check still requires it to be the active profile, so the default
widens nothing. This was verified live on 0.156.1 on 2026-09-24; see the
[#105 live record](image-support.md#newer-cli-eligibility-live-record-issue-105).

| Behavior                                  | Codex 0.153.4                     | Claude Code 2.1.263                  |
| ----------------------------------------- | --------------------------------- | ------------------------------------ |
| Existing subscription login               | Verified ChatGPT account          | Verified Claude subscription account |
| Workspace text inspection                 | Live random-marker check          | Live random-marker check             |
| Symlinked skill and supporting-file reads | Live random-marker check          | Live random-marker check             |
| Parent-file escape                        | Tool refused                      | Tool refused                         |
| Received / activity / streamed reply      | Observed separately               | Observed separately                  |
| Structured contribution and pass          | Verified in real room             | Verified in real room                |
| Exact public-history retrieval            | Live token check                  | Live token check                     |
| Reconnect context                         | Fresh-session fallback, disclosed | Native session resumed               |
| Missing native session                    | Fresh-session fallback            | Fresh-session fallback               |
| Explicit stop after receipt               | Live interruption verified        | Live interruption verified           |
| Direct peer discussion / human correction | Verified                          | Verified                             |

Codex runs through app-server with room-owned dynamic tools. Native execution environments are disabled for task turns. The installed CLI removed the older `readOnly.access` configuration, so the adapter uses a named permission profile. It disables inherited hooks, MCP servers, apps, plugins, browser/computer integrations, native shell and other task integrations that could bypass the room policy. The dynamic-tool host stays enabled because this CLI needs it to dispatch host-provided tools. Standard Codex instructions and applicable AGENTS files are supplied as explicit instruction inputs.

On this installation, `thread/resume` does not accept the `environments` setting and its native AGENTS loader fails under restricted filesystem permissions. The adapter catches this specific compatibility failure, starts a restricted fresh thread, and tells the room to restore public history with a visible reset notice. It also falls back when a saved thread is missing. It does not loosen task permissions or silently treat other initialization failures as successful recovery.

Claude runs in restricted print/stream-json mode with native tools disabled, strict MCP configuration, external settings sources suppressed, hooks/plugins disabled, and no interactive approvals. Only the room's local MCP tools and structured-output/control tools are accepted in its reported tool inventory. Unexpected tools make the participant unavailable. The outcome schema uses JSON Schema draft-7, which the tested CLI accepts.

Claude Code 2.1.276 was separately verified for provider safeguard refusals on 2026-09-18 through the adapter's persistent stream-json transport. The observed order was `system/model_refusal_no_fallback`, a synthetic assistant API-error, then an error result. The system event used `api_refusal_category`, `api_refusal_explanation`, and `refused_user_message_uuid`; its request UUID and session matched the active request, and `parent_tool_use_id` was absent. The assistant event used `is_api_error_message`, `message.stop_reason: refusal`, and `message.stop_details.category` / `message.stop_details.explanation`; its request UUID and session matched, and `parent_tool_use_id` was null. Both structured explanations omitted the probe marker and shared no 24-byte fragment with the trigger. The probe retained no prompt, transcript, private reasoning, credentials, image bytes, or response content. Rerun this byte-free contract check after a Claude CLI upgrade before changing these parser fields.

Codex and Claude retain their own login storage and provider-side/native conversation records. Chittr does not copy tokens into its YAML or session snapshots. API-key and alternate-billing environment switches are removed from the child environment, and subscription authentication is checked before participation.

### Grok Build and Antigravity CLI

| Behavior                                                       | Grok Build 1.0.5                                           | Antigravity CLI 1.1.27                     |
| -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| Existing login                                                 | Native OIDC subscription verified                          | Native Google login through macOS Keychain |
| File inspection and parent-file refusal                        | Live random-marker check                                   | Live random-marker check                   |
| Symlinked skill and supporting-file reads                      | Live random-marker check                                   | Live random-marker check                   |
| Receipt, activity, streamed text, structured reply             | Verified                                                   | Verified                                   |
| Reconnect and missing session                                  | Fresh session, public history restored and reset disclosed | Same                                       |
| Exact public-history retrieval                                 | Live token check                                           | Live token check                           |
| Stop after receipt                                             | Verified                                                   | Verified                                   |
| Direct peer discussion, correction, repeated turns, and passes | Verified with Antigravity                                  | Verified with Grok                         |

Grok runs `grok agent --no-leader --agent-profile … stdio`. The generated profile disables native task tools, skills, AGENTS discovery, subagents, managed MCP integrations, memory, and inherited configuration. Its only tools are the room's MCP tools and Grok's MCP search/dispatch helpers. The adapter verifies the reported tool inventory and the sole connected MCP server before participation. ACP permission requests are approved only for exact room tool identities. Native filesystem/terminal client requests are refused. Grok's `outputSchema` option caused it to answer before doing tool work in the live probe, so Chittr supplies the schema as instructions and validates final JSON itself. Malformed results fail the turn; they are not published or automatically retried.

Antigravity runs `agy` in stream-json mode. A generated global custom agent has only `finish` in its native tool list and inherits the room MCP server. Native MCP resource wrappers remain exposed but are denied by the room hook. Startup verifies that the compiled hook denies native tools and records its invocations. Explicit native file, write, command, and URL deny rules supplement that hook; every permitted task operation goes through the same room MCP worker as Claude and Grok. The native completion tool is required to finish structured responses. Adding `call_mcp_tool` to the custom agent's tool list fails with an unknown-component error in 1.1.27, and its init event lists the global registry rather than the effective profile tools. Because that inventory proves nothing about the selected profile, since #105 startup runs one bounded enforcement probe before the room gets the session: a maintenance turn with task tools denied that asks the profile to call the native `write_file` tool once, on a file inside its isolated scratch directory. The host names the target before the hook exists and passes its absolute path to the hook, which records only whether the call meets the closed probe argument contract, never the arguments: every key must be a known destination or content key, every destination field must equal that path or its bare file name exactly, every content field must be the probe content, and one of each must be present. An unknown field, a relative or parent-directory path, another directory, a conflicting destination field, other content or a missing field is not the target. No live build has established the native write schema, so a build whose arguments do not meet the contract yields no enforcement evidence and is refused rather than admitted on a guess. Enforcement is observed only when the hook recorded exactly one `write_file` denial meeting that contract, the CLI's own result reported exactly that denied write and nothing else (a call the CLI rejected for its own reasons, or some other denied call, is not an honored denial of the probe write; the report must be a single entry naming `write_file`, as a string or under a name-like field), no task tool was attempted during the probe, the target does not exist afterwards and nothing else appeared in the scratch directory. A file that exists, any other new scratch entry, a write recorded against another target or a second write, a native tool other than the requested one, a missing denial record, a failed probe turn, or a timeout refuses startup with that reason; a hook invocation alone, such as on `finish`, is not enforcement evidence, and no version is compared. This replaces the earlier exact 1.1.27 pin. The probe has not been exercised on a live CLI: Antigravity's startup criterion under #105 stays open until it is. Live probes on 1.1.27 observed the hook deny native file/resource reads, and the room worker deny access beyond the launch directory.

Both new adapters run in disposable homes and scratch working directories, avoiding inherited project/user hooks, plugins, MCP servers, and native customizations. Room tools still operate on the actual launch directory. Grok points its native auth manager at the existing `GROK_AUTH_PATH` or `<GROK_HOME>/auth.json` (default `~/.grok/auth.json`); it accepts only the OIDC auth mode. Antigravity's isolated home links only `Library/Keychains` to the user's existing Keychain directory, so the CLI can authenticate normally without copying tokens. Task tools cannot read that link or the runtime home. `agy models` verifies account access before connecting; API/ADC/server-override environment settings are removed, and overflow AI credits are disabled. Neither adapter requires a separate sign-in or uses an SDK token workaround.

The native process retains context across consecutive turns. On stop, reconnect, or application restart, a fresh native session receives saved public history with a disclosed reset. Temporary native records are removed on graceful close; an abrupt process kill can leave a temporary directory behind. Saved room transcripts remain in the normal central storage.

Chittr discovers skills itself and supplies a provider-specific catalogue. Agents read skill instructions through room tools; native skill tools remain disabled. Claude launches without `--disable-slash-commands` so its built-in `/compact` stays reachable, and denies native skills, agents and tasks through `--tools ''`, `--disallowedTools Skill,Agent,Task`, no setting sources, disabled bundled skills, disabled skill shell execution and disabled hooks, refusing to start on a CLI that lacks any of those flags. Skill frontmatter does not grant tools, enable hooks, execute prompt snippets, or spawn agents. `disable-model-invocation` becomes explicit-request guidance in the catalogue. Other provider-specific skill execution settings are not implemented.

## Task permission boundaries

The room's file tools are implemented by a small worker under macOS `sandbox-exec`. Ordinary task paths must stay inside the launch directory and cannot traverse symlinks, including links that remain inside the workspace. With skills enabled (the default), discovered skill bundles receive an additional read-only grant. Installed links are resolved at configuration load, and nested links must resolve within discovered bundles for that provider. Retargeted installed links require idle reload. File tools support bounded text reads, directory listing, and explicitly granted workspace text writes. Recursive listing skips `.git` and `node_modules` contents unless explicitly requested.

General commands require `permissions.commands: true`. Without a user trust grant or launch flag, they use a deny-default OS sandbox. The sandbox permits the workspace, discovered skill bundles, and selected operating-system, executable and package-runtime files needed to run commands. It does not grant general reads of the user's home directory or neighboring project files. The command environment contains a constrained PATH, locale and private scratch directory. Commands may write scratch; workspace writes and task networking each require their own grants. Writes to registered skill bundles are explicitly denied, including bundles inside the workspace, even with edits enabled. These are local command controls, not a full container environment.

Trusted commands run outside that sandbox with the launching user's exported environment, filesystem access and existing authentication. They require all three permissions plus a user-only workspace grant or `--trusted-commands`. File-tool restrictions remain in effect; they do not restrict trusted commands. MCP forwards commands to a participant-bound executor in the room process. Every sandbox explicitly denies the executor's credential directory and actual Unix socket connections, even with network enabled. Application profiles, wider sandbox reads and Homebrew PATH changes are outside this change.

`fetch_url` requires `permissions.network: true`, accepts HTTP(S), times out, and limits response text. Task network access includes local addresses when explicitly enabled. Provider inference and authentication necessarily use networking independently. The conversation-history tool reads only a fixed public-history snapshot supplied by the host; the model cannot select its backing path.

A CLI that cannot initialize under these controls remains unavailable while other participants continue. A parent development sandbox may prevent starting a macOS child sandbox at all; run the pilot in a normal terminal in that case. Other operating systems deliberately fail the enforcement check.

## Executed checks

- Trusted command checks on 2026-09-08 verified the read-only `gh-codex api user --jq .login` operation through Codex's dynamic tools and Claude, Grok, and Antigravity's MCP connections to the room executor. All four used the same registered test identity and Keychain fallback. Prompt visibility was not instrumented; successful authentication proves compatibility, not Keychain isolation. No credential values were printed. The sandbox probe separately verified actual broker socket connection denial with network enabled and isolated MCP forwarding with external helper discovery, configuration reads and state writes, while file tools remained restricted.
- TypeScript check/build and deterministic tests cover strict config merging, instruction replacement/file resolution, routing, concurrent scheduling, FIFO batching, shared cap reservation, failed-outcome isolation, waiting-for-human metadata, pause/stop/retry, recovery, idle permission reload, shutdown during connection, storage failures, JSON streaming and Unicode input.
- The PTY check typed while a deterministic peer streamed. It verified stable draft cursor and history reading position, Enter/Ctrl+J/distinct Ctrl+Enter, capability negotiation, chunked bracketed paste, participant/path completion, Unicode draft persistence, and terminal-mode restoration on exit. It uses a real pseudo-terminal, not a real terminal emulator's keyboard hardware mapping.
- The browser checks use headless Chrome with deterministic peers. They cover concurrent streaming, passes, message/code rendering, copy output, input and completion, history position, draft refresh, lost-acknowledgment recovery, room and agent controls, session restore, and desktop/narrow layouts. Clipboard output is captured by a test fixture. The local HTTP tests cover authentication, Host/Origin rejection, workspace boundaries, command deduplication, stale-session rejection, draft ordering, and graceful quit.
- The native sandbox probe verified in-workspace inspection, denied parent and symlink reads, each missing permission, permitted commands with denied outside reads/writes/network, permitted workspace edits with denied outside writes, and explicitly enabled HTTP fetch against a disposable local server.
- Both live adapter probes verified a random file marker, refusal of parent-file access, receipt/activity/text events, structured responses, reconnect context, exact public-history retrieval, and unavailable-session fallback.
- The live skill probe used separate disposable provider bundles linked outside the workspace. Both providers read unique manifest and supporting-file tokens through room tools. Deterministic tests cover provider isolation, discovery warnings, internal links/cycles, escaped references, opt-out, config precedence, and context reset after a link moves. The native sandbox probe also verifies skill script execution when commands are granted, denied escaping links, and denied bundle writes through file tools and commands even with workspace edits enabled.
- The live room check ran a Codex-to-Claude review question about a TypeScript file, required file inspection by both, delivered a human correction concurrently, recorded contributions from both, then recorded two passes without starting another exchange. Its saved transcript matched the completed room.

Commands and fixtures are in `scripts/`; all generated task fixtures are disposable and cleaned up. Codex/Claude live tests leave native conversation records in their usual CLI storage; the new adapters remove their temporary native profiles on close. `doctor` performs initialization and a sandbox handshake; it does not prove model availability, response quality or future quota availability.

## Pilot limits

- Web mode is a local browser interface backed by the launching process. Closing a tab leaves the room running; explicit quit or Ctrl+C stops and saves it. Browser command receipts last for that process only. One workspace lock still prevents competing terminal and web processes. Browser assets are bundled locally, and the browser does not connect directly to providers.
- Codex native resume uses the disclosed fallback described above. Restored context contains the saved public conversation, not private provider reasoning or the complete native tool transcript.
- Long history is represented by a labelled extractive digest with exact retrieval. It is not a semantic summary that guarantees every decision fits in the initial prompt.
- The terminal renderer displays wrapped text without Markdown styling. Wheel/trackpad scrolling uses SGR mouse reporting, with keyboard paging as a fallback. Mouse reporting is disabled again when the UI closes. Ctrl+Enter depends on the actual terminal's encoding; Ctrl+J is always offered. A subjective usability pass in the user's preferred terminal is still needed.
- Human messages are limited to 64 KiB. Reads/fetches are bounded and file reads can paginate. Slow or disconnected model turns time out and require explicit retry. Reconnect initialization is bounded too.
- Writes are ordinary shared-workspace operations. Concurrent agents can conflict when edits are enabled; stop cannot undo already completed effects. The initial discussion/inspection policy avoids those write conflicts.
- Storage uses atomic snapshots, not an append-only event log. Graceful termination saves; an abrupt kill or power loss can lose the most recent unsaved streaming/draft checkpoint. Completed messages and dispatch reservations are saved synchronously. Sessions remain until manually removed.
- This is a local personal pilot, not an audited hostile-code isolation product. Public packaging, licence choice, cross-platform enforcement and broader release testing remain deferred as agreed.

## Primary references

Implementation follows the installed CLI help and generated app-server schemas where they differ from examples in documentation. Relevant vendor references are [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Claude headless operation](https://code.claude.com/docs/en/headless), [MCP server development](https://modelcontextprotocol.io/docs/develop/build-server), the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/), and [xterm mouse reporting](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking).

New-provider references: [Grok Build source](https://github.com/xai-org/grok-build), [Grok headless operation](https://docs.x.ai/build/cli/headless-scripting), [Antigravity headless operation](https://antigravity.google/docs/cli/headless/), [Antigravity custom agents](https://antigravity.google/docs/subagents), [Antigravity permissions](https://antigravity.google/docs/cli/permissions/), and [Antigravity settings](https://antigravity.google/docs/cli/settings/). Where the documentation and installed build differ, the behavior described above comes from direct disposable CLI probes.

## Manual context compaction

Verified on macOS on 2026-09-09. The opt-in command is
`npm run test:compaction -- <provider> <replacement|native>`. Set
`CHITTR_COMPACTION_MODEL` to select a configured model,
`CHITTR_COMPACTION_FOCUS` for optional instructions, and
`CHITTR_COMPACTION_TRACE` to retain the trace at a chosen path. This uses the
CLI's existing subscription. Every fixture uses an isolated launch directory,
room permissions off, native skill execution disabled, and unchanged native
tool restrictions.

| Provider and CLI                        | Native control                                                                                                                                                                                                                                                                                                                                                  | Replacement / source note evidence                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex 0.153.4, `gpt-5.6-sol`            | Verified on this CLI version. `thread/compact/start` acknowledges first; the same thread emits `turn/started`, `contextCompaction` item start/completion, then matching `turn/completed`. Three native operations and continuation passed. Cancellation after item start captures the compact turn ID for `turn/interrupt`, then closes uncertain native state. | Three checkpoint replacements with source notes passed. A separate source-context probe recovered an unfinished-check marker absent from the handoff request. Per-turn maintenance schema and absent normal-turn tool signal prevent task execution.                                                                                                  |
| Claude Code 2.1.266, `claude-fable-5-1` | Verified on this CLI version. Sends `/compact [instructions]`; requires a fresh manual `compact_boundary` in the same session and a result matching the outgoing user UUID. Three boundaries, custom-focus forwarding, continuation and cancellation passed. The exact correlated `Not enough messages to compact.` response is a no-op.                        | Three replacements passed on 2.1.265 under the prior launch policy. Source notes remain unavailable. The current policy keeps the built-in compact command, denies Skill/Agent/Task, disables bundled skills and skill shell execution, and retains restricted mode, empty native tools, strict MCP, disabled hooks and room-tool maintenance gating. |
| Grok Build 1.0.13, `5e9a58528b76`       | Verified on this exact stable build. `_x.ai/compact_conversation` accepts `session_id` and optional `user_context`; its correlated empty-object reply arrives after compaction completes. Three native operations with custom focus, continuation and cancellation passed under the existing isolated ACP profile.                                              | Three replacements and continuation passed under the same isolated profile. Source notes remain unavailable.                                                                                                                                                                                                                                          |
| Antigravity                             | No native route; replacement only.                                                                                                                                                                                                                                                                                                                              | One replacement passed with the verified 1.1.27 CLI. Before the second replacement the installed CLI changed to 1.1.28, and the version gate in force at the time refused startup. No three-cycle or continuation success is claimed for Antigravity.                                                                                                 |

The table records the builds those fixtures ran on. Since #105 no route is
enabled by version: Codex, Claude and Grok select the native route after every
successful start, on those builds and on uncatalogued newer ones, and the
adapter validates the actual operation as the table describes. Codex enables
its native compaction and source handoff only when every required native
policy observation on the started thread passed (named restricted profile,
never approvals with the user as reviewer, read-only sandbox without network,
direct read-only workspace grant, reported profile and network state, denied
temporary roots, disabled native features, web search and MCP servers); the
fresh-thread projection is image-only, so a resumed thread keeps its
maintenance routes. A failed or missing required observation refuses startup
with the observations named and closes the process, since the room could not
enforce its policy on that thread through any route. A CLI that
answers the native request with an unknown-method error, another shape or a
timeout fails that operation, keeps the saved reference and requires explicit
recovery. On 2026-09-24 the native route completed three cycles on Codex 0.156.1
and Grok 1.0.34, Codex replacement carried its source note on 0.156.1, and the
product `/compact` route completed on Claude Code 2.1.274 in the same process
that denied native skill, shell, fork and task commands; the
[#105 live record](image-support.md#newer-cli-eligibility-live-record-issue-105)
has the sanitized runs and the gaps.

The recorded fixtures and event traces (`compaction-2026-09-09.json`, private historical record)
include each accepted checkpoint, marker/source checks, seed byte sizes, source
notes, and continuation results. Replacement fixtures distinguish the old and
new correction markers, proposal and objection, pending question, and artifact
pointer. Codex, Claude and Grok retained all markers in the required checkpoint
categories with the expected source IDs and author attribution over three
replacements. Subsequent normal turns recalled the correction and received a
room-tool denial for `/etc/hosts`. These checks establish fidelity for the
recorded fixtures, not universal summary accuracy.

The native focus fixtures and selected control events (`native-compaction-focus-2026-09-09.json`, private historical record)
record the updated Claude and Grok routes. Claude reported three manual boundaries
with pre/post counts of 13,267/1,812, 14,970/1,995, and 15,283/2,219 tokens.
Both providers retained the correction markers after three native operations.
A separate Grok probe retained epic 42, ticket 17, the release correction and a
literal retention marker. Both providers still denied `/etc/hosts` through the
room tools. Cancellation while native compaction was pending closed both
provider processes. Claude's disposable native shell and fork skills returned
unknown-command results, produced no marker files and exposed no Skill or Agent
tool. AI Chat's managed catalogue and supporting-file probe still passed.

Custom instructions belong to the provider interface. Claude's
[compact command](https://code.claude.com/docs/en/commands) and Grok's
[compact context argument](https://docs.x.ai/build/modes-and-commands) support
them. The installed Codex 0.153.4 generated app-server schema defines
`ThreadCompactStartParams` as `{ threadId: string }`, so Chittr sends a plain
native compact request to Codex. Checkpoint replacement uses its standard
preservation prompt; custom focus is reported as unsupported on that route.
No YAML flag enables this behavior. Claude's previous hardcoded
`--disable-slash-commands` disabled compact for every room configuration. Since
#105 no Claude build launches with it: the built-in command surface is bounded by
the other launch controls on every build, and the live init inventory is checked
on every turn and compaction.
See Claude's [skill restrictions](https://code.claude.com/docs/en/skills) for the
separate Skill denial and skill shell execution settings.

Codex native success requires both the matching compaction item and completed
turn. Claude requires its fresh manual boundary and matching user result; the
verified short-history response is its only recognized provider no-op. Grok's
completion RPC is defined in the upstream
[extension handler](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/memory.rs)
and [request schema](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/acp_types.rs).
It provides neither a token-reduction measure nor a distinct no-op response.
An acknowledgement, unrelated completion, or error does not establish success.
The room reports an empty public conversation as `nothing-to-compact` without
issuing a provider operation. Native
failure, timeout, or cancellation retains the saved reference and requires
explicit recovery; it never silently starts a second operation.

Controlled tests also exercise stale events, errors, timeout, cancellation
before a turn ID, shared parent/MCP tool denial, duplicate and concurrent
requests, writer cancellation, failed preparation/save, source and coverage
validation, restart before and after swap, large-history chunking, and exact
reply-target preservation. Browser validation uses installed Chrome via
`CHITTR_BROWSER` when Playwright's bundled executable is unavailable.

## Native image delivery probe

The 2026-09-10 image probe (`image-compatibility-probe.md`, private historical record) verified native
initial-image delivery and fresh-session `read_attachment` retrieval with Claude
Code 2.1.257 and `claude-fable-5-1`. Codex stopped at permission configuration
on this host despite the earlier same-version startup record above; the cause
remains a separate product/CLI compatibility follow-up.
Grok and Antigravity executables were unavailable on that host. The report records
all eight outcomes, sanitized traces, transport sizes, and a throwaway probe patch.
These results do not add image support to the product.

The 2026-09-12 follow-up (`image-compatibility-probe.md#2026-09-12-current-baseline-verification`, private historical record)
verified disposable Grok 1.0.13 initial delivery and fresh-session retrieval.
Codex 0.154.0 passed the native-event correlations and private visual checks on
both paths, but the effective response returned zero runtime workspace roots
after the probe requested one, so both Codex paths remain unverified under the
complete policy contract. The retained run also records the executable
identities resolved at the actual Codex and Grok process-spawn boundaries.
Antigravity 1.1.28 stopped at the unchanged exact 1.1.27 gate. Production image
support remains owned by the persistent-image implementation issues.

The workspace-root follow-up (`codex-workspace-roots-2026-09-15.md`, private historical record) explains
that projection. On 2026-09-15 it kept Codex image enablement blocked pending a
separate policy decision.

Everything in this section is a dated probe result. The probes were disposable and
did not themselves enable product support, and their outcomes stand as recorded.
Later work changed the product: the owner decided the Codex policy question on
2026-09-16, and #52, #53, #56 and #69 added the production mappings. Current status
is in [image release status](#image-release-status-issue-58). Antigravity 1.1.28
was never approved, no other Antigravity version was selected, and Antigravity
images are unsupported in this release.
