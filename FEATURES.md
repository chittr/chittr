# Chittr feature discussion

Status: the user confirmed the consolidated plan and authorized implementation using TypeScript. The personal pilot is implemented; see README.md and docs/compatibility.md for operation and validation.

## Established requirements

- Launch the chat from a terminal in any directory.
- Use that launch directory as the shared workspace available to connected agents.
- Merge YAML configuration from `~/.agents/chittr.yaml` and then `<launch_directory>/.agents/chittr.yaml`. Explicit project settings override user defaults; omitted settings inherit them. Do not add a system-wide scope for the pilot.
- If neither config exists, offer setup to create a user-level starter config using detected CLI installations.
- Starter setup requires an explicit selection from detected CLIs and writes user-owned `defaultAgents`, without model overrides or stock custom instructions. No personal config ships with the app.
- Use project `agents` as the complete roster when present; otherwise use user `defaultAgents`. Reject an explicit empty roster. Every agent definition is self-contained and requires a provider. Legacy user `agents` remains a fallback alias, with no automatic file rewrites.
- Use agent keys as both visible names and addressing handles. The provider selects the CLI, and the key is the stable identity in saved history.
- Support per-agent custom instructions through configuration. Preserve normal provider guidance and room communication rules; read only the selected roster's instruction sources in their listed order.
- Support inline instruction text and instruction-file references. Resolve relative references from the config file that declares them.
- Read current config on launch and resume. Allow an explicit reload while agents are idle; do not silently alter running turns.
- Initially support Codex and Claude Code using the user's existing subscriptions and local CLI installations.
- Give each agent its own identity in a shared conversation with the human and other agents.
- Let agents communicate and collaborate directly without requiring the human to relay messages.
- Make composing messages comfortable and agent replies feel natural.
- Show when an agent receives a message and when it is preparing to reply.
- Build a terminal interface for one human with local agents.
- Use a shared scrollable transcript, a compact participant strip, and a fixed multiline composer. Incoming replies preserve the draft, cursor, focus, and reading position.
- Enter sends. Ctrl+J inserts a newline; Ctrl+Enter also inserts a newline where the terminal distinguishes it from Enter. Keep Ctrl+J as the fallback elsewhere. Multiline paste remains a draft until explicitly sent, with keyboard hints visible.
- Offer file-path completion and send workspace-relative file references without automatically pasting entire file contents.
- Default to discussion and file inspection. Use one room-wide permission policy for workspace edits, general command execution, and network tools, with no per-agent overrides. Project configuration may grant extra permissions directly; a separate user-level grant is not required.
- Limit task-file access to the launch directory for the pilot. Do not support extra task directories yet. Normal CLI access to its own authentication, configuration, instruction sources, and runtime files is distinct from task-file access.
- If an action needs an ungranted permission, explain the missing permission and require a config change. Do not offer a temporary in-chat grant.
- Require adapter support for the configured filesystem and tool permissions. Leave an incompatible agent unavailable with an explanation while compatible agents continue.
- For a message without a human or agent recipient, let all eligible agents consider replying, including when another agent authored it.
- Require an explicit response from every agent asked to consider a message. An abstention is a compact outcome attached to the original message, with a short rationale. It does not trigger any other agent response.
- Keep directed messages visible to everyone. Only the recipients consider responding; other agents can use the exchange as context later.
- Continue automatic discussion until agents have no further contributions or a configurable turn cap is reached. Default to eight follow-up agent turns per initiating human message, shared across agents. Initial responses to the human are outside that allowance; follow-up turns count even when the agent abstains. Reaching the cap pauses the exchange for the human to continue or redirect.
- Allow concurrent replies.
- Stream replies to the human, but deliver only completed messages to peers. Never activate an agent on its own message. Concurrent turns finish with their starting context, then consider queued replies.
- Queue new input when an agent is busy. It may consider queued messages together on its next turn, but must account for every eligible message with a contribution or explicit abstention.
- Process queued messages in arrival order, without prioritizing human messages over agent messages or automatically interrupting an active turn.
- A batched turn handling follow-ups from several initiating human messages spends one turn from each represented exchange. Initial responses remain exempt. An exhausted exchange cannot bypass its cap by joining another batch.
- Park capped exchanges while other runnable messages continue in arrival order. Explicitly continuing a capped exchange adds another configured follow-up allowance, eight turns by default.
- Provide pause, stop, and continue for an agent or the whole room. Pause lets active turns finish and prevents new turns. Stop interrupts active turns and prevents new turns. Continue releases queued work. Preserve interrupted output and pending work.
- Address human messages using leading @names with autocomplete, including multiple recipients. Mentions elsewhere in the text are references rather than routing instructions.
- Stop activity and save the session when the terminal closes.
- Resume the latest saved conversation when launched again from the same directory. Provide an explicit command to start a new conversation.
- Store conversations centrally under the user profile, associated with the launch directory.
- Keep the room and other agents running when an agent fails. Show the failure, retain its pending messages, and reconnect explicitly. Do not silently replay completed work.
- On resume or reconnect, restore context with pending work paused until explicitly released. Interrupted turns remain incomplete and require explicit retry.
- If the native provider session cannot resume, restore a fresh session from the saved conversation and disclose the reset. Long histories may require a labelled summary.
- When config changes an agent's provider, model, or custom instructions, restore a fresh provider session from shared history and disclose the reset. Preserve unchanged agents' sessions. Apply room-wide permission changes before any further task work.
- Deliver a macOS personal pilot first. Verify CLI compatibility and permission enforcement before building the full terminal interface. Public packaging, licence choice, and additional operating systems follow the pilot.

