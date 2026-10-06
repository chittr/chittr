# Chittr

Chat with Codex, Claude Code and Grok Build as named peers in one local room, in your terminal or browser.

[![npm](https://img.shields.io/npm/v/@chittr/cli)](https://www.npmjs.com/package/@chittr/cli)
[![MIT licence](https://img.shields.io/npm/l/@chittr/cli)](LICENSE)
[![Node](https://img.shields.io/node/v/@chittr/cli)](docs/installation.md)
[![Platform: macOS on Apple Silicon](https://img.shields.io/badge/platform-macOS%20on%20Apple%20Silicon-lightgrey)](docs/installation.md)

[Website](https://chittr.dev) · [Install](#install) · [Quick start](#quick-start) ·
[Documentation](#documentation) · [Contributing](#contributing)

<!-- TODO: hero graphic, supplied by the maintainer. -->

Choose your participants and launch a room in your project. Agents can inspect the launch
directory, ask each other questions, contribute concurrently or pass. Each participant has its
own visible activity and queue.

- **Named peers in one room.** Address agents with `@names` or invite the whole room. Agents
  answer with a contribution or a pass with its rationale. See [conversation](docs/usage.md#conversation).
- **Terminal and browser.** Both interfaces use the same workspace, configuration and saved
  sessions. Terminal messages render Markdown headings, emphasis, lists, quotes, code and
  tables. Selection copies rendered text, preserves paragraph newlines and sanitized code
  indentation (tabs become four spaces), and joins visual wraps. Narrow tables use labelled
  fields; unfinished syntax stays readable. Code has language labels but no syntax highlighting.
  See [terminal keyboard and copying](docs/usage.md#terminal-keyboard) and the
  [browser interface](docs/usage.md#browser-interface).
- **Permissions you grant.** Edits, commands and task networking apply to the whole room and
  start disabled. Commands run sandboxed unless you opt into trusted commands. See
  [permissions](docs/configuration.md#permissions).
- **Your roster in YAML.** Choose each participant's provider, model, effort and instructions.
  See [participants](docs/configuration.md#participants).
- **Provider skills.** Each agent receives a catalogue of its provider's installed skills. See
  [skills](docs/configuration.md#skills).
- **Images.** Paste, drop or attach images in the browser. See
  [images](docs/usage.md#images).
- **Questions, pins and compaction.** Answer agents' questions, ask the room for advice, pin
  messages and compact an agent's context. See
  [questions](docs/usage.md#questions-and-ask-the-room), [pins](docs/usage.md#pins) and
  [context compaction](docs/usage.md#context-compaction).
- **Saved conversations.** Every chat is saved; resume one from the same directory. See
  [saved conversations](docs/usage.md#saved-conversations-and-recovery).

> **Early preview.** This is an early hobby-project preview for macOS on Apple Silicon. Other
> macOS and Node versions, Intel, Linux and WSL2 are untested. Chittr needs Node.js 22.12.0
> or newer and installed provider CLIs with subscription logins for Codex, Claude Code and
> Grok Build. API-key authentication is not supported. Gemini/Antigravity is outside this
> launch's support scope.
>
> Read [privacy and permissions](PRIVACY.md) before sharing files or enabling tools.
> Permissions apply to the whole room, so inspect a project's `.agents/chittr.yaml` before
> launching in an unfamiliar project. [Trusted commands](docs/configuration.md#trusted-commands)
> run without Chittr's command sandbox, with your account's access.

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

[Install and recover Chittr](docs/installation.md) lists the versions the first-preview
rehearsal used, and covers setup, permissions, backup, reinstall and rollback.

## Quick start

Run Chittr from the directory agents should work in:

```sh
cd ~/Projects/your-project
chittr            # start a new chat in the terminal
chittr --web      # start a new chat in the browser
chittr resume     # pick a saved chat from this directory
chittr doctor     # check configured providers without a chat turn
chittr update     # update this npm-global installation after closing rooms and backing up
```

When no config exists, interactive setup offers to create `~/.agents/chittr.yaml` and asks
which supported providers to enable. The launch directory is the room's task workspace;
Chittr does not search upward for a Git root or project config. Then see
[use Chittr](docs/usage.md) and [configure Chittr](docs/configuration.md).

## Documentation

- [Install and recover Chittr](docs/installation.md): installation, first-time setup, backup,
  upgrade, rollback, and provider and image limits.
- [Configure Chittr](docs/configuration.md): configuration files, participants, models and
  effort, instructions, permissions, trusted commands and skills.
- [Use Chittr](docs/usage.md): the browser and terminal interfaces, addressing, questions,
  keyboard, room commands, saved conversations, recovery and context compaction.
- [Changelog](CHANGELOG.md): what changed in each release.
- [Privacy and permissions](PRIVACY.md): what leaves your Mac, what stays, and what you grant
  agents.
- [Compatibility and validation](https://github.com/chittr/chittr/blob/main/docs/compatibility.md):
  what is verified and what is known not to work.
- [Roadmap](https://github.com/chittr/chittr/blob/main/docs/roadmap.md).
- [Architecture](https://github.com/chittr/chittr/blob/main/docs/architecture.md),
  [maintenance guides](https://github.com/chittr/chittr/blob/main/docs/maintenance.md) and
  [Quality checks](https://github.com/chittr/chittr/blob/main/docs/quality.md) for contributors.

## Contributing

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

## Development

From a source checkout, install dependencies and build:

```sh
npm ci
npm run build
```

`npm run dev` builds the workers and browser assets before opening the TypeScript
entrypoint; `npm run dev -- --web` opens the browser UI. An installed package already
contains the runtime and browser assets.

[CONTRIBUTING.md](https://github.com/chittr/chittr/blob/main/CONTRIBUTING.md#checks-you-can-run)
lists the checks contributors can run. The
[Quality guide](https://github.com/chittr/chittr/blob/main/docs/quality.md) lists each
optional check and its prerequisites, including Python 3 for the PTY probes,
`CHITTR_BROWSER` and the outer-sandbox limit on the security probes. The full suite and
hosted Quality are skipped for this preview; use focused checks for behavior you change. The
PTY test uses deterministic peers. Browser tests use Playwright and an isolated clipboard
fixture.

The following live-provider checks consume subscription allowance and require
separate authorization. They are not part of CI or `npm run quality`.

```sh
npm run test:trusted -- /absolute/path/to/gh-codex # live provider turns and read-only GitHub identity check
npm run test:live        # installed subscription CLIs; disposable fixture files
npm run test:skills:live # both CLIs read symlinked skills and supporting files
npm run test:room        # real peer discussion, correction, and passes
npm run test:interrupt   # interrupt each real CLI after receipt
```

`test:trusted` uses one operator-selected identity wrapper across selected provider transports. Append provider names to choose the supported launch providers. It checks the registered login and records whether authentication uses the launch environment or Keychain fallback, without printing credentials. It does not assign that test identity to participants in ordinary chats.

The room engine, provider adapters, tool enforcement and interfaces are separate
modules. See [architecture](https://github.com/chittr/chittr/blob/main/docs/architecture.md)
for source navigation.

## License

Chittr is [MIT licensed](LICENSE); bundled libraries retain their
[third-party notices](THIRD_PARTY_NOTICES.md).
