# Chittr roadmap

Public rollout is paused while the macOS pilot is used in real projects. Reliability and usability issues found through daily use take priority. Revisit broader platform support once the pilot is stable in routine use.

| Priority                            | Item                                                        | Status                             |
| ----------------------------------- | ----------------------------------------------------------- | ---------------------------------- |
| Current focus                       | Use the platform and resolve stability and usability issues | Active personal pilot              |
| High                                | Broader platform availability                               | Deferred until the pilot is stable |
| After stability and platform review | Public release packaging and distribution                   | Rollout paused                     |

## Stability through use

Use the terminal and browser interfaces for real work. Capture reproducible issues with the relevant provider, CLI version, and steps, then fix and verify them. Pay particular attention to conversation continuity, concurrent replies, interruption and recovery, config reloads, and input handling. Passing automated checks alone does not establish that the everyday experience is ready for public rollout.

## Broader platform availability

Cross-platform support is a high-priority roadmap item, with implementation deferred while the personal pilot is evaluated.

The starting proposal is to retain macOS support, add Linux with Ubuntu as the first tested baseline, and support Windows through WSL2. Native Windows support can follow. Confirm the final platform and provider support matrix when this work begins.

The portability work should cover filesystem and network permission enforcement, clipboard access, browser launching, child-process shutdown, and provider authentication. Preserve the existing room permission policy and validate each supported platform with clean-machine installation and actual CLI sessions.

## Public rollout

Revisit packaging, installation and upgrades, licence choice, and release validation when the platform is stable and rollout planning resumes.
