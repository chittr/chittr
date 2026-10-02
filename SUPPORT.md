# Support

AI Chat is maintained by one person, Bill ([@mcgloneb](https://github.com/mcgloneb)), as
a personal pilot in public preview. Support is best-effort. There is no service-level
agreement, no support contract, no backup maintainer, and no guarantee that any
particular request gets a reply. Please size your expectations accordingly before
depending on this project.

## Before asking

Most questions are already answered:

- [README](README.md) — what it is, how to install it and start it in the terminal and the
  browser, and where each guide lives.
- [Install and recover Chittr](docs/installation.md) — which provider CLIs and versions were
  exercised, setup, backup, upgrade and rollback.
- [Configure Chittr](docs/configuration.md) and [use Chittr](docs/usage.md) — configuration,
  permissions, trusted commands, skills, the browser and terminal interfaces, room commands,
  saved conversations and context compaction.
- [Quality checks](docs/quality.md) — the supported macOS and Node matrix, exact tool
  versions, and the fresh-checkout procedure.
- [Validation and known limits](docs/compatibility.md) — what is verified and what is
  known not to work, including the image-support status.
- [Architecture map](docs/architecture.md) and [maintenance guides](docs/maintenance.md)
  — for questions about the code.
- [Roadmap](docs/roadmap.md) — for "will you add…".

`ai-chat doctor` checks CLI compatibility, authentication and the tool sandbox without
making a model call. Run it first when something will not start; its output is the most
useful thing to paste into a report.

## Where to go

| What you have                         | Where it goes                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| "How do I…" or "is this supposed to…" | A [question issue](https://github.com/chittr/chittr/issues/new/choose)                          |
| Something is broken                   | A [bug issue](https://github.com/chittr/chittr/issues/new/choose), with `ai-chat doctor` output |
| A feature idea                        | A [feature issue](https://github.com/chittr/chittr/issues/new/choose)                           |
| Wrong or missing documentation        | A [documentation issue](https://github.com/chittr/chittr/issues/new/choose)                     |
| A security vulnerability              | Privately, via [SECURITY.md](SECURITY.md). Never a public issue                                 |
| Behaviour by a person in this project | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)                                                        |
| You want to change the code           | [CONTRIBUTING.md](CONTRIBUTING.md)                                                              |

Support and conduct are separate channels with separate handling. A frustrating support
experience is not a conduct report, and a conduct report should not be filed as a public
support issue.

There is no chat server, mailing list or forum. The issue tracker is the only public
channel.

## What support looks like

Bill reads the tracker, reproduces what he can on the supported platform, and fixes what
he judges worth fixing. In practice:

- Reports that reproduce on macOS on Apple Silicon, on a supported Node version, with
  `ai-chat doctor` output attached, get the furthest.
- Reports about unsupported platforms, unsupported provider CLI versions, or provider
  behaviour outside this project are usually closed with a pointer rather than fixed.
- A problem inside Codex, Claude Code, Grok Build or Antigravity themselves belongs to
  that vendor. This project can only change how it invokes them.
- Live-provider checks consume paid subscription allowance, so Bill cannot always
  reproduce a provider-specific report on demand.
- Expect days rather than hours, and quiet periods. Issues are not closed for
  inactivity.

The fastest route to a fix is usually a pull request. See
[CONTRIBUTING.md](CONTRIBUTING.md); the checks that gate a pull request need no provider
login and no paid allowance.
