# Configure Chittr

This guide covers Chittr's YAML configuration, participants, room permissions, trusted commands and skills. [Install and recover Chittr](installation.md) covers installation, recovery and provider limits, and [privacy and permissions](../PRIVACY.md) explains what each grant exposes.

## First-run setup

When no config exists, interactive setup offers to create `~/.agents/chittr.yaml`. It detects installed CLIs and requires you to choose which to enable. Nothing is selected automatically. Setup saves your choices under `defaultAgents`, with no model overrides or stock custom instructions. No personal config ships with the app. [Install and set up](installation.md#install-and-set-up) lists the providers to choose for this preview and the permissions setup starts with.

After setup, `chittr doctor` checks the configured supported providers and the tool sandbox without a chat turn. It does not prove that a model can answer or that its terms permit your use. Chat responses and the optional live tests use your normal subscription allowance.

## Configuration files

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

## Your display name

Set `human.name` in `~/.agents/chittr.yaml` to choose how you appear in the transcript and composer. Agents receive the current name on every turn so they can address you by name. Project config can override it; omission inherits your user setting, or defaults to `You` when neither file sets a name. Setup asks for the name when creating a user config. Changes apply on launch/resume or idle `/reload`, including the labels on existing messages.

`@human` remains the addressing token for you, and autocomplete labels it with your name. Saved conversations keep a stable identity, so changing your display name does not create a new participant or lose history.

## Participants

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

## Models and effort

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

## Several providers in one room

See [the three-provider project example](../examples/three-providers.yaml) to use Codex,
Claude and Grok together. They use the same room permissions, instruction sources,
queues and terminal/browser controls.

## Custom instructions

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

## Migrating an older user config

To migrate an existing user config, rename its top-level `agents` key to `defaultAgents`, preserving its contents. The old user-level key remains supported as a fallback alias; files are never rewritten automatically. Defining both keys in user config is an error. Existing project configs that relied on partial agent overrides must now specify `provider` and any desired agent settings themselves. The legacy `instructions.mode` field remains accepted, but sources no longer merge across user and project rosters.

## Permissions

Permissions apply to the **whole room**, and project config can grant them directly. Before launching in an unfamiliar project, read [what you grant agents](../PRIVACY.md#what-you-grant-agents). For example:

```yaml
version: 1
permissions:
  edits: true
  commands: false
  network: false
```

Edits, sandboxed shell commands, and task networking are independent grants. File inspection works with all three off. Agents explain missing permissions and ask for a YAML change followed by idle `/reload`; there are no temporary chat approvals. Provider authentication and inference traffic are separate from task networking. See [privacy and permissions](../PRIVACY.md) for the trust boundaries.

## Trusted commands

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