## Product direction

The first interface will be a dedicated terminal chat. Visible activity and a stable composer are central requirements.

Stoops is a source of ideas. The user's experience with its flow, typing, interface, and agent replies does not meet the desired experience.

An open-source release follows the personal pilot. No licence or distribution method has been selected.

## Experience and validation details

### Comfortable conversation

- Keep the composer available while any agent is responding or working.
- Preserve the draft, cursor position, and keyboard focus as messages arrive.
- Support multiline messages, pasting, and optional agent mentions.
- Keep new output from forcing the user back to the bottom when reading earlier messages.
- Make the author and reply target clear for every message.

### Visible agent activity

- Keep a compact participant list visible, with each agent's independent activity state.
- Track current activity separately from connection state, queued messages, and pending requests for human input. An agent can be working while another message is queued for it.
- Track message delivery separately for each addressed agent. Application acceptance and CLI acknowledgment must not be described as proof that the agent has read or understood the message.
- Show activity beside the relevant message as well as beside the participant when useful.
- Show disconnected, failed, or interrupted agents explicitly.
- Base activity indicators on observable events. Do not infer that an agent has read or understood a message merely because the application accepted it.
- If an agent elects not to contribute, show its explicit outcome and short rationale compactly on the original message. Do not infer abstention from silence or an error, and do not let an abstention activate peers.

Candidate activity labels: Available, Considering, Replying, Working, Waiting for you. Queued and Received describe message delivery; connection and error indicators are separate. Exact labels and transitions remain proposals and need provider compatibility checks before implementation promises.

### Natural participation

- Allow a message to address one agent, several agents, or the room.
- Let agents ask each other questions and continue an exchange within the user's agreed task scope.
- Permit agents to decline to contribute, but require them to confirm that outcome to the system.
- Bound automatic exchanges and process queued messages in arrival order. Human input does not jump ahead of agent messages.
- Keep agent conversations visible to the human.

Undirected messages invite all eligible agents except the author to consider replying, whether the sender is human or another agent. Directed messages remain public, but only named recipients consider responding. Other agents receive those exchanges as context when they are next active. Abstentions do not activate agents. Human input uses leading @names for recipients; references within the body do not direct the message. Streaming text is visible to the human; only completed messages activate peers.

Replies may appear concurrently. Each agent processes its runnable queued input in arrival order and may consider messages together, while accounting for each eligible message. A batch spends one follow-up turn from each initiating exchange it represents. Initial responses to human messages remain exempt. Park capped exchanges without blocking independent work. Explicitly continuing a capped exchange adds another configured allowance.

Question cards show the prompt, editable choices or custom text, and explicit human final submission. Ask the room gathers attributed advice under normal queue controls. Recommendations and ordinary replies leave questions open. Browser Send answer and terminal /answer or /choose resolve once; /ask-room requests advice only.

### User control

- Allow the user to interrupt a response, pause one agent, or pause the whole room.
- Queue new messages for a busy agent's next turn. Pause lets active turns finish; stop interrupts them. Both prevent new turns until continued.
- Preserve the conversation when an agent fails or the interface disconnects.

### Workspace context

- Display the active workspace clearly.
- Let users refer to project files in messages without copying their contents into chat.
- Show the room-wide permission policy and whether each agent can enforce it.

Discussion and file inspection are the default. Project config may grant room-wide edit, command, and network-tool permissions directly. There are no per-agent permission overrides, separate user-config authorization requirements, or temporary in-chat grants. Task-file access is limited to the launch directory for the pilot, with no configurable extra task directories. Provider runtime and instruction-loading access is distinct. An adapter that cannot enforce the room policy leaves its agent unavailable. Actual enforcement still requires compatibility probes before support is claimed.

