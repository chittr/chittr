# Optional Quality checks

The full local and hosted Quality suite is deferred for the first npm preview.
It is not a release or merge gate. Hosted Quality is disabled in the private
repository, and the public source export omits the workflow. A skipped check
is recorded as skipped, never as a pass.

Use a focused check when changing behavior. Build the candidate and rehearse the
installed package separately. The preview configuration is described in
[installation](installation.md); old matrix results do not establish support
for this package.

## Run locally when useful

These checks use synthetic fixtures, without provider logins or subscription
allowance. They require macOS, Node.js 22.12 or newer, and Python 3 for PTY probes.
From a source checkout:

```sh
npm ci
npm run build
```

Then run the checks that cover your change. The [maintenance guide](maintenance.md)
names the relevant tests. To opt into the complete suite:

```sh
npm run browser:install
unset CHITTR_BROWSER
npm run quality
```

`browser:install` installs the lockfile's Playwright Chromium. For a focused
browser check, `CHITTR_BROWSER` can name an installed browser executable. Record
which browser you used. Native macOS probes need an environment that permits
child sandboxes; an outer sandbox denial is not a passing result.

| Command                 | Coverage                                                       |
| ----------------------- | -------------------------------------------------------------- |
| `npm run check`         | Server and browser source types                                |
| `npm run build`         | Server, workers and browser assets                             |
| `npm run check:tests`   | TypeScript test sources and helpers                            |
| `npm test`              | Deterministic Vitest suite                                     |
| `npm run format:check`  | Prettier-supported files outside Git-ignored paths             |
| `npm run test:web`      | Browser UI with deterministic peers                            |
| `npm run test:terminal` | Terminal input/display through a Python PTY                    |
| `npm run test:resume`   | CLI startup/history/resume with providers disabled             |
| `npm run test:security` | Native macOS file, command, network, skill and MCP enforcement |

`npm run quality` runs these in the order shown and stops at the first failure.
Build before typechecking or running tests that import or launch `dist/` workers.
The public website has its own build in [chittr/chittr.dev](https://github.com/chittr/chittr.dev).

## Deferred coverage

The earlier macOS 15/26 and Node 22.12.0/24.18.0 matrix is deferred. It is not a
claim about this preview's tested configurations. Revisit broader coverage for
a later release or a concrete compatibility failure.

Live-provider scripts are separate maintainer actions. They start real provider
CLIs and can use subscription allowance, so run them only with explicit operator,
provider and call-limit approval.

Record the candidate commit, actual environment and relevant check outcomes in
the pull request or release record. Keep raw sensitive evidence out of source
and public comments. Bill owns release approval.
