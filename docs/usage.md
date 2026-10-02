# Use Chittr

This guide covers running a room in the terminal and the browser: the launch directory, addressing agents, questions, keyboard controls, room commands, saved conversations and context compaction. Participants, permissions and skills are configured as [configure Chittr](configuration.md) describes.

## Launch directory and saved chats

Launch in the exact directory agents should inspect. For example, launching in `~/Projects/your-project` gives the room that workspace. Launching in a nested directory gives it only that nested directory. The app does not search upward for a Git root or project config.

`chittr` always starts a new chat and preserves previous conversations. Run `chittr resume` to browse saved chats from this exact directory, most recently updated first. Use ↑/↓ to select, Enter to resume, or Escape to cancel. Type to search conversation previews or session IDs; PgUp/PgDn and Home/End navigate longer lists. `chittr resume ID` opens a specific saved chat directly.

For an npm-global installation, `chittr update` updates the running package to
npm's latest release without starting a room. Close all other rooms and make a
complete backup first. See [upgrade and roll back](installation.md#upgrade-and-roll-back)
for installation scope, older releases and recovery. The command accepts no room
options or extra arguments; `chittr update --help` and `--version` show CLI information.

## Launch with a shared brief

```sh
chittr --instructions-file ./review-brief.md
chittr --new --web --instructions-file ./review-brief.md
```

The file supplies shared instructions to every agent in the initial new conversation, alongside [room YAML and agent-specific instructions](configuration.md#custom-instructions). Relative paths resolve from the launch directory; absolute and `~/` paths also work. Quote paths containing spaces. Supply exactly one flag with a nonempty path. It works with `--new` and `--web`, but is rejected with `resume`, `--session` or `doctor`.

Chittr reads and validates the file before first-run setup, workspace locking or participant startup. Missing, unreadable and over-1-MiB files fail launch. `--help` and `--version` do not read the file. The size limit applies to each file, not the aggregate provider prompt; transport limits may still make a participant unavailable.

The file may live outside the workspace. Its contents are sent to participating providers and saved with the conversation before any participant starts. Editing or deleting the source later does not change that saved brief, and the saved path is only an origin label. A save failure prevents participant startup.

| Action                                    | Room YAML                  | Conversation brief                                    |
| ----------------------------------------- | -------------------------- | ----------------------------------------------------- |
| New CLI launch with `--instructions-file` | Current selected YAML      | Read once and save                                    |
| New launch without the flag               | Current selected YAML      | None                                                  |
| `resume`, `--session`, `/sessions ID`     | Current selected YAML      | Restore destination's saved text                      |
| `/new`                                    | Current selected YAML      | None, even when the previous conversation had a brief |
| Idle `/reload`                            | Re-read selected YAML      | Keep the saved brief                                  |
| Reconnect, add or re-enable an agent      | Current room configuration | Keep the active brief                                 |
| `/compact` or context recovery            | Current room configuration | Keep the active brief                                 |

`/config` identifies the active instruction sources. There is no command to edit or clear an existing saved brief; start a new conversation to use a different one. Instruction text does not appear as a chat message. Within custom guidance, the brief takes precedence over room YAML, then agent instructions. This is a prompt instruction, not a permission grant or guarantee of compliance.

## Browser interface

```sh
cd ~/Projects/your-project
chittr --web
```

This starts a new chat, runs a local server, and opens your default browser. If opening the browser fails, use the link printed in the terminal. The browser uses the same workspace, merged YAML, CLI subscriptions, permissions, and saved sessions as terminal chat. `chittr resume --web` selects a saved chat in the terminal before opening it in the browser; `chittr resume ID --web` opens it directly. `--state-dir PATH` also works with `--web`. First-time configuration still uses the terminal setup prompt.

The browser provides a shared transcript, Markdown and code blocks, message/code copy buttons, live agent status, and a fixed composer. Normal selection and copy/paste work. Enter sends; Shift+Enter, Ctrl+Enter, or Ctrl+J insert a newline. Leading `@names` autocomplete as you type. Tab completes names, slash commands, and workspace file references. Incoming replies preserve the draft and history position; **Jump to latest** resumes following the conversation.

In either composer, Up recalls your latest sent message, then moves through older messages. Down moves through newer messages and returns to your unsent draft. Down on an empty draft does nothing, and history does not wrap. While editing a multiline draft, Up moves through its lines before recalling history at the top. Open completion menus keep their arrow-key controls.

Click **Reply** on a message to quote it above the composer, then type and send. Your existing draft stays in place. **Cancel reply** or Escape removes the reply target without discarding your text. The target stays with your draft across refresh and saved-session resume. Sent replies link back to the original message.

Use the room buttons to pause, stop, continue, or quit. Each agent's `···` button opens its individual controls. Failed and interrupted deliveries have retry buttons; capped exchanges offer additional follow-up turns. All existing slash commands also work. The sidebar opens saved conversations and effective configuration, and its theme picker switches between the system colour scheme, light and dark; the browser remembers a light or dark choice across launches. Configuration changes still require YAML edits and an idle reload. Restored sessions start active; queued messages run as agents connect, while failed and interrupted deliveries still require an explicit retry.

### Images

Paste, drop, or select images with **Attach images**. Pending uploads show filenames; accepted images show previews. Remove or retry failed uploads before sending. Captions are optional, including replies. Leading `@names` still select recipients. When an image is staged for a recipient that can't receive it, the composer shows one line per affected recipient, such as `@antigravity can't receive images`. The warning does not block sending or predict whether a message will be attempted or queued. [Provider and image limits](installation.md#provider-and-image-limits) gives the accepted formats and sizes, browser conversion, which providers can receive images, where the full reason for a warning appears, and what previews and delivery status prove.

Staged and sent images are saved as host references. Reload or reopen the current browser link to restore them; after restarting the host, open its new link to authenticate image reads. **View image** opens a larger view, and Escape closes it. **Check last action** retries an unknown attachment-send result using its saved identity, including after restart. An interrupted upload can be retried with the same file; the browser retains its operation identity but does not save the image bytes. After a reload, select the original file again: a converted image is converted again and resumes the same upload only when the result matches what was sent.

### Participants and context usage

The sidebar shows each agent's provider, configured model, and effort, including disabled agents. `/participants` also shows each enabled agent's current initial-image support (available, not observed, or unsupported) and a safe reason when support is unavailable; disabled agents omit it. Unset model or effort values read `provider default`. In the terminal, `/participants` lists the same settings alongside connection, activity, pause/stop state, queue counts, and any detail or error. It also works in browser chat. Both views reflect settings applied on launch or `/reload`.

Context usage appears in the browser's agent cards and in `/participants`, with token counts and a percentage when the provider reports a context limit. These are the latest provider readings, updated during or after responses, not cumulative token spend. Hover over a browser reading to see when it was reported. Codex reports the latest request's total tokens; Claude reports the latest input including cache reads and writes, matching its native context percentage. Grok's ACP context updates are supported when emitted. Providers without a reading show `unavailable`; an unknown limit shows tokens without a percentage. Readings are saved with the conversation and cleared on fresh provider sessions and reported compaction, until the next reading arrives.

### Tabs and the local server

Keep the launching process running. Refreshing or closing the tab leaves agents running; reopening the printed link reconnects to the room. **Quit** in the browser or Ctrl+C in the terminal stops activity and saves the session. Drafts are saved locally while connected and retained in the tab across refresh. If a send response is lost, **Check last action** retrieves the result using the same request ID without duplicating the action during that server launch. Text-only request recovery is limited to that server launch; attachment sends retain their operation identity across restart.

The server binds only to `127.0.0.1` on an available port. Its browser link contains a per-launch access token. The server checks authentication, Host, and Origin for room access. It serves only bundled UI assets; file completion follows the existing workspace boundary. Message HTML and remote images are not rendered. No hosted service or browser-side provider credentials are needed.

## Conversation

Send ordinary text to invite every enabled agent to consider it. Prefix a message with `@codex`, `@claude`, or multiple names to direct it. `@human` addresses only you. Directed messages remain public context. Mentions later in the body do not route messages.

Use `/reply #m2 Your comment` in either interface to reply to a specific message. Replies address the original author by default. Replying to your own message keeps its original recipients, including the whole room for an undirected message. Leading names in the reply text override that default, for example `/reply #m2 @claude Please check this`. Agents receive the reply link and original message text, even when replying to older history. Each human reply starts a fresh follow-up allowance. Ordinary replies are discussion and do not resolve a question.

### Questions and Ask the room

Questions from agents are saved on their messages. Question cards contain a standalone prompt and choices, or an inline free-text input. Decision questions require two to six distinct choices; free-text questions have no choices and show their input immediately. Selecting a choice or **Use this answer** fills an editable draft; **Write a different answer** opens the inline custom field. Only **Send answer**, `/answer #m2 literal text`, or `/choose #m2 1` submits the human's final answer, exactly once. Answer text, including slash commands, mentions and choices that look like them, stays literal. Answering never changes YAML permissions or releases pauses. The answer stays queued if its asker or the room is paused. `/reply` is discussion and leaves the question open. `/questions` lists open questions with their choices, consultation state and attributed advice.

**Ask the room** or `/ask-room #m2` gathers one opinion from each enabled agent, including the asker unless it already supplied linked advice. Recommendations and passes remain attributed advice. They never authorize action, resolve questions, or start peer debate. Pause, stop, recovery and explicit retry controls still apply. You can submit while opinions are pending; later advice stays visible without changing your answer. A new round is available after the previous one finishes. If a queued recipient is disabled by configuration reload, its consultation delivery becomes interrupted so it cannot block later rounds. Retry still requires the agent to be enabled and connected. An older failed or interrupted round can be retried after newer rounds finish, but not while a newer round is pending.

Open-question drafts stay separate from the message composer and are shared between the transcript and question dialog in this browser tab. Older saved questions keep their historical answers, original links and text, and use the original message as their prompt. Remaining older questions require explicit final submission. Unpublished drafts and transient waiting flags are not converted into question records.

### Contributions and delivery

Every required message gets a contribution or a compact pass with a rationale. Passes and activity updates do not trigger other agents. Partial replies stream to you; peers receive completed messages. Agents receive queued messages in arrival order, in bounded batches, and must account for each one.

The participant strip shows connection state, considering/replying/tool activity, explicit waiting for you, pauses, and queued or unresolved work. Delivery lines distinguish queued, sent, received, contributed, passed, interrupted, and failed. Receipt is a provider acknowledgment, not a claim about understanding.

## Terminal keyboard

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

The display holds still while text is selected; agents continue running and saving their replies. Escape clears the selection and refreshes the display without changing your history position. Typing, pasting, scrolling, or resizing also clears it. Selection covers the visible screen: scroll to the text you want before dragging. Copied message text is the rendered text: it preserves paragraph newlines and code indentation, joins visual wraps, and excludes color codes, hidden Markdown delimiters and display padding. Source tabs become four spaces. Initial list and quote markers remain; repeated wrap prefixes do not. Tables copy their visible rows, including borders and alignment spaces, with newlines between rows.

Cmd+V uses the terminal's normal paste action; Ctrl+V reads text directly from the macOS clipboard. Bracketed multiline paste stays in the composer until explicitly sent. Enhanced keyboard reporting is negotiated where supported; Ctrl+J remains the newline fallback. Path completion inserts a reference, not file contents.

Completed messages and streaming previews render Markdown headings, bold and italic emphasis, nested lists, quotes, inline and fenced code, links, image references and GFM tables. Paragraph source newlines remain line breaks. Code wraps with its indentation and an optional language label; there is no syntax highlighting or line-number gutter. Tables wrap cells or use labelled fields when the terminal is too narrow. Unrecognized or unfinished syntax stays readable. Raw HTML is literal text; differing link destinations are shown alongside their labels, and images are text references. Rendering never opens links or loads images. The composer stays raw Markdown, and saved and provider-visible text keeps its original source.

### File explorer

Type `./` in either composer to open the file explorer at the launch directory. An opening backtick before `./` also works. Keep typing to filter, use Up/Down to choose an entry, and press Enter or Tab to open a folder or insert a file path. You can also click an entry. Selecting a file wraps the entire path in backticks and adds a space after the closing backtick. Folder selections stay open for browsing, with spaces in folder names quoted automatically. Left returns to the parent folder in the CLI; use the Up button or Alt+Up in the web UI. Escape closes the explorer. Files outside the launch directory and symlinks are excluded.

## Room controls

### Pins

Pins are saved with each conversation and survive resume. Pin any human or agent message with `/pin #m1`, remove it with `/unpin #m1`, and use `/pins` to read all pins in conversation order. The browser also has a Pin button on each message and a Pinned messages list with copy, unpin, and go-to-message controls. Pinning and viewing pins do not send messages to agents or change their context.

### Room commands

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

### Pauses, failures and follow-up turns

Room and participant pauses are independent. Continuing one participant does not clear a room pause. After a failure, use `/reconnect @name`, `/retry #message @name`, then `/continue @name` (and `/continue` if the room is paused). Completed responses are never automatically retried. Stop does not roll back file or command side effects.

Each human message starts an exchange with eight shared follow-up turns by default. Initial replies to the human are exempt. Follow-up passes and dispatched failed/interrupted attempts count. A batched turn charges each represented exchange once. An exhausted exchange parks while independent work continues; ordinary `/continue` does not replenish its allowance.

## Saved conversations and recovery

Each `chittr` launch starts a new room. Use `chittr resume` to choose a saved conversation for this directory, or `chittr resume ID` to open one directly. Resuming clears saved room and participant pauses, reconnects enabled agents, and runs eligible queued messages without `/continue`. Failed and interrupted deliveries still need `/retry`; follow-up limits and disabled-agent settings remain in force. This also applies to `--session ID`, web resume, and opening a saved conversation with `/sessions ID`. Cancelling the picker starts no agents and leaves saved chats unchanged; an empty history suggests starting a new chat. The existing `--new` and `--session ID` flags remain supported.

`--state-dir PATH` selects the storage base for both new chats and resume; [what stays on your Mac](../PRIVACY.md#what-stays-on-your-mac) gives the default location and how credentials are kept. Snapshots preserve the transcript, outcomes, tool-activity summaries, queue, cap accounting, provider session references, and unsent draft. One live instance owns each workspace within a storage location.

Claude resumes its native session. When Codex cannot resume because its native state is missing or its restricted-read instruction loading fails, the adapter can start a fresh provider session and disclose restoration from the saved public conversation. Changed provider/model/effort/custom instructions also start a fresh session. Missing native state uses an accepted checkpoint when available; otherwise long histories use a labelled extractive digest. Exact full-message retrieval remains available through the conversation tool. Private provider reasoning and unsent drafts are not supplied as shared context.

Grok keeps its native process for consecutive turns. On reconnect or application restart, it starts fresh and discloses restoration from the saved public conversation. It runs in a temporary native profile, which [privacy and permissions](../PRIVACY.md#what-stays-on-your-mac) describes. Grok uses its existing native auth-file location. Your normal Grok settings, hooks and plugins are not loaded into this profile. Put custom guidance in Chittr's YAML [instruction sources](configuration.md#custom-instructions).

## Context compaction

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
and [preview provider limits](installation.md#provider-and-image-limits).
