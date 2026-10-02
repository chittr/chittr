# Install and recover Chittr

The first-preview rehearsal passed on an Apple Silicon Mac running macOS 26.2
with Node 24.18.0 and npm 11.16.0, using Codex CLI 0.159.0, Claude Code 2.1.284
and Grok Build 1.0.34 with provider-default models.
The package declares Node 22.12.0 as its minimum; other Node
and macOS versions, Intel, Linux and WSL2 are untested for this release. The full
Quality suite and broader platform matrix are skipped for this preview.

## Install and set up

Install Node.js and your chosen provider CLIs separately. Sign in with your own
subscription using [Codex](https://developers.openai.com/codex/cli/),
[Claude Code](https://code.claude.com/docs/en/overview) or
[Grok Build](https://docs.x.ai/build/overview). All three integrations use subscription
logins; API-key authentication is not supported. Gemini/Antigravity is outside this launch's support scope.
Provider installation and account terms belong to their vendors.

```sh
npm install -g @chittr/cli
chittr --version
cd /absolute/path/to/your/workspace
chittr
```

Use `chittr --help` for command options. If your shell cannot find `chittr`, add
`$(npm prefix -g)/bin` to its PATH. If npm reports a permissions error, use a
[user-writable npm installation](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)
instead of running Chittr as root.

First-time setup requires an interactive terminal and asks which installed
providers to enable. Choose only Codex, Claude and Grok for this preview; leave
Antigravity unselected if it appears. It creates `~/.agents/chittr.yaml` with file
inspection and discussion permissions. Commands, edits and network access start disabled.
The project configuration is `<launch directory>/.agents/chittr.yaml`.
Project configuration can override permissions. Inspect it before launching in an
unfamiliar workspace. After setup, `chittr doctor` checks configured providers and
`/config` shows effective settings. Doctor does not establish that a model response
will work.
Use the packaged [user](../examples/user.yaml) and
[project](../examples/project.yaml) examples when configuring manually.
Instruction file paths resolve relative to the YAML that names them.

Chittr does not read old `ai-chat.yaml` files or automatically migrate pilot
sessions. There is no `ai-chat` executable alias. Start fresh with Chittr.
Existing pilot files can remain in place. An explicit `--state-dir` selects any
storage base you choose; it is not a migration command or a compatibility promise.
Keep credentials in the provider CLIs, not in YAML or conversations. Read
[privacy and permissions](../PRIVACY.md) for provider data flows, local storage
and trusted-command access.

From the same workspace, use `chittr --web` for the browser and
`chittr resume ID` to reopen a saved conversation. Closing a browser tab leaves
the host process running. Quit through the application or stop its terminal
process before replacing an installation or copying storage.

## Reinstall or uninstall

Close every running Chittr process first. Uninstall removes the executable and
package, while configuration and conversation data remain in place. To reinstall
the identified 0.2.0 release:

```sh
npm uninstall -g @chittr/cli
npm install -g @chittr/cli@0.2.0
```

Reopen from the same canonical workspace directory using the same storage base.
The default is `~/.agents/chittr/sessions/<workspace-id>/<session-id>/`.
`--state-dir PATH` replaces the base before the workspace directory is appended.
Launching from another directory selects another workspace, even if both
directories belong to the same Git repository. Saved permissions never authorize
the current launch; current configuration applies when a conversation reopens.

Missing web assets, a file worker or a policy hook indicate an incomplete or
damaged install. Reinstall the same identified version and run `doctor` again.
For provider errors, follow the reported provider login or policy diagnosis.
An unsupported policy check must pass before that participant can connect.
Reinstallation does not remove provider-owned credentials or native sessions.

## Back up and restore

Close all processes that own the storage. Verify that no workspace directory
contains `room.lock`; a copy with a live lock is not a completed backup.
Do not delete a lock to bypass a running process.

Keep a private backup of both YAML layers, any instruction files they reference,
and the complete storage base. Preserve configuration-relative file locations,
or update the restored YAML references deliberately. The storage recovery unit
includes `latest.json`, all session records, attachment indexes and every blob.
A session JSON file alone is insufficient. For the default base, after stopping
the processes, a backup into a new directory can use:

```sh
mkdir -m 700 /absolute/private/chittr-backup
cp -Rp "$HOME/.agents/chittr/sessions" /absolute/private/chittr-backup/sessions
cp -p "$HOME/.agents/chittr.yaml" /absolute/private/chittr-backup/user.yaml
cp -p /absolute/workspace/.agents/chittr.yaml /absolute/private/chittr-backup/project.yaml
```

Copy only configuration files that exist, and back up their referenced
instructions separately. For custom storage, substitute its complete base.
Keep the backup outside the task workspace and restrict its access; it contains
conversation text, drafts and attachment bytes.

Restore into a new storage base and retain the original:

```sh
cp -Rp /absolute/private/chittr-backup/sessions /absolute/private/chittr-restored
cd /absolute/path/to/the/original/workspace
chittr resume ID --state-dir /absolute/private/chittr-restored
```

The selected path is the base, not its workspace-id subdirectory. Restore
configuration and instruction files to their original layout only after
preserving the current files and reviewing the permissions you intend to grant.
Check messages, draft text, attachment references and retrieved bytes in the
restored conversation before adopting it.

Server-persisted drafts are part of session storage. Browser-local sessionStorage,
pending request receipts and uploads that never reached the server are not in a
filesystem backup. Check unresolved browser sends before closing the original
tab; a backup cannot reconstruct its local recovery state.

## Upgrade and roll back

Before upgrading, stop Chittr and make the complete backup above. Record the
installed version with `chittr --version`. Install an identified release, then
reopen from the same workspace and check messages, drafts and attachments.

If a release fails, quit Chittr and preserve its data. Install a known working
version, for example `npm install -g @chittr/cli@0.1.0` when 0.1.0 is the version
you previously used successfully. With no known working release, keep your backup
and wait for a fixed version. Deprecating an npm version does not repair copies
already installed; users still need to install a replacement.

Direct downgrade is supported only for a build pair whose saved-data behavior
has been verified. An older build may reject newer records. Do not edit version
fields or try a downgrade against your only copy. Restore the matching backup
into a separate storage base and open it with its original version. Keep newer
data separately; the restored backup omits everything created after it.
The historical pilot is not a previous Chittr release.

## Provider and image limits

Codex, Claude Code and Grok Build use version-sensitive native protocols. A CLI
upgrade, a changed model or a successful login does not establish compatibility.
After a provider upgrade, run `chittr doctor` with your configured roster and
check an ordinary conversation before relying on it. Text startup checks reject
unsupported policies. The Codex adapter requires CLI 0.153.0 or newer; other
runtime requirements still apply. No provider binary is bundled with Chittr.

The host accepts PNG attachments of up to 3 MiB each, 20 images and 6 MiB per
message. The browser converts any image it can decode to PNG and scales it down
to at most 2000 px on the long edge, further if needed to fit 3 MiB; a
non-interlaced PNG already within both limits uploads unchanged. Terminal
uploads (`/attach` and the clipboard) are not resized and must already be PNGs
within the limits.

Images need no room configuration: permissions, skills and command mode do not
change image delivery, so the default room can send images. Eligibility depends
on the active provider session:

- Codex needs verified native policy, the same checks that admit the thread at
  startup, and an observed model and effort. Fresh and resumed threads qualify.
- Claude can receive images from connection, including in the first message. A
  turn whose native tool inventory lists an unexpected tool is aborted, and an
  inventory that fails verification closes images until the next passing turn.
  Checkpoint replacement and historical image retrieval after restart remain
  outside verified coverage.
- Grok needs verified native tools, its isolated-room runtime contract, a reported
  model and a recognized live CLI identity. Legacy Grok 1.0.13 is restricted to
  a room with all task permissions and skills off.
- Antigravity has no image route.

When a staged image's recipient can't receive it, the composer says so per
recipient; the browser's **Details** and the terminal's `/attach --status` show
the reason, and `/participants` lists every agent's status. A stored
thumbnail proves local storage, not delivery to a provider. If a recipient cannot
receive an image, the whole message including its caption is withheld from that
recipient and the reason is shown. The agent can still receive text-only messages.
A model without image capability can fail at delivery. An eligible runtime is
not a claim that every CLI/model/effort combination has been visually tested.

Native provider sessions are separate from Chittr's saved conversation. On
restart, Grok restores public history in a fresh session. Codex can also restore
public history when native resume is unavailable. Rebuilding context can consume
subscription turns. Saved Chittr attachments remain local even when provider-side
image continuity is unavailable.

## Package contents

The npm package includes built runtime modules and workers, browser assets,
configuration examples, this guide, the [configuration](configuration.md) and
[usage](usage.md) guides, the README, [changelog](../CHANGELOG.md),
[MIT licence](../LICENSE), [third-party notices](../THIRD_PARTY_NOTICES.md) and
[privacy disclosures](../PRIVACY.md). It contains no provider CLI binaries,
personal configuration, private evidence, tests or development scripts.
Source maps and TypeScript declarations are excluded. Source is at
[chittr/chittr](https://github.com/chittr/chittr).
