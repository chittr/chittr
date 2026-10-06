# Changelog

Notable changes to `@chittr/cli`. Versions follow [Semantic Versioning](https://semver.org); before 1.0, a minor version can change behavior.

## [0.3.0] - 2026-10-06

### Added

- Room instructions. Set top-level `instructions.sources` in a user or project config to give every agent in the room the same guidance. Agent-specific instructions still apply alongside them. A project config's `instructions` block replaces the user one, and `instructions: {}` clears it. Each instruction file can be up to 1 MiB, and `/config` shows which config file supplied the room instructions. ([#10])
- `chittr --instructions-file PATH` gives a new conversation a brief that every agent receives. Chittr reads the file once, before first-run setup, and stops the launch if it is missing, unreadable or over 1 MiB. The text is saved with the conversation before any agent starts, so resuming restores it even after the file changes or is deleted. Idle `/reload` keeps the brief, `/new` starts without one and `/config` shows where it came from. The flag works with `--new` and `--web` and is rejected with `resume`, `--session` and `doctor`. The prompt tells agents that the brief takes precedence over room instructions, and room instructions over agent instructions. ([#10])
- The browser sidebar has a **System / Light / Dark** theme picker. **System** follows the operating system setting and is the default. A Light or Dark choice applies before the page first draws and is remembered across launches in a `chittr-theme` cookie, because each launch uses a new port and per-port browser storage would forget it. ([#11])
- `chittr update` updates a verified npm-global installation to npm's latest release, with version and Node compatibility checks, streamed npm output and a backup reminder. ([#12])

### Changed

- First-time setup picks default agents from a checklist instead of a comma-separated list. It offers the supported CLIs it detects (Codex, Claude and Grok), all checked; ↑/↓ moves, Space toggles and Enter confirms. Esc cancels setup without writing a config. Setup no longer offers Antigravity, which is outside this preview's support scope. ([#19])

## [0.2.0] - 2026-10-02

### Added

- The terminal renders Markdown in messages and streaming previews: headings, emphasis, nested lists, quotes, code, links, image references and GFM tables. Narrow tables wrap their cells or switch to labelled fields, and unfinished syntax stays readable while a reply streams. Copying a selection copies the rendered text. The composer and saved messages keep the raw Markdown. ([#7])
- `/attach --status` in the terminal prints why each recipient can or can't receive the staged images, without sending anything or changing the draft. ([#3])
- The package now includes this changelog and two new guides, [Configure Chittr](docs/configuration.md) and [Use Chittr](docs/usage.md), which hold the reference material that used to be in the README. ([#5])

### Changed

- Images work in a default room. Codex, Claude and Grok can receive them with every permission off, including in the first message to Claude and on a resumed Codex thread. Room permissions, skills and command mode no longer affect image delivery. Grok 1.0.13 keeps its earlier restriction, and Antigravity still can't receive images. ([#3])
- Image limits are now 3 MiB per image, and 20 images and 6 MiB per message. Each rejection names the limit it hit. The browser scales an image to at most 2000 px on its long edge, smaller if needed to fit 3 MiB, and uploads it as a PNG. A PNG already within both limits uploads unchanged. Terminal uploads aren't resized. ([#3])
- Image status moved off the sidebar and agent cards. A staged image shows one line for each recipient that can't receive it, such as `@codex can't receive images`, and the browser keeps the full reason behind **Details**. ([#3])
- Claude no longer loses image access partway through a turn when the turn's model changes. ([#3])
- A single provider event can be up to 64 MiB. Chittr now enforces the limit while reading, so an oversized line ends the connection with `Oversized provider event` before the whole line is buffered. The previous 8 MiB check ran only after buffering. ([#3])
- The README is a shorter front page that links to the guides. The configuration guide explains permissions and trusted commands as three command modes: `off`, `sandboxed` and `trusted`. ([#5], [#6])

## [0.1.0] - 2026-09-29

First public preview.

[0.3.0]: https://github.com/chittr/chittr/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/chittr/chittr/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/chittr/chittr/tree/v0.1.0
[#3]: https://github.com/chittr/chittr/pull/3
[#5]: https://github.com/chittr/chittr/pull/5
[#6]: https://github.com/chittr/chittr/pull/6
[#7]: https://github.com/chittr/chittr/pull/7
[#10]: https://github.com/chittr/chittr/pull/10
[#11]: https://github.com/chittr/chittr/pull/11
[#12]: https://github.com/chittr/chittr/pull/12
[#19]: https://github.com/chittr/chittr/pull/19