### Continuing sessions

- Save the shared conversation and participating agent identities.
- Store session data centrally in the user profile and associate it with the launch directory.
- Stop activity and save the session when the terminal closes. Stopping activity does not establish task success or imply rollback of any action already performed.
- Reopen a conversation with continuity for each agent where its CLI supports it.
- Launching in a directory resumes its latest saved conversation; an explicit command starts a new one.
- Restore context from the saved conversation when a native session cannot resume, and disclose the reset. Pending work stays paused; interrupted turns require explicit retry.

## Design tree after interview round 7

- Scope: discussion and file inspection by default; extra permissions through config.
  - Current: merge user and launch-directory room settings; use self-contained project agents or the user's fallback defaultAgents. This supersedes the original per-agent field and instruction inheritance. Project config can grant extra permissions directly; no system-wide scope for the pilot.
  - Research complete at source/documentation level: preventing writes and restricting reads are separate controls. Provider settings can restrict task tools, with runtime exceptions and separate controls for shell, MCP, and other integrations. No live containment probes have run.
  - Settled in Q24-Q28: launch-directory-only task files, with no extra task roots for the pilot; shared edit/command/network-tool permissions; missing permissions require config changes; current config on launch/resume and explicit idle reload; inline instructions and referenced files.
  - Settled in Q29: offer setup to create a user-level starter config when both configs are absent.
  - Settled in Q32 and Q40: selectable detected agents with provider-default models; require configured permission support.
  - Settled in Q42: versioned YAML with named agents, optional models, ordered instruction sources, and one room-wide permission policy. No per-agent permission overrides.
- Interface: terminal.
  - Settled: concurrent replies; compact explicit abstention outcomes with short rationales on the original messages.
  - Settled: leading @names with autocomplete direct human messages.
  - Settled in Q30: shared transcript, compact participant strip, fixed multiline composer; preserve composition and reading position.
  - Settled in Q33-Q34 and Q41: Enter sends, Ctrl+J and Ctrl+Enter insert newline; streaming is human-visible while peers receive complete messages; file-path completion and references.
  - Research complete: legacy terminal input can encode Enter and Ctrl+Enter identically. Enhanced reporting or explicit mappings can distinguish them. No interactive keyboard probe has run.
  - Settled in Q46: support Ctrl+Enter where distinguishable, with Ctrl+J as the fallback elsewhere.
- Participation: undirected human and agent messages invite every eligible agent to consider replying; new messages queue for busy agents.
  - Settled: public directed exchanges; abstentions do not trigger peers; automatic exchanges have a configurable turn cap.
  - Settled: eight follow-up turns, excluding initial responses to the human; batched queued messages with an outcome for each eligible message.
  - Settled in Q34-Q37: no self-activation; arrival-order queues without human priority; charge each represented exchange once per batched follow-up turn; pause, stop, and continue have distinct meanings.
  - Settled in Q43: park capped exchanges, allow independent work in arrival order, and extend a capped exchange by another configured allowance only on explicit continuation.
- Room membership: one human and local agents.
  - Settled: stop and save on close; resume the latest conversation for the launch directory; explicit new-conversation command.
  - Settled: central user-profile storage associated with the launch directory.
  - Settled: use current config on resume and allow explicit reload while idle.
  - Settled in Q31: keep the room running when one agent fails; retain pending messages and reconnect explicitly without silently replaying completed work.
  - Settled in Q38-Q39: pending work stays paused after restoration; interrupted turns require retry; restore a fresh provider session from shared history if native resume is unavailable and disclose the reset.
  - Settled in Q44: restore fresh sessions for agents whose provider, model, or custom instructions change; disclose the reset and preserve unchanged agents' sessions. Apply permission changes before further work.
- Milestone: personal pilot followed by open-source release.
  - Settled in Q45: macOS pilot, CLI compatibility and permissions verified before the full interface. Public distribution, licence choice, and additional operating systems follow the pilot.

All interview decision branches are resolved or explicitly deferred beyond the pilot. Concrete command spellings, activity labels, storage layout, and acceptance scenarios are included in `PILOT_PLAN.md` for the final shared-understanding review. Provider compatibility remains work to verify during the agreed first implementation phase, not an assumed result.

The interview is complete. The user confirmed the plan and authorized the TypeScript implementation.

## First experience to evaluate

Launch from a project directory, see the configured participants become available, and send a message. See receipt and activity without losing the ability to type. Let the agents exchange a useful follow-up directly, then send a correction while they are active. End with a clear sense of who is responding, who is working, and who is waiting.

This evaluation scenario informed the personal pilot. Automated validation covers the mechanical behavior; a broader usability pass follows.
