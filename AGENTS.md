# Contributor navigation

Start with [the architecture map](docs/architecture.md) for module responsibilities
and dependency boundaries. For a maintenance task, use the matching guide:

- [Change rendering or browser composer behavior](docs/maintenance.md#change-rendering).
- [Add a room command](docs/maintenance.md#add-a-room-command).
- [Maintain a provider](docs/maintenance.md#maintain-a-provider).
- [Evolve saved data](docs/maintenance.md#evolve-saved-data).

This file is contributor navigation. The Codex adapter also reads applicable
root and ancestor AGENTS files as workspace instructions. The `.agents/` directory
holds project configuration, instruction files and skill bundles. Project
configuration and instruction files are personal to a checkout and stay untracked.
See [configure Chittr](docs/configuration.md#skills)
for provider discovery paths.

For the contribution process itself — the pull request loop, the credential-free
checks, contribution terms and the reporting routes — see
[CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md),
[SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
