# Privacy and permissions

Chittr runs on your Mac and uses the provider CLIs you installed and signed into.
It has no hosted account, analytics endpoint or telemetry service of its own.
Provider CLIs and services have their own terms, diagnostics and retention settings.
The preview uses subscription logins for Codex, Claude Code and Grok Build.
API-key authentication is not supported. Gemini/Antigravity is outside launch support.

## What leaves your Mac

Enabled providers receive the conversation context Chittr supplies, configured
instructions, and any file, skill or tool content their agents read. Supported
images can also be sent. A directed `@agent` message still belongs to the shared
conversation; it is not a private message hidden from other participants.
Checkpoints, summaries and conversation restoration also use providers and can
consume subscription allowance. Chittr does not guarantee that a subscription
has spare capacity or that provider terms permit every use you make of it.

Task networking being off does not stop provider authentication or inference
traffic. If you enable task networking, agents can contact additional services.
Commands and files can contain secrets, personal information or third-party data.
Only use material you intend to share with the selected providers.

Chittr does not control whether a provider retains content, uses it for training,
or permits deletion. Check the settings and terms for your own account with
[OpenAI](https://openai.com/policies/privacy-policy/),
[Anthropic](https://www.anthropic.com/legal/privacy) and
[xAI](https://x.ai/legal/privacy-policy).

## What stays on your Mac

- Configuration lives in `~/.agents/chittr.yaml` and the launch directory's
  `.agents/chittr.yaml`. Referenced instruction files stay where you put them.
- By default, conversations live under
  `~/.agents/chittr/sessions/<workspace-id>/<session-id>/`. `--state-dir PATH`
  selects a different storage base. Records include messages, drafts, routing
  and tool-activity summaries, provider session references, checkpoints and
  attachment files. Paths and errors can reveal details of your workspace.
- The browser keeps its launch token, drafts and pending request identities in
  origin-scoped tab storage. The printed browser link grants access to that
  running room. Keep it private. Closing the tab does not stop the room.
- Codex and Claude can retain their own native session records outside Chittr's
  storage. Grok uses a temporary native profile that Chittr removes on normal
  close. A crash can leave temporary files behind. Provider credentials remain
  managed by the provider CLIs.

Chittr does not encrypt its conversation files or backups. Its private file
permissions do not protect against programs running as your macOS account.
Protect your Mac and backups accordingly. Browser storage, native CLI records,
provider cloud records and Chittr files have separate lifetimes.

Uninstalling the npm package leaves configuration and conversations in place.
Chittr does not automatically expire saved conversations. To remove local data,
quit all Chittr processes and remove only the configuration or session directories
you intend to delete, including their attachment files and any copies/backups.
Use the browser's site-data controls for browser copies and the provider's own
controls for its records. Deleting Chittr data does not delete provider records
or securely erase storage. See [backup and restore](docs/installation.md#back-up-and-restore)
before changing saved data.

## What you grant agents

The default room allows conversation and file inspection in the launch directory,
plus read-only access to discovered skill bundles. Skills are enabled by default.
Edits, shell commands and task networking need explicit configuration grants.
Those grants apply to the whole room. A project's `.agents/chittr.yaml` can
override user permissions, so inspect it before launching in an unfamiliar project.
Configured instruction files may be outside the workspace and are read at launch
or reload. Treat project config, instruction files and installed skills as trusted
inputs; their text can influence agents.

Sandboxed file and command tools enforce the configured roots and permissions.
Trusted commands are a separate opt-in, enabled only with all three permissions
on. They run as your account with its filesystem, network, exported environment
and existing credentials. They can read or change files outside the workspace.
Separate agent names or provider accounts do not create separate OS accounts.
Stopping an agent does not undo completed commands, edits or network requests.

## Preview limits and reports

Models can misunderstand instructions or follow hostile text. The preview has
not passed a complete security audit or the full Quality suite. Do not treat it
as an isolation boundary for untrusted same-account programs.

Codex image delivery requires a thread, fresh or resumed, that passes the native
policy checks that admit it at startup. Claude checkpoint replacement and
historical image retrieval after restart remain outside verified coverage.
Provider changes can break startup or a capability even when login still works.

Report suspected vulnerabilities through
[GitHub's private reporting form](https://github.com/chittr/chittr/security/advisories/new).
Bill monitors it manually, with no promised response time. Avoid posting tokens,
conversation dumps or private file contents in public issues.
