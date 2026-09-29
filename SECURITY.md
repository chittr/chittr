# Security policy

AI Chat is a personal pilot in public preview, maintained by one person, Bill
([@mcgloneb](https://github.com/mcgloneb)). Bill is the security contact and handles
reports himself. There is no security team, no backup contact and no response-time
commitment.

## Supported versions

Only the current `main` branch is supported. There are no maintained release branches
and no backported fixes. A fix ships on `main`; there is no separate advisory-driven
patch stream.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.**

Use [GitHub's private vulnerability reporting](https://github.com/chittr/chittr/security/advisories/new).
Bill monitors that inbox manually. GitHub controls advisory access; the report
is not a public issue. There is no response-time promise or separate email route.

Please include what you would want to receive: the affected version or commit, the
configuration and permission mode in use, the steps to reproduce, and what an attacker
gains. A proof of concept that runs locally is more useful than a description.

What to expect: an acknowledgement when Bill sees the report, a first assessment after
that, and a fix on `main` if the finding is confirmed and in scope. Timing is
best-effort. There is no bug bounty and no paid reward.

Please give Bill a reasonable window to respond before disclosing publicly. If you get
no acknowledgement at all, say so on the advisory thread rather than escalating to a
public issue.

## What is in scope

AI Chat runs locally on your machine and drives coding-agent CLIs that you have already
installed and signed in. It stores conversations, configuration and attachments on your
filesystem, and it serves a browser interface on loopback. Reports about these are in
scope:

- The local browser interface: loopback binding, request authentication, token and
  cookie handling, `Host`/`Origin`/fetch-site checks, rendering of untrusted transcript
  or attachment content.
- The permission and tool boundary: workspace roots, path traversal and symlink
  handling, skill discovery and skill-write denials, command modes, and any path by
  which an agent reaches outside the launch directory it was granted.
- Provider process handling: the environment handed to provider CLIs and MCP children,
  subprocess lifecycle and cleanup, and anything that leaks credentials the host can
  see.
- Stored data: conversation, snapshot and attachment files, their filesystem
  permissions, retention and deletion.
- The published build and its dependency tree.

## What is not a vulnerability

- **An agent doing what it was permitted to do.** Launching in a directory grants the
  room that directory. Enabling sandboxed or trusted commands grants the corresponding
  reach. Configuring an instruction file outside the workspace loads that file. These
  are documented choices, not flaws. A report that a _different_ permission mode is
  reachable than the one configured is in scope.
- **Prompt injection changing what a model says.** Content in a workspace, an
  instruction file or a skill can influence model output. That is inherent to running
  models over untrusted material. A report is in scope when injected content crosses a
  boundary the host is supposed to enforce — reading a file outside the granted roots,
  running a command the mode forbids, or reaching a credential.
- **Findings in the provider CLIs or their services.** Codex, Claude Code, Grok Build
  and Antigravity are separate products with their own reporting channels. Report those
  to their vendors. A report about how AI Chat _invokes_ them is in scope.
- **Anything requiring an attacker who already has your user account** on the machine.
  The trust boundary starts below that.

## Preview limitations

This is a pilot, not a hardened product, and this policy does not claim otherwise.

- The preview targets the Apple Silicon Mac configuration described in
  [installation](docs/installation.md). Other configurations are untested for this release.
- The project collects no API keys and does not use a hosted SDK. It relies on the
  subscription logins already present in the provider CLIs, and on those CLIs' own
  enforcement. What each provider receives and retains is governed by that provider's
  terms.
- Verified behaviour and known gaps are recorded in
  [docs/compatibility.md](docs/compatibility.md). A security claim not backed by a check
  recorded there should be treated as unverified.
- No complete security audit or full Quality pass is claimed for this preview.
  Read [privacy and permissions](PRIVACY.md) before enabling providers or tools.

## Other reports

Bugs that are not security-relevant go to the public
[issue tracker](https://github.com/chittr/chittr/issues). Questions and help requests
go through [SUPPORT.md](SUPPORT.md). Conduct concerns go through
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md); private vulnerability reporting is not the
conduct channel.
