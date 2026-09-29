# Chittr

A local conversation with you, Codex, Claude Code and Grok Build as named peers,
in your terminal or browser. Choose your participants. Agents can inspect the
launch directory, ask each other questions, contribute concurrently or pass.
Each participant has its own visible activity and queue.

This is an early hobby-project preview for macOS on Apple Silicon. It uses
installed provider CLIs with subscription logins for Codex, Claude Code and Grok Build.
API-key authentication is not supported. Gemini/Antigravity is outside this launch's support scope.
Read [privacy and permissions](PRIVACY.md) before sharing files or enabling tools.
Chittr is [MIT licensed](LICENSE); bundled libraries retain their
[third-party notices](THIRD_PARTY_NOTICES.md).

## Install

Install Node.js and at least one of the provider CLIs below, then sign in with
that CLI. Chittr does not bundle provider CLIs or ask for their credentials.

| YAML provider | Executable | Setup and login                                                                                              |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `codex`       | `codex`    | [Codex CLI](https://developers.openai.com/codex/cli/), then `codex login` with ChatGPT                       |
| `claude`      | `claude`   | [Claude Code](https://code.claude.com/docs/en/overview), then `claude auth login` with a Claude subscription |
| `grok`        | `grok`     | [Grok Build](https://docs.x.ai/build/overview), signed in with your subscription                             |

```sh
npm install -g @chittr/cli
chittr --version
cd /absolute/path/to/your/project
chittr
```

The first-preview rehearsal passed on Apple Silicon, macOS 26.2, Node 24.18.0
and npm 11.16.0, using Codex CLI 0.159.0, Claude Code 2.1.284 and Grok Build
1.0.34 with provider-default models.
The declared Node minimum is 22.12.0; other macOS/Node combinations, Intel,
Linux and WSL2 are untested for this release. The full Quality suite is skipped
for this preview. See [installation and recovery](docs/installation.md) for
setup, permissions, backup, reinstall and rollback.

When no config exists, interactive setup offers to create `~/.agents/chittr.yaml`. It detects installed CLIs and requires you to choose which to enable. Choose Codex, Claude or Grok for this preview; leave Antigravity unselected if it appears. Nothing is selected automatically. Setup saves your choices under `defaultAgents`, with no model overrides or stock custom instructions, and starts with discussion and file inspection only. No personal config ships with the app. After setup, `chittr doctor` checks the configured supported providers and the tool sandbox without a chat turn. It does not prove that a model can answer or that its terms permit your use. Chat responses and the optional live tests use your normal subscription allowance.

Launch in the exact directory agents should inspect. For example, launching in `~/Projects/your-project` gives the room that workspace. Launching in a nested directory gives it only that nested directory. The app does not search upward for a Git root or project config.

`chittr` always starts a new chat and preserves previous conversations. Run `chittr resume` to browse saved chats from this exact directory, most recently updated first. Use ↑/↓ to select, Enter to resume, or Escape to cancel. Type to search conversation previews or session IDs; PgUp/PgDn and Home/End navigate longer lists. `chittr resume ID` opens a specific saved chat directly.

## Browser interface

```sh
cd ~/Projects/your-project
chittr --web
```

This starts a new chat, runs a local server, and opens your default browser. If opening the browser fails, use the link printed in the terminal. The browser uses the same workspace, merged YAML, CLI subscriptions, permissions, and saved sessions as terminal chat. `chittr resume --web` selects a saved chat in the terminal before opening it in the browser; `chittr resume ID --web` opens it directly. `--state-dir PATH` also works with `--web`. First-time configuration still uses the terminal setup prompt.

The browser provides a shared transcript, Markdown and code blocks, message/code copy buttons, live agent status, and a fixed composer. Normal selection and copy/paste work. Enter sends; Shift+Enter, Ctrl+Enter, or Ctrl+J insert a newline. Leading `@names` autocomplete as you type. Tab completes names, slash commands, and workspace file references. Incoming replies preserve the draft and history position; **Jump to latest** resumes following the conversation.

In either composer, Up recalls your latest sent message, then moves through older messages. Down moves through newer messages and returns to your unsent draft. Down on an empty draft does nothing, and history does not wrap. While editing a multiline draft, Up moves through its lines before recalling history at the top. Open completion menus keep their arrow-key controls.

Click **Reply** on a message to quote it above the composer, then type and send. Your existing draft stays in place. **Cancel reply** or Escape removes the reply target without discarding your text. The target stays with your draft across refresh and saved-session resume. Sent replies link back to the original message.

Use the room buttons to pause, stop, continue, or quit. Each agent's `···` button opens its individual controls. Failed and interrupted deliveries have retry buttons; capped exchanges offer additional follow-up turns. All existing slash commands also work. The sidebar opens saved conversations and effective configuration. Configuration changes still require YAML edits and an idle reload. Restored sessions start active; queued messages run as agents connect, while failed and interrupted deliveries still require an explicit retry.

Paste, drop, or select PNG images with **Attach images**. The host accepts up to four images, 1 MiB each and 3 MiB total. Pending uploads show filenames; accepted images show previews. Remove or retry failed uploads before sending. Captions are optional, including replies. Leading `@names` still select recipients. When a PNG is staged, the browser and terminal show the current `not_observed` or `unsupported` status for resolved recipients before send. The warning does not block sending or predict whether a message will be attempted or queued. Previews confirm storage, while the delivery status reports whether a provider could receive the images.

Staged and sent images are saved as host references. Reload or reopen the current browser link to restore them; after restarting the host, open its new link to authenticate image reads. **View image** opens a larger view, and Escape closes it. **Check last action** retries an unknown attachment-send result using its saved identity, including after restart. An interrupted upload can be retried with the same file; the browser retains its operation identity but does not save the image bytes. See [image limitations](docs/installation.md#provider-and-image-limits) for this preview.

The sidebar shows each agent's provider, configured model, and effort, including disabled agents. Enabled agents also show whether current initial-image support is available, not observed, or unsupported. The browser agent cards and `/participants` show the same status and a safe reason when support is unavailable; disabled agents omit it. Unset model or effort values read `provider default`. In the terminal, `/participants` lists the same settings alongside connection, activity, pause/stop state, queue counts, and any detail or error. It also works in browser chat. Both views reflect settings applied on launch or `/reload`.

Context usage appears in the browser's agent cards and in `/participants`, with token counts and a percentage when the provider reports a context limit. These are the latest provider readings, updated during or after responses, not cumulative token spend. Hover over a browser reading to see when it was reported. Codex reports the latest request's total tokens; Claude reports the latest input including cache reads and writes, matching its native context percentage. Grok's ACP context updates are supported when emitted. Providers without a reading show `unavailable`; an unknown limit shows tokens without a percentage. Readings are saved with the conversation and cleared on fresh provider sessions and reported compaction, until the next reading arrives.

Keep the launching process running. Refreshing or closing the tab leaves agents running; reopening the printed link reconnects to the room. **Quit** in the browser or Ctrl+C in the terminal stops activity and saves the session. Drafts are saved locally while connected and retained in the tab across refresh. If a send response is lost, **Check last action** retrieves the result using the same request ID without duplicating the action during that server launch. Text-only request recovery is limited to that server launch; attachment sends retain their operation identity across restart.

The server binds only to `127.0.0.1` on an available port. Its browser link contains a per-launch access token. The server checks authentication, Host, and Origin for room access. It serves only bundled UI assets; file completion follows the existing workspace boundary. Message HTML and remote images are not rendered. No hosted service or browser-side provider credentials are needed.

## Configuration

User settings load first, then the launch directory's `.agents/chittr.yaml`. Human name, permissions, skills, and conversation settings merge field by field. There is no system-wide layer.

Put your fallback participants in `defaultAgents` in `~/.agents/chittr.yaml`. These are your choices; this example is not an installed config:

```yaml
version: 1
human:
  name: Your name
skills:
  enabled: true
conversation:
  follow_up_turns: 8
permissions:
  edits: false
  commands: false
  network: false
defaultAgents:
  codex:
    provider: codex
  claude:
    provider: claude
```

Set `human.name` in `~/.agents/chittr.yaml` to choose how you appear in the transcript and composer. Agents receive the current name on every turn so they can address you by name. Project config can override it; omission inherits your user setting, or defaults to `You` when neither file sets a name. Setup asks for the name when creating a user config. Changes apply on launch/resume or idle `/reload`, including the labels on existing messages.

`@human` remains the addressing token for you, and autocomplete labels it with your name. Saved conversations keep a stable identity, so changing your display name does not create a new participant or lose history.

A project with an `agents` section uses exactly that roster. A project that omits `agents`, including a directory without a project config, uses your user-level `defaultAgents`. Agent definitions are self-contained: every entry requires `provider`, and project entries do not inherit models, enabled flags, or instructions from the fallback roster. An explicit `agents: {}` produces a configuration error; it does not activate defaults. `defaultAgents` belongs only in user config.

Each key under `agents` or `defaultAgents` is both the visible name and the addressing handle. For example, `reviewer: {provider: codex}` appears as `reviewer` and is addressed with `@reviewer`. The `provider` field selects the CLI; multiple keys may use the same provider. There is no separate agent `name` property.

Keys are stable participant IDs in saved conversations. Changing a key creates a different participant identity, so keep keys consistent when continuing an existing conversation. `human.name` remains available for your own display name.

For example, put this in the launch directory's `.agents/chittr.yaml` to run two Codex participants:

```yaml
version: 1
agents:
  astra:
    provider: codex
    model: gpt-6-astra
    effort: high
  sol:
    provider: codex
    model: gpt-5.6-sol
    effort: medium
```

Only `astra` and `sol` join this project, addressed with their matching `@handles`. User-level Codex and Claude defaults do not join. Room settings still inherit normally.

`model` is optional. Codex and Claude inherit their CLI default; Grok uses the CLI's default in an isolated profile. Set `model` explicitly to choose another model. Set `enabled: false` to disable an entry in the selected roster.

`effort` is also optional and applies only to that participant's Chittr session. It works under project `agents` and user `defaultAgents`. Omit it to leave effort to the CLI; setup does not write an effort default. Config loading validates the value against the selected provider's vocabulary:

| Provider | Effort levels                                                       |
| -------- | ------------------------------------------------------------------- |
| Codex    | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| Claude   | `low`, `medium`, `high`, `xhigh`, `max`                             |
| Grok     | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`          |

Invalid values such as `hihg` produce a configuration error listing the accepted values. Invalid config cannot replace a running room's config on `/reload`. At startup, Codex, Claude, and Grok also check the selected model's advertised effort levels before accepting turns. A model-specific rejection makes that participant unavailable with an error listing its accepted levels. When a CLI does not advertise capabilities for the selected model, only the provider-level guard applies and the CLI remains responsible for model compatibility. Values are never translated to another level by Chittr.

Chittr supplies Codex's `model_reasoning_effort` and turn effort, Claude's `--effort`, and Grok's `--reasoning-effort`. An explicit Claude value takes precedence over an inherited `CLAUDE_CODE_EFFORT_LEVEL` for that process. Native configuration files are not changed. See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), [Claude effort documentation](https://code.claude.com/docs/en/model-config#adjust-effort-level), and [Grok CLI reference](https://docs.x.ai/build/cli/reference).

After editing `effort`, run `/reload` while all agents are idle. Only affected participants restart with fresh provider sessions and the saved public conversation, following the same lifecycle as a model change. `/config` shows each participant's configured effort and its source; `provider default` means Chittr did not override it.

See [the three-provider project example](examples/three-providers.yaml) to use Codex,
Claude and Grok together. They use the same room permissions, instruction sources,
queues and terminal/browser controls.

Custom instruction sources are read in their listed order from the selected roster only. Provider guidance and the room protocol remain in place. For example:

```yaml
# <launch directory>/.agents/chittr.yaml
version: 1
agents:
  codex:
    provider: codex
    instructions:
      sources:
        - file: instructions/review.md
  claude:
    provider: claude
    instructions:
      sources:
        - text: Focus on the end-user experience of this project.
```

That file reference resolves to `.agents/instructions/review.md` beside the project config. Instruction files are explicit configuration inputs and may live outside the task workspace. They are read on launch or idle reload. Unused fallback instruction files are not read. Unknown fields, unreadable selected instructions, and per-agent permission policies are rejected. `/config` shows effective settings and their source files.

To migrate an existing user config, rename its top-level `agents` key to `defaultAgents`, preserving its contents. The old user-level key remains supported as a fallback alias; files are never rewritten automatically. Defining both keys in user config is an error. Existing project configs that relied on partial agent overrides must now specify `provider` and any desired agent settings themselves. The legacy `instructions.mode` field remains accepted, but sources no longer merge across user and project rosters.

Permissions apply to the **whole room**. Project config can grant them directly, so inspect `.agents/chittr.yaml` before launching in an unfamiliar project:

```yaml
version: 1
permissions:
  edits: true
  commands: false
  network: false
```

Edits, sandboxed shell commands, and task networking are independent grants. File inspection works with all three off. Agents explain missing permissions and ask for a YAML change followed by idle `/reload`; there are no temporary chat approvals. Provider authentication and inference traffic are separate from task networking. See [privacy and permissions](PRIVACY.md) for the trust boundaries.

### Trusted commands

To use installed developer tools with their existing configuration and authentication, grant trusted commands to a workspace in your user config:

```yaml
# Add to ~/.agents/chittr.yaml
trustedCommands:
  workspaces:
    - ~/Projects/your-project
```

Trust matches the launch directory's exact realpath. Nested directories and other worktrees need their own entries. Project YAML cannot set `trustedCommands`; `permissions.commands` remains a boolean in both files.

Trusted execution activates only when the effective `edits`, `commands`, and `network` permissions are all `true`. A persistent grant with any permission off leaves commands off or sandboxed. The terminal banner, browser, and `/config` explain which settings prevent activation and where they came from. You can put a trusted workspace into discussion mode by disabling commands in its project config.

For one launch, use `chittr --trusted-commands`, `chittr resume --trusted-commands`, or add the flag to `--web`. This flag writes no configuration and requires all three permissions already enabled; conflicting settings produce an error. Existing `commands: true` rooms stay sandboxed without a matching user grant or this flag.

Trusted commands run without Chittr's command sandbox, with the launching user's filesystem access, network access, existing credentials and exported environment. They can read and write outside the workspace, including skill bundles. File tools keep their workspace and read-only skill restrictions, but these restrictions do not fence trusted commands. Commands use `/bin/sh` from the launch directory. Interactive aliases and unexported functions are unavailable, and shell startup files are not sourced automatically. Normal macOS restrictions, expired logins and Keychain prompts still apply. Provider connections retain their existing credential filters; trusted developer commands receive the unfiltered launch environment.

Run `/reload` while idle after changing a persistent grant. Changes in command mode restart participants with current tools and instructions, restoring public conversation history. Resume and `/sessions ID` recalculate authorization from current settings and this process's launch flag. A saved conversation cannot restore an old grant or a previous process's one-off flag. The environment is captured once at launch; relaunch Chittr to pick up exported environment changes.

## Skills

Skills are enabled by default for the whole room. Each agent receives a catalogue of its provider's installed skills and reads the relevant `SKILL.md` through the room's file tools. You can ask for one by name, for example: `@codex Use the review skill to inspect this proposal.` Skills marked `disable-model-invocation: true` are listed with instructions to use them only when you explicitly request them.

| Provider | User locations                        | Launch-directory location        |
| -------- | ------------------------------------- | -------------------------------- |
| Codex    | `~/.agents/skills`, `~/.codex/skills` | `.agents/skills`                 |
| Claude   | `~/.claude/skills`                    | `.claude/skills`                 |
| Grok     | `~/.grok/skills`, `~/.agents/skills`  | `.grok/skills`, `.agents/skills` |

`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `GROK_HOME`, when set, replace the corresponding provider home for discovery. Discovery includes nested skill collections, including Codex's `.system` directory. It searches only these locations, without walking project ancestors or loading provider plugins. `/config` shows each agent's discovered skills, installed paths, resolved destinations, and discovery warnings.

Symlinked skill directories work automatically, including links into a shared skill store. Access covers each discovered bundle and its supporting files, not the surrounding store or provider home. References within a bundle can follow links into other discovered bundles for that provider; links elsewhere are refused. File tools and sandboxed commands keep bundles read-only even when workspace edits are enabled. Trusted commands have broader account access, including skill writes. Reading script source is allowed; running a script still requires `permissions.commands: true`, and its writes and networking remain subject to room permissions.

Discovery runs on launch, resume, and idle `/reload`. Changing an installed link does not grant its new destination until reload. A changed catalogue, manifest, or resolved destination starts a fresh session for the affected agents, restoring the public conversation and disclosing the reset.

To opt out, set this in either config layer:

```yaml
skills:
  enabled: false
```

This disables the room's skill catalogue and additional file access. Ordinary files already inside the workspace remain readable. Chittr supplies skill instructions through its own tools; native skill slash commands, automatic shell snippets, hooks, and skill-spawned agents remain disabled.

## Conversation and terminal keyboard

Send ordinary text to invite every enabled agent to consider it. Prefix a message with `@codex`, `@claude`, or multiple names to direct it. `@human` addresses only you. Directed messages remain public context. Mentions later in the body do not route messages.

Use `/reply #m2 Your comment` in either interface to reply to a specific message. Replies address the original author by default. Replying to your own message keeps its original recipients, including the whole room for an undirected message. Leading names in the reply text override that default, for example `/reply #m2 @claude Please check this`. Agents receive the reply link and original message text, even when replying to older history. Each human reply starts a fresh follow-up allowance. Ordinary replies are discussion and do not resolve a question.

Question cards contain a standalone prompt and choices, or an inline free-text input. Selecting a choice or **Use this answer** fills an editable draft. **Send answer**, `/answer #m2 literal text`, or `/choose #m2 1` explicitly submits the human's final answer exactly once. Answer text, including slash commands and mentions, stays literal and changes no permissions.

**Ask the room** or `/ask-room #m2` gathers one opinion from each enabled agent, including the asker unless it already supplied linked advice. Recommendations and passes remain attributed advice. They never authorize action, resolve questions, or start peer debate. Pause, stop, recovery and explicit retry controls still apply. You can submit while opinions are pending; later advice stays visible without changing your answer. A new round is available after the previous one finishes. Older rounds cannot be retried while a newer round is pending.

Open-question drafts stay separate from the message composer and are shared between the transcript and question dialog in this browser tab. Historical answers from older sessions keep their original links and text. Remaining older questions also require explicit final submission.

Every required message gets a contribution or a compact pass with a rationale. Passes and activity updates do not trigger other agents. Partial replies stream to you; peers receive completed messages. Agents receive queued messages in arrival order, in bounded batches, and must account for each one.

The participant strip shows connection state, considering/replying/tool activity, explicit waiting for you, pauses, and queued or unresolved work. Delivery lines distinguish queued, sent, received, contributed, passed, interrupted, and failed. Receipt is a provider acknowledgment, not a claim about understanding.

| Key                 | Action                                                                     |
| ------------------- | -------------------------------------------------------------------------- |
| Enter               | Send; accept an open completion first                                      |
| Ctrl+J              | Insert a newline                                                           |
| Ctrl+Enter          | Insert a newline when reported distinctly by the terminal                  |
| Tab / Shift+Tab     | Complete names, commands, and workspace paths; select files or cycle names |
| Escape              | Clear selection, dismiss suggestions, or return to latest                  |
| Arrows / Home / End | Edit the draft, including Unicode and wrapped lines                        |
| Page Up / Page Down | Scroll history while keeping the draft in place                            |
| Mouse drag          | Highlight visible text; release to copy it to the clipboard                |
| Cmd+V / Ctrl+V      | Paste clipboard text into the composer                                     |
| Ctrl+C              | Copy selected text; otherwise stop, then repeat to quit                    |
| Ctrl+D              | Stop, save, and quit                                                       |

Scroll with your trackpad or mouse wheel to read earlier messages. The composer stays fixed, and new replies preserve your reading position. The divider shows how many lines are below the viewport; press Escape to return to the latest message, or scroll to the bottom to follow new replies again. Page Up and Page Down remain available. On keyboards without those keys, use the terminal's Page Up/Page Down bindings. Mouse scrolling requires a terminal that reports SGR mouse events.

Drag across visible conversation text or the composer to highlight it. Releasing the mouse copies the selection and shows a confirmation. No selection modifier or Cmd+C is needed. Chittr uses the local macOS clipboard directly, including when running inside Herdr. Ctrl+C copies the retained selection again. A click without dragging leaves the clipboard alone.

The display holds still while text is selected; agents continue running and saving their replies. Escape clears the selection and refreshes the display without changing your history position. Typing, pasting, scrolling, or resizing also clears it. Selection covers the visible screen: scroll to the text you want before dragging. Copied text preserves original newlines and indentation, joins visual wraps, and excludes color codes.

Cmd+V uses the terminal's normal paste action; Ctrl+V reads text directly from the macOS clipboard. Bracketed multiline paste stays in the composer until explicitly sent. Enhanced keyboard reporting is negotiated where supported; Ctrl+J remains the newline fallback. Path completion inserts a reference, not file contents. The pilot displays message text with wrapping; it does not yet style Markdown.

Type `./` in either composer to open the file explorer at the launch directory. An opening backtick before `./` also works. Keep typing to filter, use Up/Down to choose an entry, and press Enter or Tab to open a folder or insert a file path. You can also click an entry. Selecting a file wraps the entire path in backticks and adds a space after the closing backtick. Folder selections stay open for browsing, with spaces in folder names quoted automatically. Left returns to the parent folder in the CLI; use the Up button or Alt+Up in the web UI. Escape closes the explorer. Files outside the launch directory and symlinks are excluded.

## Controls and recovery

Pins are saved with each conversation and survive resume. Pin any human or agent message with `/pin #m1`, remove it with `/unpin #m1`, and use `/pins` to read all pins in conversation order. The browser also has a Pin button on each message and a Pinned messages list with copy, unpin, and go-to-message controls. Pinning and viewing pins do not send messages to agents or change their context.

Questions from agents are saved on their messages. Each card shows a standalone prompt. Selecting a choice or **Use this answer** fills an editable draft; **Write a different answer** opens the inline custom field. Only **Send answer**, `/answer #m2 text`, or `/choose #m2 1` submits a final answer. `/reply` is discussion and leaves the question open. `/questions` lists open questions with their choices, consultation state and attributed advice. The answer stays queued if its asker or the room is paused.

**Ask the room** and `/ask-room #m2` gather advice without resolving the question or authorizing action. If a queued recipient is disabled by configuration reload, its consultation delivery becomes interrupted so it cannot block later rounds. Retry still requires the agent to be enabled and connected. An older failed or interrupted round can be retried after newer rounds finish, but not while a newer round is pending.

Decision questions require two to six distinct choices; free-text questions have no choices and show their input immediately. Choices that look like commands or @mentions remain literal answer text. Answering never changes YAML permissions or releases pauses. Older saved questions keep their historical answers and use the original message as their prompt. Remaining old questions require explicit final submission. Unpublished drafts and transient waiting flags are not converted into question records.

| Command                            | Action                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `/pause [@agent]`                  | Finish active turns, then hold new turns                                           |
| `/stop [@agent]`                   | Interrupt active turns and hold new turns                                          |
| `/continue [@agent]`               | Release that manual pause; reconnect stopped agents                                |
| `/continue #m1`                    | Add another follow-up allowance to the initiating exchange                         |
| `/reconnect @agent`                | Reconnect with that participant's work paused                                      |
| `/compact [@agent] [instructions]` | Compact one agent, or all enabled and ready agents; optional focus where supported |
| `/checkpoint`                      | Read the latest checkpoint and its source message IDs                              |
| `/retry #m1 @agent`                | Explicitly queue a failed or interrupted response again                            |
| `/questions`                       | List open questions, choices, consultation state and advice                        |
| `/ask-room #m2`                    | Gather attributed opinions; leave the final decision to the human                  |
| `/answer #m2 text`                 | Send a literal answer only to the question's author                                |
| `/choose #m2 1`                    | Answer with a numbered choice                                                      |
| `/pin #m1`                         | Pin a message in this conversation                                                 |
| `/unpin #m1`                       | Remove a message pin                                                               |
| `/pins`                            | Read pinned messages with their IDs, authors, and full text                        |
| `/reload`                          | Validate and apply config while all agents are idle                                |
| `/config`                          | Show effective config and provenance                                               |
| `/participants`                    | List all agents with provider, model, effort, context usage, status, and queues    |
| `/new`                             | Start a separate conversation while idle                                           |
| `/sessions [ID]`                   | List or open saved conversations for this workspace                                |
| `/help`                            | Show controls                                                                      |
| `/quit`                            | Stop, save, and exit                                                               |

Room and participant pauses are independent. Continuing one participant does not clear a room pause. After a failure, use `/reconnect @name`, `/retry #message @name`, then `/continue @name` (and `/continue` if the room is paused). Completed responses are never automatically retried. Stop does not roll back file or command side effects.

Each human message starts an exchange with eight shared follow-up turns by default. Initial replies to the human are exempt. Follow-up passes and dispatched failed/interrupted attempts count. A batched turn charges each represented exchange once. An exhausted exchange parks while independent work continues; ordinary `/continue` does not replenish its allowance.

Each `chittr` launch starts a new room. Use `chittr resume` to choose a saved conversation for this directory, or `chittr resume ID` to open one directly. Resuming clears saved room and participant pauses, reconnects enabled agents, and runs eligible queued messages without `/continue`. Failed and interrupted deliveries still need `/retry`; follow-up limits and disabled-agent settings remain in force. This also applies to `--session ID`, web resume, and opening a saved conversation with `/sessions ID`. Cancelling the picker starts no agents and leaves saved chats unchanged; an empty history suggests starting a new chat. The existing `--new` and `--session ID` flags remain supported.

Sessions live under `~/.agents/chittr/sessions/<workspace-id>/<session-id>/`; `--state-dir PATH` overrides this for both new chats and resume. Snapshots preserve the transcript, outcomes, tool-activity summaries, queue, cap accounting, provider session references, and unsent draft. Credentials stay with the CLIs. One live instance owns each workspace within a storage location.

Claude resumes its native session. When Codex cannot resume because its native state is missing or its restricted-read instruction loading fails, the adapter can start a fresh provider session and disclose restoration from the saved public conversation. Changed provider/model/effort/custom instructions also start a fresh session. Missing native state uses an accepted checkpoint when available; otherwise long histories use a labelled extractive digest. Exact full-message retrieval remains available through the conversation tool. Private provider reasoning and unsent drafts are not supplied as shared context.

Grok keeps its native process for consecutive turns. On reconnect or application restart, it starts fresh and discloses restoration from the saved public conversation. Its temporary native profile is removed on close. Grok uses its existing native auth-file location. Your normal Grok settings, hooks and plugins are not loaded into this profile. Put custom guidance in Chittr's YAML instruction sources.

## Development

From a source checkout, install dependencies and build:

```sh
npm ci
npm run build
```

The [Quality guide](https://github.com/chittr/chittr/blob/main/docs/quality.md)
lists optional checks. The full suite and hosted Quality are skipped for this
preview; use focused checks for behavior you change.

The following live-provider checks consume subscription allowance and require
separate authorization. They are not part of CI or `npm run quality`.

```sh
npm run test:trusted -- /absolute/path/to/gh-codex # live provider turns and read-only GitHub identity check
npm run test:live        # installed subscription CLIs; disposable fixture files
npm run test:skills:live # both CLIs read symlinked skills and supporting files
npm run test:room        # real peer discussion, correction, and passes
npm run test:interrupt   # interrupt each real CLI after receipt
```

`npm run dev` builds the workers and browser assets before opening the TypeScript entrypoint; `npm run dev -- --web` opens the browser UI. The PTY test uses Python 3 and deterministic peers. Browser tests use Playwright and an isolated clipboard fixture. Set `CHITTR_BROWSER` to a browser executable path to use an existing installation. Security tests must run outside an outer sandbox that prevents macOS from starting a child sandbox.

`test:trusted` uses one operator-selected identity wrapper across selected provider transports. Append provider names to choose the supported launch providers. It checks the registered login and records whether authentication uses the launch environment or Keychain fallback, without printing credentials. It does not assign that test identity to participants in ordinary chats.

The room engine, provider adapters, tool enforcement and interfaces are separate
modules. See [architecture](https://github.com/chittr/chittr/blob/main/docs/architecture.md)
for source navigation. Local builds use `npm ci` and `npm run build`; an installed
package already contains the runtime and browser assets.

### Compact context

Use `/compact` for all enabled, connected agents or `/compact @agent` for one.
Add optional instructions to focus the summary:

```text
/compact remember the epic and ticket details
/compact @claude retain the current objective and unresolved questions
```

Each agent waits for its current turn, then holds its next dispatch during
compaction. Other agents and incoming messages continue normally. The all-agent
command skips stopped, unavailable, or connecting agents and reports why.
Each requested agent has its own status and can be stopped independently.
Repeated requests with identical instructions share one operation; different
instructions are rejected while that agent's compaction is pending.
Compaction can run while paused and does not release pauses or answer messages.

The browser offers **Compact all** in the toolbar and **Compact context** beside
each agent's context reading. Both open an optional focus field. Instructions
must fit within 4096 UTF-8 bytes. Use `--` before instructions that start with an
`@name`, such as `/compact -- @claude raised a concern; retain its details`.
Bare agent names such as `/compact codex` are rejected to catch a missing `@`;
`/compact -- codex` explicitly uses that name as focus for all agents.
Claude receives line breaks and control whitespace as spaces in its native
command. The saved instructions and Grok's custom context retain their formatting.

Claude and Grok use native compaction and receive the custom instructions. Codex
uses native compaction, but its app-server request accepts only a thread ID, so
supplied instructions are omitted. Codex replacement and recovery also carry an attributed
continuation note from the source session when that session can still write one.
This replacement route uses its standard preservation instructions.
`/participants` and browser status show when custom focus is unsupported. Focus
is a retention request, not a guarantee that every detail survives summarization.

No room YAML setting enables native compaction, and no CLI version enables or
disables it. Once a provider has started under its verified policy checks, Chittr attempts its native route and validates the actual result: Codex must
report its correlated compaction item and turn completion, Claude a fresh manual
boundary with a matching result, Grok its correlated completion reply. Claude
keeps the built-in compact command available while denying native
Skill/Agent/Task tools, bundled skills, skill shell execution, hooks and setting
sources, and refuses to start on a CLI that lacks any of those launch controls.
Reinstall the intended package and restart Chittr to apply adapter code changes; `/reload` only reloads
room configuration.

A failed native operation, including a CLI that does not support the operation,
is shown as failed and requires `/reconnect @agent`; it does not silently start a
replacement. `/stop @agent` cancels maintenance.
Reconnect, reload, and conversation switching require maintenance to finish or
be stopped first. Stopped or unavailable agents must reconnect before compaction.

Use `/checkpoint`, or **Checkpoint** in the browser toolbar, to read the latest
checkpoint, its version, exact message boundary, and source IDs. Checkpoints
are fallible conversation evidence. The original conversation remains intact,
and `read_conversation` still retrieves exact messages. Context occupancy stays
unavailable after compaction until the provider supplies a new reading.

When native state cannot resume, restoring a conversation also uses subscription
turns to generate any missing checkpoint and accept the seed. A checkpoint with
no newer public messages is reused. If reconstruction exceeds the documented
budgets, recovery stays unavailable and preserves the saved reference and history.
Reconnect retries preparation; it does not bypass the bounds with digest replay.

Generation uses bounded chunks, and a replacement must accept its bounded seed
before the saved provider reference changes. Oversized required messages or
reply targets fail visibly instead of being truncated. See
[context maintenance budgets and recovery](https://github.com/chittr/chittr/blob/main/docs/architecture.md#context-maintenance)
and [preview provider limits](docs/installation.md#provider-and-image-limits).

## Contributing and community

- [CONTRIBUTING.md](https://github.com/chittr/chittr/blob/main/CONTRIBUTING.md) — the fork, branch, pull request and review loop,
  optional credential-free checks, contribution terms, label use,
  first-contribution candidates and how agent-assisted contributions work.
- [SUPPORT.md](https://github.com/chittr/chittr/blob/main/SUPPORT.md) — what best-effort support means here, what to read first, and
  which channel each kind of request belongs in.
- [SECURITY.md](https://github.com/chittr/chittr/blob/main/SECURITY.md) — how to report a vulnerability privately, what is in scope,
  and this preview's stated limitations. Never open a public issue for a vulnerability.
- [CODE_OF_CONDUCT.md](https://github.com/chittr/chittr/blob/main/CODE_OF_CONDUCT.md) — what is expected in this project's spaces,
  and how to report a problem privately.

Bill ([@mcgloneb](https://github.com/mcgloneb)) is the sole maintainer: he reviews and
merges pull requests, handles security reports, moderates and releases. There is no
second maintainer, no service-level agreement and no support contract.

Technical navigation for contributors and CLI agents is in [AGENTS.md](https://github.com/chittr/chittr/blob/main/AGENTS.md), the
[architecture map](https://github.com/chittr/chittr/blob/main/docs/architecture.md) and the [maintenance guides](https://github.com/chittr/chittr/blob/main/docs/maintenance.md).
