#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { loadConfig, writeStarter, fingerprint, parseProviderSelection } from './config.js';
import { SessionStore } from './store.js';
import { RoomController } from './controller.js';
import { WebUI } from './web.js';
import { TerminalAttachments } from './ui/terminal-attachments.js';
import { TerminalUI } from './ui/terminal.js';
import { pickSession } from './ui/session-picker.js';
import { parseCliOptions } from './cli-options.js';
import { runProcess, errorText } from './process.js';
import { createAdapter } from './adapters/index.js';
import type { Provider, RoomConfig } from './types.js';
import { providerIds, providers as providerInfo } from './providers.js';
import { commandAccessSummary } from './command-access.js';
import { version } from './version.js';
import { readInstructionFile } from './instructions.js';
import { updateInstallation } from './update.js';

const launchEnvironment = { ...process.env };

const help = `Chittr ${version}: a local room with Codex, Claude Code, Grok Build, and Antigravity

Usage: chittr [--web] [--instructions-file PATH]
       chittr resume [ID] [--web]
       chittr doctor [--json]
       chittr update       Update this npm-global installation to the latest release

chittr starts a new chat. Resume opens a picker of saved chats for this directory,
most recent first. Use arrow keys to select, Enter to resume, or Escape to cancel.
Type to filter by conversation preview or session ID.

Launch from the directory agents should inspect. Config merges:
  ~/.agents/chittr.yaml
  <launch directory>/.agents/chittr.yaml

Options:
  --web              Open a local browser UI
  --new              Start a new conversation (the default)
  --session ID       Open a saved conversation for this directory
  --state-dir PATH   Use a separate storage base, including for backup recovery
  --instructions-file PATH
                     Share one file with all agents in this new conversation.
                     May combine with --new/--web; not resume, --session or doctor.
                     Paths are relative to the launch directory, absolute, or ~/.
                     Unreadable files or files over 1 MiB fail before startup.
                     The saved brief survives file edits/deletion and resume.
  --trusted-commands Run commands with your account access for this launch.
                     Requires edits, commands, and network enabled.
  --help, -h         Show this help
  --version, -v      Show version

Browser mode: Enter sends; Shift+Enter, Ctrl+Enter, and Ctrl+J insert a newline.
Closing the browser tab leaves agents running. Quit or terminal Ctrl+C stops and saves.

Terminal mode: Enter sends. Ctrl+J adds a newline. Ctrl+Enter also works where distinguishable.
Tab completes leading @names, commands, and file paths. Wheel/trackpad and PgUp/PgDn scroll history.
Type ./ in either composer to browse files. Up/Down chooses; Enter/Tab selects; Escape closes.
Drag visible text to highlight it; releasing the mouse copies it to the macOS clipboard.
Cmd+V pastes; Ctrl+V is also available. Multiline pastes remain a draft until Enter.
Escape clears a selection, dismisses completions, or returns to the latest message.
Ctrl+C copies a selection; otherwise it stops the room (repeat within 1.2s to quit).
Ctrl+D saves and quits.

Room commands:
  /pause [@agent]             Let active turns finish, then hold queued work
  /stop [@agent]              Interrupt turns and hold queued work
  /continue [@agent]          Release a manual pause; reconnect stopped agents
  /continue #message-id      Add another follow-up allowance to that exchange
  /retry #message-id @agent  Explicitly retry a failed/interrupted response
  /reply #message-id text    Discuss a message, without resolving its question; leading @names override the recipient
  /questions                List open questions, choices and attributed advice
  /ask-room #question-id     Gather opinions only; the human must still submit an answer
  /answer #message-id text   Answer a question with literal text, sent only to its author
  /choose #message-id number Answer with one of the question's numbered choices
  /pin #message-id           Pin a message in this conversation
  /unpin #message-id         Remove a message pin
  /pins                     View pinned messages with their full text
  /compact [@agent] [focus]  Compact one agent or all; optional focus where supported
  /checkpoint                View the latest shared context checkpoint
  /reconnect @agent          Reconnect with pending work paused
  /reload                   Apply config while idle
  /config                   Show effective settings and their sources
  /participants             Show all agents, settings, context usage, status, and queues
  /new                      Start a new conversation while idle
  /sessions [ID]             List or open saved conversations while idle
  /quit                     Stop, save, and exit

All permissions are room-wide. Missing grants require a config change and
idle /reload. No temporary chat approvals. The preview requires macOS.

Shared instructions: top-level YAML instructions.sources applies to all agents;
agents can also have their own instructions.sources. Within custom guidance,
the saved brief takes precedence over room YAML, then agent instructions.
This is prompt guidance; provider rules, room protocol and permissions still apply.
Resume and /sessions restore the destination brief with current YAML; /new has no
brief. /reload updates YAML and keeps the saved brief. Reconnect and /compact keep
the active brief. /config shows instruction sources. A brief cannot be edited in chat.
`;
async function detected(candidates: readonly Provider[] = providerIds): Promise<Provider[]> {
  const results = await Promise.all(
    candidates.map(async (name) => {
      try {
        const p = await runProcess(providerInfo[name].command, ['--version'], { timeout: 5000 });
        return p.code === 0 ? name : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((v): v is Provider => Boolean(v));
}
async function setup(workspace: string): Promise<RoomConfig> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'No config found. Run chittr in an interactive terminal for setup, or create .agents/chittr.yaml.',
    );
  const providers = await detected();
  if (!providers.length)
    throw new Error('Install a supported CLI (codex, claude, grok, or agy) and sign in first.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`No Chittr config found. Detected: ${providers.join(', ')}.\n`);
    let selected: Provider[];
    while (true) {
      const choice = await prompt.question(
        'Default agents to enable (comma-separated; choose at least one): ',
      );
      try {
        selected = parseProviderSelection(choice, providers);
        break;
      } catch (error) {
        process.stdout.write(`${errorText(error)}\n`);
      }
    }
    const name = (await prompt.question('Your display name [You]: ')).trim() || 'You';
    const answer = (
      await prompt.question(
        'Create ~/.agents/chittr.yaml with discussion and file inspection permissions? [Y/n] ',
      )
    )
      .trim()
      .toLowerCase();
    if (answer && !['y', 'yes'].includes(answer))
      throw new Error('Setup cancelled; no config was written.');
    const path = writeStarter(selected, undefined, name);
    process.stdout.write(`Created ${path}\n`);
  } finally {
    prompt.close();
  }
  return loadConfig(workspace)!;
}
async function doctor(
  config: RoomConfig | undefined,
  workspace: string,
  json: boolean,
): Promise<boolean> {
  const doctorProviders: readonly Provider[] = ['codex', 'claude', 'grok'];
  const effective = config ?? {
    workspace,
    permissions: { edits: false, commands: false, network: false },
    followUpTurns: 8,
    sources: [],
    provenance: {},
    agents: Object.fromEntries(
      (await detected(doctorProviders)).map((provider) => [
        provider,
        {
          id: provider,
          provider,
          enabled: true,
          instructions: '',
          fingerprint: fingerprint(provider),
        },
      ]),
    ),
  };
  const results = await Promise.all(
    Object.values(effective.agents)
      .filter((a) => a.enabled && doctorProviders.includes(a.provider))
      .map(async (agent) => {
        const adapter = createAdapter(agent, effective, launchEnvironment);
        try {
          await adapter.start();
          return {
            agent: agent.id,
            provider: agent.provider,
            handshake: 'passed',
            note: 'No model call was made. A live response is tested separately.',
          };
        } catch (e) {
          return {
            agent: agent.id,
            provider: agent.provider,
            handshake: 'failed',
            error: errorText(e),
          };
        } finally {
          await adapter.close().catch(() => {});
        }
      }),
  );
  const report = {
    platform: process.platform,
    workspace,
    permissions: effective.permissions,
    commandAccess: config?.commandAccess,
    agents: results,
  };
  process.stdout.write(
    json
      ? JSON.stringify(report, null, 2) + '\n'
      : `${workspace}\n${commandAccessSummary(effective)}\n${results.map((r) => `${r.agent}: ${r.handshake}${r.error ? ': ' + r.error : ': CLI handshake and local file-tool sandbox verified'}`).join('\n')}\nNo model calls were made.\n`,
  );
  return results.length > 0 && results.every((r) => r.handshake === 'passed');
}
async function main(): Promise<void> {
  const { values, command, sessionId } = parseCliOptions();
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (command === 'update') {
    await updateInstallation(new URL(import.meta.url));
    return;
  }
  const workspace = realpathSync(process.cwd());
  const launchBrief =
    values['instructions-file'] === undefined
      ? undefined
      : readInstructionFile(values['instructions-file'], workspace);
  const currentConfig = (directory: string) =>
    loadConfig(directory, undefined, { trustedCommands: values['trusted-commands'] });
  if (command === 'doctor') {
    if (!(await doctor(currentConfig(workspace), workspace, Boolean(values.json))))
      process.exitCode = 1;
    return;
  }
  const needsPicker = command === 'resume' && sessionId === undefined;
  if (needsPicker && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error('Run chittr resume in an interactive terminal to choose a saved chat.');
  if (!values.web && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error(
      'Chittr requires an interactive terminal. Run chittr --help or chittr doctor for plain output.',
    );
  const store = new SessionStore(workspace, values['state-dir']);
  store.acquire();
  let controller: RoomController | undefined;
  let ui: TerminalUI | WebUI | undefined;
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await controller?.close();
      } finally {
        store.release();
        ui?.unmount();
        const room = controller?.room;
        if (room?.fatal) {
          process.stderr.write(room.fatal + '\n');
          process.exitCode = 1;
        } else if (room)
          process.stdout.write(
            `Saved conversation ${room.session.id}. Run chittr resume here to continue it.\n`,
          );
      }
    })());
  try {
    let selectedId = sessionId;
    if (needsPicker) {
      const sessions = store.list();
      if (!sessions.length) {
        process.stdout.write('No saved chats in this directory. Run chittr to start a new chat.\n');
        await shutdown();
        return;
      }
      selectedId = await pickSession(sessions, workspace);
      if (selectedId === undefined) {
        process.stdout.write('Resume cancelled.\n');
        await shutdown();
        return;
      }
    }
    const session = selectedId === undefined ? undefined : store.load(selectedId);
    const config = currentConfig(workspace) ?? (await setup(workspace));
    controller = new RoomController(config, store, session, {
      help,
      quit: shutdown,
      loadConfig: currentConfig,
      environment: launchEnvironment,
    });
    // Only the initial new conversation owns this brief. Never capture it in currentConfig.
    if (launchBrief) controller.room.session.launchBrief = launchBrief;
    let browserUrl: string | undefined;
    if (values.web) {
      const web = new WebUI(controller);
      ui = web;
      const url = await web.mount();
      process.stdout.write(
        `Chittr is running in your browser.\n${url}\nKeep this process running. Ctrl+C stops and saves the room.\n`,
      );
      browserUrl = url;
    } else {
      const terminal = new TerminalUI(
        controller.room,
        (line, sessionId) => controller!.submitDraft({ source: 'terminal-text', line, sessionId }),
        shutdown,
        undefined,
        new TerminalAttachments(controller, config.workspace),
      );
      ui = terminal;
      controller.on('room', (room) => terminal.setRoom(room));
      terminal.mount();
    }
    for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const)
      process.once(signal, () => {
        void shutdown();
      });
    if (!values.web)
      process.stdin.once('end', () => {
        void shutdown();
      });
    if (browserUrl) {
      try {
        const result = await runProcess('/usr/bin/open', [browserUrl], { timeout: 5000 });
        if (result.code !== 0)
          process.stderr.write('Could not open the browser automatically. Open the link above.\n');
      } catch {
        process.stderr.write('Could not open the browser automatically. Open the link above.\n');
      }
    }
    if (closing) return;
    await controller.room.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
}
main().catch((error) => {
  process.stderr.write(`chittr: ${errorText(error)}\n`);
  process.exitCode = 1;
});
