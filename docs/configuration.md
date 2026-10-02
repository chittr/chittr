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

Set top-level `instructions.sources` once to give every room participant shared guidance. Keep agent-specific sources for individual roles. Sources are read in their listed order. For example:

```yaml
# <launch directory>/.agents/chittr.yaml
version: 1
instructions:
  sources:
    - file: instructions/room.md
    - text: Discuss proposals before making changes.
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

The project room block replaces the user room block as a whole. Omitting it inherits the user block; `instructions: {}` or `instructions: {sources: []}` clears it. This selection is independent of the roster: a project config with only shared instructions uses your default agents. Agent definitions still come only from the selected roster, and their instructions remain self-contained.

Those file references resolve beside the YAML, for example `.agents/instructions/room.md`. Absolute paths and `~/` paths also work. These are explicit configuration inputs and may be outside the task workspace; reading them does not require task-tool permission. Only selected room and agent sources are read, on launch, resume or idle `/reload`. Unknown fields and unreadable selected files produce configuration errors. Each file has a 1 MiB UTF-8 limit. That limit validates an individual file, not the aggregate provider prompt; existing transport limits can still make a participant unavailable.

For a brief belonging to one conversation, launch with `chittr --instructions-file ./review-brief.md`. Chittr reads the file once and saves its text with the conversation. See [launch with a shared brief](usage.md#launch-with-a-shared-brief) for path rules, valid flags and the lifecycle table.

The prompt labels YAML room instructions, the saved conversation brief and agent instructions separately. Within custom guidance, the saved brief takes precedence over room YAML, then agent instructions. This is prompt guidance, not guaranteed model compliance. Provider guidance, the required room protocol and actual tool permissions remain authoritative; instructions grant no extra permissions or routing authority.

`/config` shows the selected room YAML source, including an explicit clearing override, and whether the conversation has a saved brief and its origin. Editing shared YAML and running idle `/reload` restarts affected participants with current instructions and public history. It retains the saved brief. Agent-only instruction changes restart only that participant.

## Migrating an older user config

To migrate an existing user config, rename its top-level `agents` key to `defaultAgents`, preserving its contents. The old user-level key remains supported as a fallback alias; files are never rewritten automatically. Defining both keys in user config is an error. Existing project configs that relied on partial agent overrides must now specify `provider` and any desired agent settings themselves. The legacy `instructions.mode` field remains accepted, but sources no longer merge across user and project rosters.

## Permissions

Permissions apply to the whole room. There are three, and all start off:

```yaml
version: 1
permissions:
  edits: true # write_file, and command writes inside the workspace
  commands: true # run_command
  network: false # fetch_url, and command network access
```

With all three off, agents can still talk and read files in the launch directory. Each grant is independent. With `commands: true` and `edits: false`, commands can read the workspace but not change it. `network` covers task traffic only. Provider login and inference traffic don't depend on it.

User config loads first, then the project's `.agents/chittr.yaml`. Each key in the project file replaces the user value. A project can grant permissions you didn't, so read its config before launching in an unfamiliar project. [What you grant agents](../PRIVACY.md#what-you-grant-agents) lists what each grant exposes.

Agents can't ask for a permission mid-conversation. They explain what's missing, and you change the YAML and run `/reload` while the room is idle.

### Command modes

`run_command` runs in one of three modes. `/config`, the terminal banner and the browser show the current one.

| Mode        | When                                                                | Commands run                                                                                    |
| ----------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `off`       | `commands: false`                                                   | Not at all                                                                                      |
| `sandboxed` | `commands: true`                                                    | In Chittr's macOS sandbox, limited to the workspace and the room's `edits` and `network` grants |
| `trusted`   | All three permissions `true`, plus a trust grant for this workspace | As your user account, with no sandbox                                                           |

## Trusted commands

Sandboxed commands work for builds and tests that stay inside the workspace. They can't use your accounts. They can't read the rest of your home directory, and Chittr starts them with only `PATH`, `LANG` and `TMPDIR` set, so `HOME`, tokens and your SSH agent are missing. Homebrew's `bin` directory isn't on their `PATH`. Commands that rely on your logins, such as `gh pr create` or `git push` over SSH, fail.

Trusted commands run without the sandbox. They run through `/bin/sh` in the launch directory as your user, with your filesystem access, network access, existing logins and exported environment. They can read and write outside the workspace, including skill bundles. Interactive aliases and unexported functions are unavailable, and Chittr doesn't source shell startup files. Normal macOS restrictions, expired logins and Keychain prompts still apply. Provider connections keep their credential filters. Only developer commands get the unfiltered environment.

### Granting trust

Only your user config can grant trust, one workspace at a time:

```yaml
# ~/.agents/chittr.yaml
trustedCommands:
  workspaces:
    - ~/Projects/your-project
```

Each entry matches the launch directory's exact realpath. Subdirectories and other worktrees need their own entries. Chittr rejects `trustedCommands` in project config, and `permissions.commands` stays a boolean in both files. A project can't grant itself trust.

For a single launch, pass `--trusted-commands` to `chittr`, `chittr resume` or `chittr --web`. The flag writes no configuration.

### Why trust needs all three permissions

A trust grant adds no permission of its own. Without the sandbox, `edits` and `network` can't limit what a command does. Chittr therefore activates trust only when all three are already `true`, so a room set to `network: false` never runs commands that can reach the network.

If a permission is off, the result depends on where trust came from:

- With a `trustedCommands` entry, trust stays inactive. Commands fall back to `sandboxed`, or to `off` if `commands` is false. `/config`, the banner and the browser name the blocking permission and the file that set it.
- With `--trusted-commands`, Chittr refuses to launch and lists the disabled permissions.

Project config overrides permissions, so a project can switch trust off for its room. `commands: false` makes the room discussion only. Turning off `edits` or `network` keeps commands sandboxed. It also works the other way. If your user config leaves a permission off and the project turns all three on, your grant for that workspace activates. Read a project's config before you add it to `workspaces`.

### What trust leaves alone

`read_file`, `write_file` and `list_files` keep the same limits in every mode. They reach only the launch directory and read-only skill bundles. Those limits don't apply to trusted commands. A room with `commands: true` and no grant or flag stays sandboxed.

### Reloading and resuming

Run `/reload` while idle after changing a grant. A mode change restarts participants with current tools and instructions, then restores the public conversation. Resume and `/sessions ID` recompute the mode from current settings and this process's launch flag. A saved conversation can't bring back an old grant or a previous launch's flag. Chittr captures the environment once at launch, so relaunch to pick up exported changes.

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
