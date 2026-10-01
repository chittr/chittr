# Contributing

Thanks for looking at AI Chat. This is a personal pilot maintained by one person,
Bill ([@mcgloneb](https://github.com/mcgloneb)), in public preview. Contributions are
welcome on a best-effort basis; please read [SUPPORT.md](SUPPORT.md) for what that
means before you invest a lot of time.

## Contribution terms

Contributions are inbound-equals-outbound: what you send in is offered under the same
MIT terms the project is released under. There is no CLA and no DCO sign-off. You keep
copyright in your contribution and grant the project the same licence everyone else
receives.

The project is released under the [MIT licence](LICENSE).

## Before you start

Open an issue before writing a substantial change. A short description of the problem
and the direction you want to take is enough. Bill decides what is in scope; see
[the roadmap](docs/roadmap.md) for what is already planned and
[FEATURES.md](FEATURES.md) for what currently ships. Roadmap decisions are Bill's and
are recorded on the roadmap or on the relevant issue, not settled in pull request
threads.

Small, obviously-correct fixes — a broken link, a typo, a narrow bug with a test — do
not need a prior issue.

Issues labelled [`good first issue`](https://github.com/chittr/chittr/labels/good%20first%20issue)
and [`help wanted`](https://github.com/chittr/chittr/labels/help%20wanted) are the
best first contributions. `bug`, `enhancement`, `documentation` and `accessibility`
describe the kind of work; `unplanned` means captured but not scheduled. Labels
beginning `agent-ready`, `in-progress`, `pending`, `review`, `blocked`, `done`,
`complexity:`, `engine:`, `dev:` and `review:` are Bill's automation state and are not
for contributors to set.

## Getting oriented

Do not read the whole tree. Start with the navigation that already exists:

- [Architecture map](docs/architecture.md) — module responsibilities and dependency
  boundaries.
- [Maintenance guides](docs/maintenance.md) — the task-shaped route for rendering
  changes, room commands, provider maintenance and saved-data evolution.
- [Quality checks](docs/quality.md) — optional local checks and their prerequisites.
- [Validation and known limits](docs/compatibility.md) — what is actually verified and
  what is not.

[AGENTS.md](AGENTS.md) is the same navigation in the form CLI agents read.

## The contribution loop

1. Fork `chittr/chittr` on GitHub and clone your fork.
2. Branch from `main`. Any descriptive branch name is fine.
3. Make the change and add or update tests at the boundary the change touches. The
   maintenance guides name the focused test file for each area.
4. Run checks that cover the changed behavior and report the results. The full Quality suite is optional for this preview.
5. Push to your fork and open a pull request against `chittr/chittr` `main`.
6. Fill in the pull request template: what changed, why, and the check output you got.
7. Bill reviews. Expect review comments rather than silent edits to your branch.

## Checks you can run

The optional Quality suite runs without a provider login, without paid
subscription allowance, and without any of Bill's maintainer tooling. It requires macOS,
Node.js 22.12 or newer, and Python 3 for the PTY probes.

```sh
npm ci
npm run browser:install
unset CHITTR_BROWSER
npm run quality
```

`npm run quality` runs type checks, the build, the deterministic Vitest suite,
formatting, the browser suite in bundled Chromium, the terminal and resume PTY probes,
and the native macOS security probes, stopping at the first failure.
[docs/quality.md](docs/quality.md) lists each command, what it covers and its
prerequisites. While iterating, run the focused command the relevant maintenance guide
names instead of the whole suite.

Hosted Quality is disabled and is not a merge or first-release requirement. The
public release tree omits its workflow. See [docs/quality.md](docs/quality.md) for
optional local checks; record skipped checks as skipped.

Some checks are **not** part of this loop and are not expected from contributors. The
`test:live`, `test:skills:live`, `test:room`, `test:interrupt`, `test:trusted` and
`test:compaction` scripts drive real provider CLIs and consume subscription allowance.
They need separate authorization, and they are not run on pull requests. Do not add a
change whose only verification is one of those scripts without saying so in the pull
request. The deployment instructions under `.agents/skills/` are Bill's maintainer
documentation and are not a contributor step.

## Agent-assisted contributions

Contributions written with the help of a CLI coding agent are welcome and do not need a
different process from any other contribution. Two things are expected:

- **Say so.** Note in the pull request that an agent helped and which one. This is
  disclosure, not a penalty.
- **Stand behind it.** You are the contributor. Review the diff yourself, run the checks
  yourself, and be able to explain the change in review. "The agent wrote it" is not an
  answer to a review question.

When an agent authors commits, preserve that authorship rather than rewriting it to your
own name. What matters is Git's author field: keep the commits the agent made, or set the
field explicitly with `git commit --author`. Do not replace them with a commit you author
and then add a `Co-Authored-By:` trailer — a trailer adds credit alongside the author, it
does not preserve the author, and a squash or a fresh commit that carries only a trailer
has already lost the authorship this asks you to keep.

Bill also runs agents against this repository. Those agents contribute as ordinary
public forks with no upstream write access. Where Bill pushes an agent-authored branch
and opens the pull request manually, the agent remains the commit author and Bill is the
one accountable for the merge. That route is normal and does not make the change
exempt from review or from the checks above.

## Review expectations

Bill is the only reviewer and the only person who merges. There is no second maintainer
and no service-level commitment. Expect a first response in days rather than hours, and
longer during quiet periods. A pull request that sits is not a judgement on it; ping the
thread if it has gone quiet.

What gets a change merged:

- It solves a problem described in an issue or obvious from the diff.
- It stays inside the boundaries the [architecture map](docs/architecture.md) sets.
- It has a test at the seam it changes, or a clear statement of why one is not possible.
- The pull request records affected checks and their results. Full Quality is optional for this preview.
- Documentation that would become wrong is updated in the same change.

What gets a change sent back: a refactor bundled with a fix, a new dependency without a
reason, a claim in the documentation that the tests do not support, or a change to
provider-support wording that is not backed by an observed run.

## Reporting things

| What you have                         | Where it goes                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| A bug in the software                 | A public [issue](https://github.com/chittr/chittr/issues), using the bug form |
| A security vulnerability              | Privately — see [SECURITY.md](SECURITY.md). Never a public issue                 |
| A question or help request            | [SUPPORT.md](SUPPORT.md)                                                         |
| Behaviour by a person in this project | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)                                         |

Support requests and conduct reports are different channels with different handling.
Please do not route one through the other.
