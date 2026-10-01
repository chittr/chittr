# Image support and local verification

Records marked "private historical record" below are held privately under
[#99](https://github.com/mcgloneb/ai-chat/issues/99) and are absent from this
checkout. The linked #105 records remain in the tree until a refreshed R2
milestone covers their preservation. Each record establishes only its dated
results and limitations; record new sanitized acceptance on the owning open issue.

Issue #50 supplies the shared foundation for [epic #46](https://github.com/mcgloneb/ai-chat/issues/46). Provider implementation and acceptance are in #52, #53, #56 and #69. Antigravity images are unsupported in this release: Bill took #54 and #55 out of #46 on 2026-09-16, and they belong to a later epic. Integrated acceptance across the three supported providers is #57, [recorded below](#integrated-acceptance-issue-57); it closed on 2026-09-18 with 40 of 42 in-release rows passed and the two Claude continuity rows failed upstream. The released build, its activation check and the rollback procedure are in [image release status](compatibility.md#image-release-status-issue-58). No support below authorizes a policy relaxation, restored native image tool, new Antigravity version or release.

## Product contract

`AgentAdapter.imageSupport()` reports `initial` and `retrieval` independently. Each unavailable path has a byte-free reason. Room preflight uses only `initial.available === true`; `nativeInitialImages` and the compatibility `initialImageSupport()` accessor cannot authorize dispatch. Grok derives both compatibility accessors from the report. Missing reports fail closed. Initial refusal preserves the per-recipient failure and notice, charges no exchange, keeps text flowing and requires an explicit retry after support changes.

`src/image-support.ts` contains the report types, the code-owned bridge registrations and the record of tested builds. Since #85 neither Claude's nor Codex's CLI version decides image eligibility, and #69 did the same for Grok, whose gate still requires an observed CLI identity and keeps the exact 1.0.13 restriction below. Since #105 no provider's requested or observed model or effort decides it either. Eligibility comes only from what the adapter observed on its own live process: Codex needs the native policy checks that startup enforces to have passed and a native session that reported its model and effort, on a fresh or a resumed thread; Claude needs a connected process whose observed native tool inventory has not failed, so images are available from connection and in the first message; Grok needs its observed isolated-room runtime contract, a verified native inventory and an observed session model. Room permissions, skills and command mode do not change image delivery and decide nothing, so every room configuration, including the defaults, is eligible; the native restrictions are the same in every configuration. `claudeImageBridge`, `codexImageBridge` and `grokImageBridge` are the registrations, one key per provider, and `registeredImageMapping` consults nothing else. `testedImageBuilds`, `testedClaudeImageBuilds` and `testedCodexImageBuilds` record which CLI identities, models and efforts were exercised and are not consulted by any gate. A version difference, a different model or a different effort never closes or opens a gate, in either direction, and nothing is inferred from semver order for any provider. An available path on an unlisted release or an untested model means the required observations passed; it does not mean that release or model was visually tested, and a provider or model that cannot take images fails at delivery with the provider's own error. A missing, unknown or failed observation remains unavailable. The exact `grok 1.0.13 (5e9a58528b76) [stable]` identity keeps its older room restriction. The contract and the current coverage are detailed below; the older foundation evidence remains historical. Providers without a registered bridge report unavailable using their own version observations. CLI and model diagnostics accept only bounded identity formats; arbitrary diagnostic text is not echoed. Unavailable reasons end with the live CLI identity and, once observed, the observed model and effort, as diagnostics.

Only host/adapter code calls `ToolService.registerRetrievalBridge({key, report})`. The key must be the code-owned bridge registered for that provider, and the live retrieval report must be available. Registration writes no pixels and cannot create a transport. It revokes the old turn before selecting the next route. The host-authored turn file carries the selected key/provider, revision, active state and room session; an isolated MCP reader cannot register a route. The separate process checks the same code-side mapping inventory. A registry entry alone grants nothing.

Known unavailable providers receive their report reason in MCP/dynamic-tool text, with `attachment-unavailable`. Unknown keys retain the generic `retrievalUnavailable` response. There is no additional human notice or transcript entry for retrieval refusal. `read_attachment` still requires a current authorized public-history reference; interruption, changed history, session/revision mismatch, maintenance and close revoke it. `AttachmentResult` rechecks authority, bytes and limits at serialization. `codexToolResult` still emits only byte-free `inputText`, even when handed a typed result.

Adapter lifecycle and capability-report transitions are described in the
[provider adapter contract](adapter-contract.md).

## Gates and coverage

| Condition                                                                                            | Current disposition                                                         | Evidence and unresolved work                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registered bridge: `claude-mcp-image`, `codex-dynamic-image`, `grok-mcp-image`                       | Hard transport gate                                                         | Code-owned registration per provider, separate from the tested-build records, which register nothing. An unknown or wrong-provider key is refused whatever the CLI reports. Since #85 Claude's and Codex's CLI builds are not gates either, as Grok's stopped being one at #69; each version is evidence and a bounded diagnostic, apart from Grok's identity requirement and legacy 1.0.13 restriction below.                  |
| Claude connected process and a native tool inventory that has not failed                             | Hard policy/transport gate                                                  | Live adapter observations only. Available from connection, before any turn; a disconnected process is `not_observed`, an observed failing inventory `unsupported`. Every turn's init still aborts on an unexpected native tool, and a failing inventory revokes retrieval for the rest of that turn. Since #105 the requested model and effort and the observed model are evidence, not compared. #85, #105, local ticket 0001. |
| Codex native policy that startup enforces, natively observed model and effort                        | Hard policy/transport gate                                                  | Live adapter observations only. Fresh and resumed threads are decided alike; the environment projection and route are evidence. A thread whose other native policy observations fail never starts. Since #105 which model and effort were requested or observed is evidence, not compared. #85, #105, local ticket 0001.                                                                                                        |
| Room permissions, skills and command mode                                                            | Evidence, not a gate                                                        | Room policy does not affect image delivery, and native restrictions are the same in every configuration, so no current gate reads it. Only the exact legacy Grok 1.0.13 identity keeps its restriction below. Local ticket 0001.                                                                                                                                                                                                |
| Grok observed isolated-room runtime contract                                                         | Hard policy/transport gate                                                  | Host-created isolated runtime, ACP initialization, cached subscription authentication, exact room MCP inventory and a live process, each set by `src/adapters/grok.ts` only after it passed. Missing, unknown or failed is unavailable on both paths. #69.                                                                                                                                                                      |
| Current host turn, public history, session and revision                                              | Hard authorization gate                                                     | `test/attachment-retrieval.test.ts`, `test/attachment-adapter-lifecycle.test.ts`; checked again at final serialization.                                                                                                                                                                                                                                                                                                         |
| Effective Grok tool inventory, isolated MCP, denied filesystem/terminal capabilities and `image_gen` | Hard policy/transport gate                                                  | `src/adapters/grok.ts` start checks and existing native evidence. No native task-tool restoration.                                                                                                                                                                                                                                                                                                                              |
| Grok requested and observed model                                                                    | Evidence and diagnostic, not a gate                                         | Since #105 an explicit request or a model outside the records is not a mismatch; only a missing session-model observation closes the paths. The recorded runs requested the provider default and observed `grok-4.6`; the exact 1.0.30 room coverage is recorded below.                                                                                                                                                         |
| Grok 1.0.13 edits, commands and network all false                                                    | Retained restriction; permission dependency and trusted coverage unresolved | Restricted native evidence passes. Neither trusted behavior nor independence of these settings from transport/policy enforcement is established. #56 must supply restricted and trusted coverage plus effective-policy evidence before removing a restriction.                                                                                                                                                                  |
| Grok 1.0.13 skills disabled                                                                          | Retained restriction; broader coverage unresolved                           | Only skills-off evidence is accepted. Do not infer safe skills-on behavior from a room YAML file.                                                                                                                                                                                                                                                                                                                               |
| Grok effort                                                                                          | Test configuration, not an image gate                                       | Existing default-effort behavior is preserved. `high` was requested and natively selected in the accepted 1.0.30 trusted-room runs below.                                                                                                                                                                                                                                                                                       |
| Codex workspace roots                                                                                | Evidence, not a gate                                                        | Zero environments/roots were approved for fresh threads on 2026-09-16. Bill approved images on resumed threads for chittr/chittr, superseding #63's hold, in local ticket 0001; whether a resumed thread's environment is acceptable as a session-level policy question stays open.                                                                                                                                             |
| Antigravity CLI/configuration and both image paths                                                   | Unsupported in this release                                                 | Out of #46 by Bill's 2026-09-16 scope decision. #54 and Bill decide version/configuration for the later epic. Nothing here widens the production gate.                                                                                                                                                                                                                                                                          |

The foundation retained these restrictions. #56 adds the restricted and sandboxed-command 1.0.30 room coverage below. #69 replaces Grok's exact-build gate with the observed runtime contract, adds the trusted-command room, and owns the 1.0.34 coverage of all three rooms. The two 1.0.13 rows above still describe that exact identity. A pending coverage row cannot override a hard gate or an unresolved dependency.

## Tested builds and coverage inventory

Accepted historical Grok evidence applies only to `grok 1.0.13 (5e9a58528b76) [stable]`, requested provider default, observed `grok-4.6`, task permissions off and skills off:

- Initial delivery (`persistent-image-initial-2026-09-12.json`, private historical record), source `5c929b648a19adb3964c712d3b6b4c40243dfd44`.
- Controller retrieval (`persistent-image-retrieval-2026-09-12.json`, private historical record), with source, sessions and individual outcomes in the record.
- Browser entry (`persistent-image-browser-2026-09-13.json`, private historical record), with authenticated paste/upload/send and actual replacement session evidence.

The tested-build catalogs retain the historical CLI/model identities and issue numbers. Claude and Codex eligibility use their approved mappings; Grok mapping registration still uses its catalog key, while its initial-image gate uses live runtime observations. All inventories carry the provider and registered mapping key. The initial verification attempt (`image-support-foundation-2026-09-15.json`, private historical record) was blocked. The completed regressions (`image-support-foundation-verified-2026-09-15.json`, private historical record) are historical verification, separate from the code inventory. Original records are held privately under #99; fields not observed there stay unknown.

| Provider / requested model / effort                                | Room                                                | Initial / retrieval       | Status and owner                                                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Grok / provider default / provider default                         | Restricted, skills off, command mode off            | Accepted / accepted       | Exact build above; both migration regressions passed below                                                               |
| Grok 1.0.30 / provider default / high, observed `grok-4.6`         | All permissions true, skills on, sandboxed commands | Accepted / accepted       | #56; current evidence below                                                                                              |
| Grok 1.0.30 / provider default / provider default                  | Restricted, skills off, command mode off            | Accepted / accepted       | #56; current evidence below                                                                                              |
| Grok 1.0.34 / provider default / provider default                  | Restricted, skills off, command mode off            | Accepted / accepted       | #69; evidence (`grok-images-2026-09-17.json`, private historical record) and the issue-69 section below                  |
| Grok 1.0.34 / provider default / high                              | All permissions true, skills on, sandboxed commands | Accepted / accepted       | #69; evidence (`grok-images-2026-09-17.json`, private historical record) and the issue-69 section below                  |
| Grok 1.0.34 / provider default / high                              | All permissions true, skills on, trusted commands   | Accepted / accepted       | #69; evidence (`grok-images-2026-09-17.json`, private historical record) and the issue-69 section below                  |
| Claude / opus / xhigh                                              | Restricted                                          | Accepted / accepted       | #53; recorded build and linked evidence below                                                                            |
| Claude / opus / xhigh                                              | Trusted, all permissions true, skills on            | Accepted / accepted       | #53; recorded build and linked evidence below                                                                            |
| Claude 2.1.274 / opus / xhigh                                      | Restricted                                          | Accepted / accepted       | #57 owner decision; its own six-run set (`claude-images-2026-09-17.json`, private historical record)                     |
| Claude 2.1.274 / opus / xhigh                                      | Trusted, all permissions true, skills on            | Accepted / accepted       | #57 owner decision; its own six-run set (`claude-images-2026-09-17.json`, private historical record)                     |
| Claude 2.1.276 / opus / xhigh                                      | Restricted                                          | Accepted / accepted       | #57 owner decision; its own six-run set (`claude-images-2026-09-18.json`, private historical record)                     |
| Claude 2.1.276 / opus / xhigh                                      | Trusted, all permissions true, skills on            | Accepted / accepted       | #57 owner decision; its own six-run set (`claude-images-2026-09-18.json`, private historical record)                     |
| Claude 2.1.277 / opus / xhigh                                      | Restricted                                          | Accepted / accepted       | #57 owner decision; its own six-run set (`claude-images-2026-09-18-b.json`, private historical record)                   |
| Claude 2.1.277 / opus / xhigh                                      | Trusted, all permissions true, skills on            | Accepted / accepted       | #57 owner decision; its own six-run set (`claude-images-2026-09-18-b.json`, private historical record)                   |
| Codex / gpt-6-astra / xhigh                                        | Restricted                                          | Accepted / accepted       | #52 evidence (`codex-images-2026-09-16.md`, private historical record); verified fresh threads only; resumed unavailable |
| Codex / gpt-6-astra / xhigh                                        | Trusted, all permissions true, skills on            | Accepted / accepted       | #52 evidence (`codex-images-2026-09-16.md`, private historical record); verified fresh threads only; resumed unavailable |
| Antigravity / no version or model selected                         | Restricted                                          | Unsupported / unsupported | Not in this release; #54 and #55 belong to a later epic                                                                  |
| Antigravity / no version or model selected                         | Trusted, all permissions true, skills on            | Unsupported / unsupported | Not in this release; #54 and #55 belong to a later epic                                                                  |
| Grok / any other well-formed CLI identity                          | Any room, contract observed                         | Available / available     | #69 policy: version is evidence, not a gate. No retained evidence exists for an unlisted identity                        |
| Claude or Codex / any other well-formed or unreadable CLI identity | Any room, all required observations passed          | Available / available     | #85 policy: version is evidence, not a gate. No retained evidence exists for an unlisted identity                        |
| Any missing or wrong-provider mapping key                          | Any                                                 | Unavailable / unavailable | Unsupported in the shipped product; never implicitly a staging candidate                                                 |

`accepted` requires linked evidence; `pending` is incomplete or awaiting prerequisites; `unsupported` has no enabled route; `failed` records an attempted run that did not pass. Failed runs retain their partial evidence and cannot become accepted by relabeling them. Future-provider acceptance is not required to complete #50; both current Grok regression runs are required.

Every new run must record the source commit and patch hash, evidence identity, exact live CLI, requested and observed model, effort, actual provider session IDs, effective permissions, command mode and its source, skills, trust grants/launch overrides, and separate visual/native outcomes for initial and retrieval. Unknown observations stay unknown. Never infer effective policy from YAML alone. `off`, `sandboxed` and `trusted` are distinct. Valid trust sources are user-level `trustedCommands.workspaces` or `--trusted-commands`; workspace `permissions.commands: 'trusted'` is invalid because permissions are booleans.

## Rerun the current Grok regressions

From the implementation checkout, install lockfile dependencies, stage all source changes so the patch identity includes new files, then build and run:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
git add src scripts test docs
mkdir -p /private/tmp/image-support-runs
npx tsx scripts/live-attachment-retrieval.ts --adapter grok --model provider-default --effort provider-default --room restricted --scratch-parent /private/tmp/image-support-runs
npx tsx scripts/live-browser-attachment.ts --adapter grok --model provider-default --effort provider-default --room restricted --scratch-parent /private/tmp/image-support-runs
```

The browser script uses installed Chrome, or the explicit `CHITTR_BROWSER` executable. Neither command changes installed provider CLIs or account configuration. Existing subscription login is required. Each run creates a unique scratch directory and prints its evidence path. `--adapter`, `--model`, `--effort`, `--room` and `--scratch-parent` are strict named options; old positional source labels are replaced by automatic commit/patch observation. `provider-default` omits the corresponding provider CLI argument. For Grok, `--room trusted` sets all task permissions true and host skills on with sandboxed commands. It does not add a trust grant. `--trusted-commands` is a separate explicit grant that resolves command mode `trusted`. Both TypeScript scripts and the PTY driver stamp every new Grok run with issue 69, in all three rooms, and record the command mode and source the run resolved. #56's retained records keep their own stamp and are not rewritten. Other providers retain their existing selection requirements. Other providers stop before model dispatch with their missing mapping/observer prerequisite. Unknown options and adapters fail.

`LiveImageDriver` in `scripts/live-image-selection.ts` groups construction, tuple observation and native-boundary observers. Construction uses the ordinary `createAdapter` factory. Provider tickets add their complete driver, including native initial and retrieval observers, without a script-only bridge override. Generic code follows the selected recipient for prompts, pending state, answers and session IDs. Each driver must support actual checkpoint seeding. Both existing scripts create a deliberately lossy saved checkpoint, invoke product reconnect, verify seed completion, a distinct session and clean seed, discover an older attachment through public history, and compare the private answer independently for each path. Initial and retrieval delivery must correlate with content hashes; retrieval must not replay initial pixels. Controller evidence is not terminal evidence.

## Shared local implementation-tree staging

#52, #53, #55 and #56 consume this procedure. The commands below are ordinary Git and provider-CLI invocations and run in any checkout of this repository with `git` on `PATH`; they need no maintainer wrapper and no host-specific executable path. Run them from the repository root. Stage only in that ticket's isolated implementation tree. A candidate is a reviewed implementation/build/configuration with resolved policy and transport prerequisites, pending visual acceptance. Wanting to test an unknown build does not make it a candidate.

1. Record prerequisite and candidate identities before bytes can be dispatched. Fetch the feature branch from `origin`, record its tip and verify the PR45 merge is an ancestor. Record the mapping change, exact installed CLI, requested model/effort, required rooms, observed effective host/native policy and chosen maintenance/fresh-session route. Stage source files so the patch includes new files. Use the selected provider's `--version` command; do not install or retarget it implicitly.

```sh
git fetch origin codex/epic-29-persistent-image-sharing
git rev-parse FETCH_HEAD
git merge-base --is-ancestor f06acb5deed8d30bd6e50c797be4cc8655ecf166 FETCH_HEAD
git rev-parse HEAD
git diff --binary HEAD | shasum -a 256
grok --version
# For the selected other provider: codex --version, claude --version, or agy --version.
```

2. Resolve required transport and policy conditions. Codex waits for #51's separate enablement disposition or Bill's recorded required decision. Antigravity waits for #54 and Bill's version/configuration decisions. Keep native task/image tools denied. A restored tool or policy relaxation is not granted by staging. Since #85 a Claude or Codex CLI version change needs no grant either, for the reason #69 gave for Grok: it is not a gate. Each new version is still a new evidence identity — record it, and do not present another build's runs as its evidence — and the legacy Grok 1.0.13 restriction is unchanged. Record these decisions in the candidate evidence before proceeding.

3. Stage the exact mapping and tested-build candidate only in that implementation tree, and mark its separate local verification record `pending`. Build it with `npm run build`. Use the ordinary support-report, host registration, browser and built-CLI dispatch paths. Do not add a shipped candidate flag, environment bypass, boolean override or pending entry that enables unverified support. A direct controller call or script-only registration cannot establish product acceptance.

4. Run the selected driver's browser command above for each required room, with the ticket's exact requested model and effort. Provider tickets extend the real PTY harness before claiming terminal acceptance. `scripts/terminal-image-live.py` is the existing built-CLI initial-image example, not a complete dual-path harness. It demonstrates Python `pty.openpty()`, terminal input and actual `dist/cli.js` with isolated state. The extension must add provider selection, both room policies, first image, a later image in the same observed provider session, fresh historical retrieval, native observers and private assertions.

For a manual PTY launch against a prepared disposable room, use the built CLI below. Create `.agents/chittr.yaml` in that room with only the selected provider enabled, the requested model/effort, boolean task permissions and explicit skills configuration. Keep the fixture/oracle outside its task workspace and do not retain the terminal transcript. `script` supplies a real PTY; `/dev/null` discards its transcript.

```sh
# Record the absolute implementation checkout before entering the disposable room.
IMAGE_IMPL="$PWD"
IMAGE_RUN=$(mktemp -d /private/tmp/image-provider-candidate-XXXXXX)
mkdir -p "$IMAGE_RUN/workspace/.agents" "$IMAGE_RUN/evidence"
# Write and inspect the selected disposable room configuration, then:
cd "$IMAGE_RUN/workspace"
/usr/bin/script -q /dev/null node "$IMAGE_IMPL/dist/cli.js" --state-dir "$IMAGE_RUN/state"
# Trusted room only, after its policy prerequisites and explicit grant:
/usr/bin/script -q /dev/null node "$IMAGE_IMPL/dist/cli.js" --state-dir "$IMAGE_RUN/trusted-state" --trusted-commands
```

Through actual terminal input, inspect `/config`, stage with Ctrl+O and send the first image, then a different later image without replacing the provider session. Prepare a separate historical room without prior visual answers; send its image to human, age it, save a lossy attributed checkpoint, invoke the provider's approved maintenance/replacement route and ask for historical retrieval with no new image, reply target, hidden attachment ID or replayed pixels. The provider must discover the ID with `read_conversation`. Capture actual route completion, distinct-session and clean-seed observations; selecting a route alone is insufficient. The automated provider PTY extension must retain each private whole-field assertion and correlated native delivery as sanitized booleans/hashes/identities. Manual inspection or controller success cannot substitute for these measurements.

5. Retain each required run before promotion in the agreed private custody, outside
   any checkout or publication branch. Keep fixtures, blobs, account data, private
   visual answers and full native/terminal transcripts out of source and review
   artifacts. Post only a sanitized result summary on the owning open issue, with
   its candidate SHA, build identity, command and outcomes. Never back-port records
   to closed tickets or copy them into the product tree. A failed or unknown result
   stays failed or unknown. After shutdown, remove disposable run state only once
   its required records have been retained. Identify private evidence by its run ID
   and SHA-256; the issue summary must not disclose private storage paths.

6. Promote only after all required browser/PTY paths and policy prerequisites pass, with the exact candidate source/build linked to the evidence. Assess any source/build change during promotion and rerun affected acceptance. If verification fails or remains incomplete, remove candidate-only mapping/build entries before shipping, keep the failed evidence, rerun `npm run check`, `npm test`, `npm run build`, and confirm ordinary product rejection. Review the final diff for candidate switches and pending enabling entries. Preserve published commits and branches. Unresolved reserved decisions return to Bill; there is no release or merge authority in this procedure.

## Foundation verification on 2026-09-15

The controller run (`image-support-controller-2026-09-15.json`, private historical record) passed independent initial and fresh-retrieval assertions on its recorded implementation patch. The first browser run (`image-support-browser-2026-09-15-failed.json`, private historical record) passed initial delivery and observed a clean checkpoint seed, then failed before the retrieval question. Its original catch did not retain the exact failure type; no diagnosis beyond those observations is claimed.

After adding step/session diagnostics, the second browser run (`image-support-browser-2026-09-15-unknown-build.json`, private historical record) observed `grok 1.0.30 (04b7ffed98c6) [stable]`. Both image paths were unavailable with explicit version reasons, before any image dispatch. The installed CLI had reported the accepted `1.0.13` at preflight and in the earlier initial/controller evidence. This work did not install a CLI or widen the accepted build. The cause of the intervening version change was not investigated.

At that point the mandatory browser regression was unsatisfied. These are interim implementation-patch results, not final-tree acceptance; subsequent guard/diagnostic/evidence edits require affected verification after setup is resolved. The authorized continuation below resolved setup without changing installed files or the support gate; the original failed records remain unchanged. Unknown builds remain unavailable.

### Task-local selection of the accepted Grok executable

For this verification run, Bill authorized selecting the already installed accepted download without changing the managed CLI symlinks, user configuration or production gate. The coordinator observed the managed symlink change at 2026-09-15 13:13:53 UTC, during the first failed browser run. The trigger is unknown; mixed versions during reconnect are possible but unproven. That run remains failed.

The accepted download is `$HOME/.grok/downloads/grok-1.0.13-macos-aarch64`, SHA-256 `8669e0fdadceec25b8c159c355f427ffbd82583525d774b6ab1522197ea83b80`. Its embedded update-suppression documentation supports `GROK_DISABLE_AUTOUPDATER=1` per process. The adapter removes inherited `GROK_*` values before stdio, so setting the variable only on `npx` is insufficient. The task-local wrapper below sets it immediately before every help, version and stdio invocation. Hash mismatch stops the invocation.

```sh
IMAGE_PIN=$(mktemp -d /private/tmp/image-grok-pin-XXXXXX)
cat > "$IMAGE_PIN/grok" <<'SH'
#!/bin/sh
set -eu
expected=8669e0fdadceec25b8c159c355f427ffbd82583525d774b6ab1522197ea83b80
actual=$(/usr/bin/shasum -a 256 "$HOME/.grok/downloads/grok-1.0.13-macos-aarch64")
[ "${actual%% *}" = "$expected" ] || { echo 'Pinned Grok executable hash changed' >&2; exit 1; }
exec env GROK_DISABLE_AUTOUPDATER=1 "$HOME/.grok/downloads/grok-1.0.13-macos-aarch64" "$@"
SH
chmod 700 "$IMAGE_PIN/grok"
"$IMAGE_PIN/grok" --version
# Must report grok 1.0.13 (5e9a58528b76) [stable]. Then, from the built source checkout:
PATH="$IMAGE_PIN:$PATH" npx tsx scripts/live-attachment-retrieval.ts --adapter grok --model provider-default --effort provider-default --room restricted --scratch-parent /private/tmp/image-support-runs
PATH="$IMAGE_PIN:$PATH" npx tsx scripts/live-browser-attachment.ts --adapter grok --model provider-default --effort provider-default --room restricted --scratch-parent /private/tmp/image-support-runs
# After both processes exit and sanitized evidence is retained:
rm -rf "$IMAGE_PIN"
```

This is a task-local process selection of an existing verified executable, not an installation, downgrade or product bypass. Do not change the managed symlinks, copy credentials, or accept another hash/version. The verification wrapper additionally logs only invocation kind, PID, expected executable hash and update-suppression setting. Preserve that log and its wrapper hash with the runtime record. The shared product gate must still accept the live tuple, and each actual provider session must report the accepted CLI/model before its evidence can count.

### Completed regression evidence

The controller (`image-support-controller-verified-2026-09-15.json`, private historical record) and browser (`image-support-browser-verified-2026-09-15.json`, private historical record) passed separate whole-field initial and fresh-retrieval visual assertions on the same recorded implementation patch. Every actual provider start reported the accepted `1.0.13` CLI and `grok-4.6`; the runtime record (`image-support-pinned-runtime-2026-09-15.json`, private historical record) records the hash-checked executable and update suppression for help/version/stdio. Permissions and command mode were off and skills disabled; observed effort is unknown, with provider default requested. Trusted/future-provider rows remain pending.

The first pinned browser attempt still failed (`image-support-browser-pinned-timeout-2026-09-15.json`, private historical record), despite all three provider starts using `1.0.13`. Its step diagnostic identified waiting for the `/reconnect` HTTP response. The existing browser API has a 12-second timeout and an idempotent "Check last action" recovery button. The script now responds to an aborted command by using that actual button, with the same operation ID and the original overall deadline. No timeout, product API, native transport or policy was changed. The final successful image run exercised one transport retry with the same command ID and recorded an actual distinct provider session and completed clean seed. A separate Playwright browser test holds fake reconnect completion until the retry request arrives, exercising the client timeout without a guessed server delay. It runs through `npm run test:web`, outside the browser-free `npm test` suite.

Both results correlate native content hashes with private visual assertions. Neither retrieval run replays initial pixels, embeds the hidden attachment ID in the question/seed, includes a prior visual answer, or attaches a new image. Evidence/source identities and the assessment of later evidence-only changes are in the completed summary (`image-support-foundation-verified-2026-09-15.json`, private historical record).

### Verification after review fixes

The review-fix runs (`image-support-review-fixes-2026-09-15.json`, private historical record) repeat both required scripts on clean commit `7a130e8c879e8659c29e5f55779948b9971d8227`. Both initial and fresh retrieval assertions passed. Policy is now recorded per provider session from the live adapter tuple and product-resolved command access; all observed sessions were restricted, skills off, command mode off and without a trust grant. The source patch hash is the SHA-256 of an empty patch. Later changes only add documentation and sanitized evidence. The full suite passes 426 tests, and the separate Playwright recovery test passes without contacting a provider.

## Claude native image mapping

Claude's registered bridge is `claude-mcp-image`. Its gate needs a connected
process whose observed native tool inventory has not failed; the room
configuration and the turn model decide nothing. The
recorded runs requested `opus` at `xhigh` and observed `claude-opus-5`; since
#105 those values are evidence, like the CLI identity has been since #85, and
the gate compares none of them. `2.1.268 (Claude Code)` is the identity the
first verification ran on, recorded in
Claude image evidence (`claude-images-2026-09-16.json`, private historical record), and every
entry below records another identity that was exercised. The report separately
checks initial delivery and retrieval. A disconnected process and a failed
inventory stay unavailable on any identity, model or effort, listed or unlisted;
a model without vision fails at delivery with the provider's error.

`2.1.274 (Claude Code)` is a second accepted entry, with the same requested and
observed tuple. The managed CLI moved to it on 2026-09-17 and the exact-build gate
closed every Claude image path. #57 reserved new Claude and Codex CLI versions to
the owner, and Bill accepted this build during the #57 run. That is an owner
decision, not something staging grants. The entry rests only on its own six runs (`claude-images-2026-09-17.json`, private historical record). They cover controller, browser and terminal in both rooms on one recorded source commit, each passing the first
image, a later image in the same provider session and fresh retrieval in a
distinct session. Each run re-asserts the two-copy retrieval replay and the then 8 MiB
frame bound, so this build re-measures the transport assumption and does not inherit it. No 2.1.268 evidence is reused, and that record is unchanged. The
versions between the two carry no evidence of their own; under #85 they are
decided by the same live requirements as any other identity. Add
`--evidence-issue 57` to the commands below to rerun that set. Those runs covered
two rooms: all task permissions off with skills off and command mode `off`, and
all permissions on with skills on and command mode `trusted`. Since local ticket
0001 they record coverage, not the only eligible rooms.

`2.1.276 (Claude Code)` is a third accepted entry on the same requested and
observed tuple. The managed CLI moved to it on 2026-09-18 and again closed every
Claude image path, including the #57 continuity reruns. Bill accepted this build
in the AI Chat room on 2026-09-18 as the same owner decision. The entry rests
only on its own six runs (`claude-images-2026-09-18.json`, private historical record), recorded on
one source commit with the candidate entry staged first, per the shared staging
procedure. No 2.1.268 or 2.1.274 evidence is reused, and neither record changes.
2.1.275 has no run set of its own; under #85 that
records missing coverage, not a closed path.

`2.1.277 (Claude Code)` is a fourth accepted entry on the same tuple. The managed
CLI moved to it later on 2026-09-18, before the 2.1.276 continuity rows could
run. Bill accepted this build in the AI Chat room on 2026-09-18 as the same
owner decision. The entry rests only on
its own six runs (`claude-images-2026-09-18-b.json`, private historical record), recorded on one
source commit with the candidate entry staged first. No earlier Claude evidence
is reused, and no earlier record changes. 2.1.278 and anything newer has no run
set of its own: since #85 such a build keeps the existing image paths when the
live requirements above pass, and gains no visual acceptance by doing so.

Images are available from connection, so the first message can carry one. The
native tool inventory is observed in each turn's init event, before the model
answers. A turn whose inventory lists an unexpected native tool is aborted, as
any turn is. An inventory that fails verification without an unexpected tool,
such as one missing `read_conversation`, re-registers the retrieval bridge as
unavailable at once; registration ends the turn's attachment authority, so no
`read_attachment` result is served for the rest of that turn, and initial images
stay closed until a later turn's inventory passes. A passing inventory changes
nothing: the bridge registered at connection keeps the authority the turn began
with. The turn model is recorded as evidence and a diagnostic only. There is no
automatic pixel retry and no candidate runtime switch.

Initial delivery uses native stream-json content arrays with a text prompt,
ordered message/attachment associations, and PNG `image` blocks with a base64
`source`. Only current required messages resolve bytes. Context, reply targets,
checkpoints and maintenance remain metadata/text only. The separate MCP process
uses the host's `claude-mcp-image` registration and current public-history
checks. It holds the typed result until the complete JSON-RPC response reaches
`StdioServerTransport.send`, then rechecks turn authority, integrity and size.
Serialization failure returns a bounded attachment error instead of leaving the
request pending. Ordinary tool results keep their existing text form.

The transport keeps a 256 KiB envelope allowance under the 64 MiB provider
reader bound. For a complete JSON request or response `J`, its conservative size
is the larger UTF-8 byte length of `J` and `JSON.stringify(J)`. Initial replay
reserves one such copy plus the allowance; retrieval reserves two copies plus
the allowance. The reader counts UTF-8 bytes.
The observed build replays initial content once and MCP image content twice.
The allowance covers the added replay fields and image-block representation;
unknown builds cannot reuse this assumption. Tests exercise full maximum-size
batches/results, enclosing request IDs, escaped text and multibyte prompts.
The normal per-image, per-message, aggregate and dimension limits remain intact.

The checkpoint-replacement attempt on this build returned an Opus safeguard
error, `reasoning_extraction`, during seeding. It is retained as failed evidence;
no compaction gate, maintenance prompt or permission was changed. The successful
verification route is the issue's permitted disposable saved-room fresh start:
send an older image to human through the product, age it beyond the bounded
initial prompt, save/load a lossy checkpoint, close the room, remove only the
fixture's saved provider ID, and reopen it through the product. The first text
turn is the observed bounded clean seed. Its outgoing prompt must contain
neither the hidden ID nor the private answer, and it must deliver no images.
The subsequent query discovers the ID with `read_conversation` and receives
pixels with `read_attachment` in that same distinct new provider session.
This verifies neither native compaction nor successful checkpoint replacement.

Rerun on the built implementation tree after the shared staging procedure:

```sh
npm run build
npx tsx scripts/live-attachment-retrieval.ts --adapter claude --model opus --effort xhigh --room restricted --fresh-route saved-room
npx tsx scripts/live-attachment-retrieval.ts --adapter claude --model opus --effort xhigh --room trusted --trusted-commands --fresh-route saved-room
npx tsx scripts/live-browser-attachment.ts --adapter claude --model opus --effort xhigh --room restricted --fresh-route saved-room
npx tsx scripts/live-browser-attachment.ts --adapter claude --model opus --effort xhigh --room trusted --trusted-commands --fresh-route saved-room
python3 scripts/claude-terminal-images.py --room restricted --output /private/tmp/claude-pty-restricted.json
python3 scripts/claude-terminal-images.py --room trusted --trusted-commands --output /private/tmp/claude-pty-trusted.json
```

Both TypeScript scripts use the ordinary adapter factory and product dispatch;
the browser script pastes and uploads through the served authenticated UI.
Controller runs remain a separate evidence category. The Python extension uses
raw-mode PTYs and actual `dist/cli.js`, including Ctrl+O attachment staging,
send, saved-room startup and retrieval. Its observation preload changes no
provider content or authorization. It records native request/replay hashes,
sizes, session/model observations and MCP discovery/results. Terminal text,
private fixture controls and answers are discarded. Available native effort
acknowledgement is recorded separately; absence stays `unknown` even when the
launch requested `xhigh`.

## Grok 1.0.30 image coverage

Issue #56 verifies `grok 1.0.30 (04b7ffed98c6) [stable]`, provider-default model
request and native `session/new` observed model `grok-4.6`. The
Grok evidence record (`grok-images-2026-09-16.json`, private historical record) links browser,
controller and real CLI PTY results. Initial delivery and historical retrieval
remain separately reported. When #56 landed, unknown builds were unavailable.
[Issue #69](#grok-observed-runtime-contract-and-1034-coverage-issue-69) later
replaced that exact-build gate; this section stays as the record of what ran on
1.0.30. Since local ticket 0001 a current build is eligible in every room
configuration; the rooms below are the coverage that ran. The existing 1.0.13
restricted entry remains accepted and restricted.

| Required room    | Effective policy                                                    | Effort                                            |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| Restricted       | Edits/commands/network false, host skills off, command mode off     | No explicit request; native session selected high |
| Trusted coverage | Edits/commands/network true, host skills on, command mode sandboxed | Requested high; native session selected high      |

There is no trust grant or launch override in the two #56 rooms. The trusted-room name
comes from the issue's required coverage and does not mean trusted command mode.
These #56 runs are sandboxed-command evidence only. Trusted command mode changes
room instructions and the `run_command` execution path, so they say nothing about
command mode `trusted`. No trusted-command run exists on 1.0.30;
[issue #69](#grok-observed-runtime-contract-and-1034-coverage-issue-69) ran that
room on 1.0.34. Mixed permission/skill configurations have no accepted image
evidence and stay unavailable. Effort is not an image gate: a request, supported-efforts
list and native selected value remain separate facts. `imageEvidence` records
`configOptions[reasoning_effort].currentValue` when present, otherwise `unknown`.
It binds that observation and `models.currentModelId` to the actual ACP session.

Before staging the candidate, both native startups passed the existing isolated
home/workspace, denied filesystem/terminal capability, profile and effective
native/MCP inventory checks. Native skill discovery, `image_gen` and other native
task tools remain disabled. The host ToolService receives the actual permissions,
sandboxed command policy and discovered skill bundles. Enabling host permissions
therefore did not require restoring a native tool. Focused checks cover denied
native permission requests and unexpected inventory under both room profiles;
real MCP lifecycle tests cover revocation with the new build and host permissions
on. At the time of these runs native compaction was pinned to 1.0.13 and false
on 1.0.30; since #105 the route is selected after every successful start.

The first/later image assertions require one ACP request containing exactly the
new PNG and its ordered message/attachment association. Evidence ties each request
to its send operation and provider session. Historical retrieval uses a separate
saved room with no previous visual answers, an older human-addressed image, and
a schema-valid lossy checkpoint. Product `/reconnect @grok` creates a distinct
ACP session and completes a bounded clean seed. Reconnect leaves the agent on
hold, so the verified route runs `/continue @grok` before the question. The model
must discover the hidden attachment through public `read_conversation`, then
receive an authorized MCP image result from `read_attachment`. No new attachment,
reply target, seed/inline attachment ID, prior answer or automatic pixel replay
can satisfy that assertion.

Use the shared staging procedure above. This run fixed the existing installed
1.0.30 executable with a task-local PATH wrapper, suppressing its updater at
every invocation, including after the adapter's native environment scrub. The
installed links, binaries, login and user configuration were unchanged. Exact
runtime identity and executable SHA-256 are in the evidence. On this host:

```sh
GROK_RUN=$(mktemp -d /private/tmp/grok-image-rerun-XXXXXX)
mkdir "$GROK_RUN/bin"
cat > "$GROK_RUN/bin/grok" <<'EOF'
#!/bin/sh
export GROK_DISABLE_AUTOUPDATER=1
exec "$HOME/.grok/downloads/grok-1.0.30-macos-aarch64" "$@"
EOF
chmod +x "$GROK_RUN/bin/grok"
export PATH="$GROK_RUN/bin:$PATH"
grok --version
shasum -a 256 "$HOME/.grok/downloads/grok-1.0.30-macos-aarch64"
npm run build
npx tsx scripts/live-attachment-retrieval.ts --adapter grok --model provider-default --effort provider-default --room restricted
npx tsx scripts/live-attachment-retrieval.ts --adapter grok --model provider-default --effort high --room trusted
npx tsx scripts/live-browser-attachment.ts --adapter grok --model provider-default --effort provider-default --room restricted
npx tsx scripts/live-browser-attachment.ts --adapter grok --model provider-default --effort high --room trusted
python3 scripts/grok-terminal-images.py --room restricted --output "$GROK_RUN/pty-restricted.json"
python3 scripts/grok-terminal-images.py --room trusted --output "$GROK_RUN/pty-trusted.json"
```

Expected executable hash: `d53b6e543e482716236748914331db50145c696ac7af91f1ebdedcf5654cfecb`. A different build/hash requires
new staging evidence; it cannot inherit these results. The wrapper path is local
to verification and is not a product switch. The PTY preload observes the built
CLI without changing provider requests, responses, mappings or permissions.
Retained records contain identities, hashes and assertion outcomes, with no image
bytes, private answers, host skill contents or full native transcripts.

## Grok observed runtime contract and 1.0.34 coverage (issue #69)

Bill amended #69 on 2026-09-17, after the managed Grok CLI advanced from 1.0.30
to 1.0.34 and the exact-build gate turned every room unavailable. The CLI version
is now evidence and a bounded diagnostic. It is not a runtime eligibility gate.

### What the gate reads

`GrokImageTuple.roomContract` is a host-derived observation. `GrokAdapter.start()`
creates it with every check false and sets each one only after that step passed
on the live native process:

| Check                       | Set after                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `isolatedRuntime`           | The native process was launched with the host-created `HOME` and `GROK_HOME`, outside the user home and the room workspace |
| `acpInitialized`            | The ACP `initialize` request returned                                                                                      |
| `subscriptionAuthenticated` | `authenticate` with the cached token reported `Oidc`                                                                       |
| `roomMcpInventory`          | `_x.ai/mcp/list` reported exactly one `chittr` server, ready, with exactly the room tool set                               |
| `processLive`               | The native process was still open when the tuple was taken                                                                 |

The tuple also carries the existing observations: `nativeInventoryVerified` for
the exact native tool inventory, the requested and observed model, and the
effective permissions, skills and command mode. `grokInitialImageGate` accepts
only a complete contract with policy `isolated-rooms-v1`, a verified native
inventory and an observed session model. When #69 landed it also required the
provider-default request, observed `grok-4.6` and one of three rooms
(restricted; all permissions with skills on and sandboxed commands; the same with
trusted commands). #105 removed the model conditions, and local ticket 0001
removed the room condition: room permissions, skills and command mode do not
change image delivery, so a current build is eligible in every room
configuration and the policy is recorded as evidence.

A missing contract, an unknown policy name, an unobserved check, inventory or
model reports `not_observed`. A check that is false or a failed inventory
reports `unsupported`. Unobserved and failed checks
are collected separately, so a failed check decides the status and both are named.
Both statuses close the initial and retrieval paths. The contract is never read from room or
user configuration, and the adapter throws and closes on any failed start step, so
a tuple only exists after every check passed. `imageSupport()` also reports
unavailable whenever the native process is closed, which covers interruption and
a later inventory revocation.

The reason lists every failed observed field. On the current path it ends with
`live CLI <identity>` as a diagnostic. It never says a version is unaccepted. The identity must still be
readable: a version string that is missing or not of the form
`grok X.Y.Z (build) [stable]` reports `not_observed`, because the identity is
required evidence and an unreadable one cannot be told apart from the legacy build.

### What did not change

- `grok 1.0.13 (5e9a58528b76) [stable]` keeps its restriction exactly: permissions
  off, skills off, command mode off. `legacyRestrictedGrokBuild` is the only
  version-keyed branch, and it only restricts. An observed contract does not widen it.
- Native compaction stayed pinned to a separate constant at the time. #105
  removed that pin: the route is selected after every successful start and
  validated on the actual operation, and the legacy restriction is unchanged.
- The gate reads nothing about trust on a current build, and only the legacy
  restriction reads the effective command mode. `GrokImageTuple` has no
  trust-source field. User-level `trustedCommands.workspaces` and
  `--trusted-commands` both resolve to `trusted`.
  `imageEvidence.commandModeSource` records which one applied.
- Effort is test configuration, not a gate input.
- Native filesystem and terminal capabilities, `image_gen` and native skill
  discovery stay denied in every room. An unexpected native inventory fails Grok
  start with its policy error. Record that as a failed run. Do not relax the
  inventory check or add a text-only fallback to get a pass.
- `testedImageBuilds` stays an immutable evidence record. #56's 1.0.30 entry and
  records are unchanged. The 1.0.34 runs are a separate entry.

`test/image-support.test.ts` covers arbitrary well-formed identities, every
missing, unknown and failed observation, every room configuration, the reason
text and the legacy restriction. `test/providers.test.ts` covers the same through
`GrokAdapter` on a fake native process, for both trust sources, and
`test/trusted-commands.test.ts` covers both sources against a synthetic home.
None of them launches Grok or reads a real user config.

### Live matrix on the installed 1.0.34 CLI

**Status: accepted.** All nine runs passed on 2026-09-17 against
`grok 1.0.34 (3736acbc8658) [stable]`, executable sha256
`9cd26b579840f0f5c9148a8059ad651904c08b41b7f2ef0b4ec04b9ba898844e`, identical
before and after the matrix. The issue-69 evidence record (`grok-images-2026-09-17.json`, private historical record)
links each sanitized run with its sha256, command, source commit and observed
identity. Every run used source `d3d33cade4d3948bf1fcda16a324601252e7ee91` with an
empty patch.

| Room             | Effective policy                                                    | Effort                                            | Controller / browser / PTY |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------- | -------------------------- |
| Restricted       | Edits/commands/network false, host skills off, command mode off     | No explicit request; native session selected high | Passed / passed / passed   |
| Sandboxed        | Edits/commands/network true, host skills on, command mode sandboxed | Requested high; native session selected high      | Passed / passed / passed   |
| Trusted commands | Edits/commands/network true, host skills on, command mode trusted   | Requested high; native session selected high      | Passed / passed / passed   |

Each run passed the first image, a later image in the same provider session and
fresh historical retrieval in a distinct provider session, with native delivery
correlated by content hash. Every native startup reported all five contract
checks true, a verified native inventory and observed `grok-4.6`. The trusted rows
record command mode `trusted` from `--trusted-commands`; the other rows record
`permissions.commands`. Native compaction is false on this build. This is evidence
for 1.0.34 only. It says nothing about 1.0.30, whose trusted-command room was
never run, and #56's records are unchanged.

Promotion assessment: later commits add only the retained records, the curated
record, the `testedImageBuilds` evidence entry and documentation. That entry is
not a gate input, so no run is affected by adding it.

The matrix ran against the managed CLI as installed on the host, with no
downgrade, no pinned copy and no PATH wrapper. To rerun it, record `grok --version` and the
executable's sha256 before and after the matrix. The adapter disables the updater
inside its isolated Grok home; if the managed CLI still changes identity during
the matrix, each run's own record says which build it used.

The live harnesses run in disposable workspaces, which a user-level grant can
never match, so the trusted row gets its grant from `--trusted-commands` only. The
PTY driver launches the real `dist/cli.js` with the host environment, so ordinary
config loading still reads the user-level `~/.agents/chittr.yaml`. A malformed
user config stops that run before it starts. No run modifies the user config or
depends on a persistent workspace grant in it.

```sh
npm run build
grok --version
shasum -a 256 "$(readlink -f "$(command -v grok)")"
RUNS=/private/tmp/image-support-runs; mkdir -p "$RUNS"
for entry in live-attachment-retrieval live-browser-attachment; do
  npx tsx scripts/$entry.ts --adapter grok --model provider-default --effort provider-default --room restricted --scratch-parent "$RUNS"
  npx tsx scripts/$entry.ts --adapter grok --model provider-default --effort high --room trusted --scratch-parent "$RUNS"
  npx tsx scripts/$entry.ts --adapter grok --model provider-default --effort high --room trusted --trusted-commands --scratch-parent "$RUNS"
done
python3 scripts/grok-terminal-images.py --room restricted --output "$RUNS/pty-restricted.json"
python3 scripts/grok-terminal-images.py --room trusted --output "$RUNS/pty-sandboxed.json"
python3 scripts/grok-terminal-images.py --room trusted --trusted-commands --output "$RUNS/pty-trusted-commands.json"
```

Each TypeScript script prints its scratch `evidence.json`. Only the PTY driver
takes `--output`, and it fails a run whose observed command mode or source differs
from the requested room. Each entry point covers the first image, a later image
in the same provider session, and fresh historical retrieval. Controller evidence
does not satisfy browser or terminal acceptance.

## Codex native image mapping

Codex's registered bridge is `codex-dynamic-image`. Its gate needs the native
policy checks that startup enforces and a native session that reported its model
and effort, on a fresh or a resumed thread, in any room configuration. The recorded runs requested and observed `gpt-6-astra` at
`xhigh`; since #105 those values are evidence, like the CLI identity has been
since #85, and the gate compares none of them, so the reported
`gpt-6-astra` at `high` case is eligible when the same checks pass.
`codex-cli 0.154.0` is the identity the verification ran on. The
verification record (`codex-images-2026-09-16.md`, private historical record) links separate browser,
controller and built-CLI PTY first-image, later-image and historical-retrieval
results in both required rooms. Initial and retrieval reports remain separate.

The recorded runs used two rooms. Restricted rooms have edits, commands and
network off, skills off and command mode `off`. Trusted rooms have all
permissions on, skills on and command mode `trusted`, granted by
`--trusted-commands` in these runs. Native filesystem, network and tool
restrictions stay the same in both configurations, which is why room policy no
longer decides image eligibility.

The user approved #51's revised acceptance criterion on 2026-09-16: zero selected
environments and zero projected roots, with separate checks of direct workspace
read, no write grants, network denial, named-profile selection, approval routing
and disabled native features. Cold resume succeeds but returns one environment
and one root in both rooms. The user at first approved fresh-thread-only support,
and [issue #63](https://github.com/mcgloneb/ai-chat/issues/63) held resumed
images. Bill approved images on resumed threads for chittr/chittr in local ticket
0001: the environment and root counts are now recorded as evidence, and image
eligibility uses the same native policy result that admits the thread at
startup. A thread whose other policy observations fail still never starts.
Whether a resumed thread's environment is acceptable as a session-level policy
question remains open. Images are never retried automatically.

Initial delivery resolves only the current required messages and sends ordered
association text plus native `image.url` items. Context, seeds, checkpoints and
reply references do not replay older pixels. Historical retrieval uses the host's
`codex-dynamic-image` registration and private typed results, unwrapped only at
the in-process JSON-RPC response boundary as `inputImage.imageUrl`. Ordinary
`inputText` tool results remain unchanged. Revocation and complete-frame checks
run after serialization and immediately before the transport write.

The transport keeps 256 KiB of headroom under the 64 MiB provider reader bound.
It measures both the full wire JSON and its escaped replay in UTF-8 bytes, the
unit the reader bounds. The tested build
replays one initial/result copy per observed event; that observation belongs to
that build's runs. The bound itself does not rest on it: `assertCodexFrame` and
`assertClaudeFrame` measure every frame at runtime, on any identity, so an
unlisted build is held to the same limit while inheriting none of that build's
visual coverage.

Fresh historical retrieval in those runs used actual `/compact @codex` through
the host checkpoint-replacement route, because `nativeCompaction` was false on
the tested build. It created a new provider thread with a bounded byte-free
seed, then discovered the older attachment through public history and retrieved
its pixels. This is not native compaction acceptance, and `/reconnect` alone is
not a fresh-session route. Since #105 Codex selects native compaction on every
build, so `/compact` no longer opens a fresh thread; a rerun uses
`--fresh-route saved-room`, which reopens the saved room without its provider
reference and seeds the checkpoint into a fresh thread, as the Claude runs do.
The record (`codex-images-2026-09-16.md#rerun`, private historical record) contains the six
original rerun commands and the cold-resume rejection checks.

## Newer-CLI eligibility live record (issue #105)

Historical record, dated 2026-09-24. Its room configurations, fresh-thread rule
and first-text-turn requirement were the rules then; [the product
contract](#product-contract) states the current ones.

#105 removed every model/effort tuple comparison from the image gates and every
exact CLI pin from startup and maintenance. The bounded live evidence, recorded
on 2026-09-24 in
[newer-cli-eligibility-2026-09-24.json](evidence/newer-cli-eligibility-2026-09-24.json),
was taken on the installed CLIs of the pilot host without installing, downgrading
or reconfiguring any of them: Codex 0.156.1, Claude Code 2.1.274 and Grok Build
1.0.34. None of those builds has a catalog row, and none was added.

- The reported case, Codex `gpt-6-astra` at `high` on 0.156.1 in the restricted
  room, passed the first image, a later image in the same thread and a fresh
  historical retrieval in a distinct thread through the
  [controller](evidence/codex-images-0.156.1-astra-high-2026-09-24.json), the
  [browser on the installed Chrome](evidence/codex-images-browser-astra-high-2026-09-24.json)
  and, with the script's fixed `gpt-6-astra` at `xhigh` request, the
  [built-CLI PTY](evidence/codex-images-pty-restricted-2026-09-24.json), which
  also re-confirmed that a resumed thread refuses images. The native session
  observed `gpt-6-astra` at the requested effort each time. The controller and
  browser runs used `--fresh-route saved-room`, and the PTY script now takes
  that route, since `/compact` runs natively. A first controller attempt on the
  same source failed at startup with the `default_permissions` configuration
  error that 0.156.1 raises; the adapter now names its restricted profile as
  the default, as [compatibility](compatibility.md#provider-behavior) describes.
- Claude Code 2.1.274 with `opus` at `high`, outside the historical `xhigh`
  tuple, passed the same three phases through the
  [controller script](evidence/claude-images-opus-high-2026-09-24.json) and
  the [browser](evidence/claude-images-browser-opus-high-2026-09-24.json) on
  the saved-room route, and with the script's fixed `opus` at `xhigh` through
  the [built-CLI PTY](evidence/claude-images-pty-restricted-2026-09-24.json),
  launched without `--disable-slash-commands`.
- Grok 1.0.34 with an explicit `grok-4.6` request, previously a mismatch,
  passed the three phases through the
  [controller script](evidence/grok-images-explicit-model-2026-09-24.json) and
  the [browser](evidence/grok-images-browser-explicit-model-2026-09-24.json);
  the native session resolved the request to `grok-4.7`, a model no record
  names, and the gate reported it as evidence only. The
  [built-CLI PTY](evidence/grok-images-pty-restricted-2026-09-24.json) passed
  with the script's provider-default request.
- Codex 0.156.1 native compaction completed three cycles with the correlated
  `contextCompaction` item and turn completion each time, and Codex replacement
  completed three cycles whose seeds each carried an available continuation note
  from the source thread.
- Grok 1.0.34 native compaction completed three cycles through
  `_x.ai/compact_conversation`. Its first attempt failed at the existing
  inventory check before any native operation and passed on retry.
- Claude Code 2.1.274, launched by the product adapter without
  `--disable-slash-commands`: in one live process, two disposable project
  skills with shell snippets (one forked) were not installed and did not run,
  `/fork`, `/bash` and `/skills` were unavailable, `/agents` had no wizard, no
  marker file was created, the live inventory held only `StructuredOutput` and
  the room MCP tools, and the product `/compact` route then completed on that
  same process with one manual `compact_boundary` carrying its UUID and
  pre/post token counts and a result correlated to the outgoing user UUID;
  the next ordinary turn on that process recalled a token given before the
  compaction. The compaction script's own three-cycle run did not complete on
  this build: its seed step met the documented Anthropic safeguard refusal.
- Codex 0.156.1 and Grok 1.0.34 continuation: after each script's three
  native cycles, the next ordinary turn restated both release markers and
  reported the room-tool denial of `/etc/hosts`, as the script requires.
- Antigravity was not exercised: `agy` is not installed on this host. The
  startup enforcement probe, which asks the selected profile for one native
  write on a host-named file and admits the session only when the hook
  recorded exactly that denial and nothing appeared in the scratch directory,
  is covered by deterministic tests only; the Antigravity startup criterion of
  #105 remains open until a live CLI runs it.
- Not exercised: Claude continuation through the compaction script (its seed
  step meets the upstream safeguard refusal; the same-process probe above
  covers continuation instead) and the trusted rooms. The historical records
  for those paths predate this change and do not verify it.

Those runs are coverage of what they exercised, like every other record here.
They do not make a build or model visually verified for any other room, entry
point or provider, and they add no eligibility condition.

## Integrated acceptance (issue #57)

Historical record, dated 2026-09-18. Its rooms, its resumed-Codex refusal and its
first-text-turn requirement describe that release; [the product
contract](#product-contract) states the current rules.

**Status: closed on 2026-09-18 with two rows failed upstream.** The
matrix record (`integrated-images-2026-09-17.json`, private historical record) lists all 46 inventory
rows with a status, the run that backs each passed row, and the exact command for
every row. Forty of the 42 in-release rows passed. Claude actual compaction and
Claude host-restart retrieval failed, and their 2026-09-18 reruns on the merged
head with Claude Code 2.1.277 were blocked by an upstream safeguard refusal,
category `reasoning_extraction`, twice, once with realistic human-only filler.
Bill closed #57 on that basis. Those two rows are a documented limitation of the
release, not open work: Claude checkpoint replacement and post-restart historical
retrieval are outside the verified coverage. The matrix record's own status field
still reads `incomplete`, because the record was not rewritten after that decision. The
four mixed-recipient rows are
`out-of-release` after Bill extracted Antigravity images from #46; they are not
passes, failures or part of the completion bar. The archive-specific validator and its archive-reading test were retired with
the historical evidence cleanup. These rules describe the dated #57 matrix;
new release acceptance must record its own observations on the owning open issue. Every
inventory row appears once. Hashed, sanitized, #57-stamped evidence backs each
pass, and it must describe that row's provider, room, entry point and scenario.
Only a provider script's record can close an image-path row: the later image must
share the first image's provider session, and fresh retrieval needs a distinct
session, a clean seed and history discovery before the attachment request. The
record's status field stays `incomplete` while either in-release row is unproved;
the owner's closing decision is recorded above and in the #58 candidate record.

| Rows                                                         | Count | Status                                                                                          |
| ------------------------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------- |
| First image, later image, fresh retrieval, per provider      | 36    | 36 passed                                                                                       |
| Actual compaction and orderly host restart, one per provider | 6     | 4 passed; Claude compaction and Claude restart retrieval failed, then blocked upstream on rerun |
| Mixed recipients, browser and PTY in both rooms              | 4     | Out of release after Antigravity image support was extracted from #46; excluded from completion |

The first 20 passes record source `eb4b07b52c2c65e4671b21e773d52c81f410c0f8`
with an empty patch. They remain applicable because `src/` and `web/` are
byte-identical at the post-PR-74 head `207e242b6909956fd7a1d388bcfd724d3bf2735e`.
Twenty more rows passed on clean `207e242` evidence. The final Claude restart
failure records a one-file harness patch that skips a duplicate readiness turn
after the same resumed session was already prepared; product `src/` and `web/`
did not change. The matrix records the clean and patched source identities.
The #58 candidate refresh of 2026-09-18 pins this matrix's hash and
`comparisonWithIssue57.recordedBuild` at `207e242`, and states per row group why
each retained row still applies to the refreshed candidate.

On 2026-09-18, after PR 79 accepted Claude Code 2.1.277, both failed Claude rows
were rerun from the merged head `a9ca1d44326e6e98e3226f2c88e121083195462e` with
`DISABLE_AUTOUPDATER=1`. Both failed again at the same phase, and this time the
Claude Code transcript for each run records a `model_refusal_no_fallback` event,
category `reasoning_extraction`, on `claude-opus-5`, within a minute of the
request: for compaction, on the checkpoint-replacement seed request in the new
session; for restart, on the post-restart older-image retrieval turn. The harness
still waited out its 900 and 600 second phase timeouts, so the PR 77 fail-fast did
not reach its phase gate. The two records are retained with the `-failed-2026-09-18`
suffix, the rows stay `failed` with the safeguard recorded as the reason, and the
matrix stays `incomplete`. Transcripts live under the Claude Code project
directory for each run's scratch workspace and are not retained. Whether to keep
pursuing these rows on Claude, or to accept #57 without them, is the owner's call.

Later on 2026-09-18 both rows were rerun once more, still on Claude Code 2.1.277
with `DISABLE_AUTOUPDATER=1`, after two harness-only changes in
`scripts/integrated-terminal-images.py`: the human-only filler became three
ordinary sentences instead of sixty copies of "No pending task.", and the
continuity waits now read a `failed` or `cancelled` maintenance status, or a
failed turn, from the saved session and stop with the product's own error text.
Product `src/` and `web/` did not change. Both rows refused again, category
`reasoning_extraction`, at the same phases, and the product recorded the refusal
itself: compaction ended after 39 seconds with maintenance status `failed`, and
restart ended after 13 seconds with `claude` marked unavailable. The records are
retained with the `-harness-filler-failed-2026-09-18` suffix, both rows stay
`failed`, and the matrix stays `incomplete`. The refusal is therefore not
explained by repetitive synthetic filler, and the previous observation that the
PR 77 fail-fast did not reach the harness phase gate is resolved.

### What the scenarios prove

The provider rows reuse the provider tickets' scripts unchanged. `--evidence-issue 57`
is the only way a run is stamped as #57's; the default stamps are unchanged and no
other ticket can be named.

**Mixed recipients.** These four rows are retained as inventory only and are out
of release. The earlier restricted runs still record independent Codex, Claude
and Grok visual and native outcomes, but they do not close an in-release row and
the trusted mixed commands were not run. Unit coverage in #43 and #68 owns the
unsupported-recipient behavior for this release.

**Actual compaction.** `/compact @agent` runs real product maintenance. No
checkpoint is fixtured. The passing Codex and Grok records took the replacement
route, and the record says so. The older image is
addressed to human only, so its pixels and answer have never reached the provider;
the scenario first confirms no native result for it exists. Evidence records the
route, previous and new provider sessions, checkpoint version before and after,
whether summarization ran and in which summarizer sessions, and whether the new
checkpoint entries reference the older attachment. Public metadata and the stored
blob are compared before and after. Retrieval must arrive with a fresh authorized native image result in the new session, the seed may carry no pixels and no still-private answer, and a newly sent image must then pass. Reading history first is recorded but not required here. A real checkpoint may name the older attachment, and one Codex run retrieved it directly. The fresh-retrieval rows are the discovery-first proof.

**Orderly host restart.** The idle `dist/cli.js` host is closed with Ctrl+D, the
product's own shutdown path. The row requires exit code 0, the workspace lock held
by the old PID and then gone, and a new PID reacquiring it. A host that had to be
terminated is a killed host and fails the row. Effective policy and build must be
unchanged. The scenario records whether the provider resumed or received a recovery
replacement. A resumed Codex session refuses images, which #63 tracks. When that happens the scenario records the refusal and takes the supported `/compact` route by name. It forces nothing.

### Out of release: Antigravity mixed rows

The installed `agy` was 1.2.5 and the adapter at the time admitted only its
verified 1.1.27. That was expected. Antigravity image support now belongs to
later work under #54 and #55, so #57 does not require a connected Antigravity
recipient or a live mixed refusal. No 1.1.27 build was installed and no version
gate was widened. Since #105 the adapter admits any version whose startup
enforcement probe observes the selected profile invoking the room policy hook;
that probe has not been exercised live and Antigravity images stay unsupported.

### Rerun

Build first, stage any new file, and run from the repository root. The TypeScript
harnesses refuse an untracked tree so the patch identity covers every file.

```sh
npm ci --ignore-scripts && npm run build
python3 scripts/integrated-terminal-images.py --scenario compaction --provider claude --room restricted --output "$TMPDIR/integrated-compaction-claude-restricted.json"
python3 scripts/integrated-terminal-images.py --scenario restart --provider claude --room restricted --output "$TMPDIR/integrated-restart-claude-restricted.json"
npx tsx scripts/evidence-sanitization.ts "$TMPDIR/integrated-compaction-claude-restricted.json"
npx tsx scripts/evidence-sanitization.ts "$TMPDIR/integrated-restart-claude-restricted.json"
```

The trusted room is command mode `trusted` from `--trusted-commands` for every
provider, which is Grok's #69 trusted row. There is no sandboxed mixed room.
The matrix retains the commands for all 46 inventory rows. Do not rerun the four
out-of-release mixed commands for this release. `--provider` takes `codex`,
`claude` or `grok`. Every continuity scenario writes a record
whether it passes or not, and withholds the record entirely if it would hold a
private answer, a scratch path or image bytes.
`scripts/evidence-sanitization.ts` checks any retained record for image bytes, data URLs, long base64 runs, serialized Buffers and byte arrays, unspaced color-list answers, private host paths, credentials, transcript turns and transcript-sized text, in JSON, JSONL or plain text. It never echoes what it matched.
