import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Room } from '../src/room.js';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import { IsolatedRuntime } from '../src/adapters/isolated.js';
import { forwardCommand } from '../src/command-broker.js';
import { instructions, turnPrompt } from '../src/protocol.js';
import { projectRoom } from '../src/snapshot.js';
import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import {
  createPlanFile,
  planFileName,
  planLockFile,
  tryPlanLock,
  planFolder,
  planHash,
  planStateRoot,
  planTextLimit,
  readPlanMode,
} from '../src/plan.js';
import { sandboxProfile } from '../src/tools.js';
import { runProcess } from '../src/process.js';

// Observe, without replacing, how tool services launch the sandboxed file worker.
vi.mock('../src/process.js', { spy: true });
import type {
  AdapterEvent,
  AgentAdapter,
  AgentConfig,
  Permissions,
  RoomConfig,
  Session,
  TurnInput,
  TurnResult,
} from '../src/types.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
};
const namePattern = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z]+-[a-z]+-[a-z]+\.md$/;

/** A scripted provider whose task tools are the real room tool service and MCP child. */
class Fake implements AgentAdapter {
  inputs: TurnInput[] = [];
  starts: (string | undefined)[] = [];
  emit?: (event: AdapterEvent) => void;
  /** The provider session the next started adapter reports instead of resuming. */
  static nextSession?: string;
  /** Called as each turn reaches the provider. */
  static observe?: (input: TurnInput) => void;
  nativeCompaction = true;
  runtime: IsolatedRuntime;
  private pending?: { resolve: (result: TurnResult) => void; reject: (error: Error) => void };
  private closed = false;
  constructor(
    readonly agent: AgentConfig,
    config: RoomConfig,
    environment: NodeJS.ProcessEnv,
  ) {
    this.runtime = new IsolatedRuntime(agent, config, environment);
  }
  get tools() {
    return this.runtime.tools;
  }
  async start(id?: string) {
    this.starts.push(id);
    const sessionId = Fake.nextSession ?? id ?? 'native-session';
    Fake.nextSession = undefined;
    return { sessionId, restored: false };
  }
  run(input: TurnInput, event: (event: AdapterEvent) => void, signal: AbortSignal) {
    this.inputs.push(input);
    this.emit = event;
    Fake.observe?.(input);
    return new Promise<TurnResult>((resolve, reject) => {
      this.pending = { resolve, reject };
      signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
    });
  }
  finish() {
    const input = this.inputs.at(-1)!;
    this.pending!.resolve({
      outcomes: input.messages.map((message) => ({
        messageIds: [message.id],
        kind: 'pass' as const,
        text: 'Nothing to add',
        recipients: [],
      })),
    });
    this.pending = undefined;
  }
  async compact() {
    return { status: 'completed' as const };
  }
  async interrupt() {
    this.pending?.reject(new Error('Interrupted'));
  }
  async close() {
    await this.interrupt();
    if (this.closed) return;
    this.closed = true;
    this.runtime.close();
  }
}

const roots: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
let savedHome: string | undefined, savedTmpdir: string | undefined;
beforeEach(() => {
  savedHome = process.env.HOME;
  savedTmpdir = process.env.TMPDIR;
});
afterEach(async () => {
  process.env.HOME = savedHome;
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  Fake.nextSession = undefined;
  Fake.observe = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  permissions: Permissions = { edits: false, commands: false, network: false },
  options: { trusted?: boolean; agents?: string[]; location?: string } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-plan-test-')));
  roots.push(root);
  const home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    other = join(root, 'other workspace');
  for (const dir of [home, workspace, other]) mkdirSync(dir);
  const location = options.location ?? 'user';
  const config: RoomConfig = {
    workspace,
    permissions,
    followUpTurns: 8,
    sources: [],
    provenance: {},
    plans: { location, folder: planFolder(location, workspace, home) },
    ...(options.trusted
      ? { commandAccess: { mode: 'trusted', source: 'test', blockedBy: [] } }
      : {}),
    agents: Object.fromEntries(
      (options.agents ?? ['codex']).map((id) => [
        id,
        { id, provider: 'codex' as const, enabled: true, instructions: '', fingerprint: id },
      ]),
    ),
  };
  const environment = { HOME: home, PATH: '/usr/bin:/bin' };
  const fakes: Record<string, Fake> = {};
  const factory = (agent: AgentConfig, roomConfig: RoomConfig) =>
    (fakes[agent.id] = new Fake(agent, roomConfig, environment));
  const store = new SessionStore(workspace, join(root, 'state'));
  store.acquire();
  cleanups.push(() => store.release());
  const open = (session?: Session) => {
    const room = new Room(config, store, session, factory);
    cleanups.push(() => room.close());
    return room;
  };
  const controller = (session?: Session) => {
    const instance = new RoomController(config, store, session, {
      help: 'help',
      quit: async () => {},
      createRoom: (roomConfig, roomStore, saved) => {
        const room = new Room(roomConfig, roomStore, saved, factory);
        cleanups.push(() => room.close());
        return room;
      },
    });
    cleanups.push(() => instance.close());
    return instance;
  };
  return { root, home, workspace, other, config, environment, fakes, store, open, controller };
}
const lastNotice = (room: Room) => room.session.notices.at(-1)!.text;

describe('plan files and names', () => {
  it('names plans in local time and picks new words when the name exists', () => {
    const date = new Date(2026, 9, 5, 14, 32);
    expect(planFileName(date, ['amber', 'quiet', 'falcon'])).toBe(
      '2026-10-05-1432-amber-quiet-falcon.md',
    );
    const folder = join(fixture().root, 'missing', 'plans');
    const words = [
      ['amber', 'quiet', 'falcon'],
      ['amber', 'quiet', 'falcon'],
      ['brisk', 'calm', 'otter'],
    ] as const;
    let index = 0;
    const first = createPlanFile(folder, date, () => words[index++]!);
    const second = createPlanFile(folder, date, () => words[index++]!);
    expect(first).toBe(join(realpathSync(folder), '2026-10-05-1432-amber-quiet-falcon.md'));
    expect(second).toBe(join(realpathSync(folder), '2026-10-05-1432-brisk-calm-otter.md'));
    expect(index).toBe(3);
    expect(readFileSync(first, 'utf8')).toBe('');
  });

  it.each(['user', 'directory', 'absolute', 'home'] as const)(
    '/plan creates an empty plan in the folder plans.location %s selects',
    async (kind) => {
      const f = fixture();
      const derived = f.workspace.replaceAll('/', '-');
      const choices: Record<typeof kind, [string, string]> = {
        user: ['user', join(f.home, '.agents/chittr/plans', derived)],
        directory: ['directory', join(f.workspace, '.agents/chittr/plans')],
        absolute: [join(f.root, 'shared plans'), join(f.root, 'shared plans', derived)],
        home: ['~/my plans', join(f.home, 'my plans', derived)],
      };
      const [location, folder] = choices[kind];
      f.config.plans = { location, folder: planFolder(location, f.workspace, f.home) };
      const controller = f.controller();
      await controller.room.start();
      await controller.submit('/plan');
      const [name, ...rest] = readdirSync(folder);
      expect(rest).toEqual([]);
      expect(name).toMatch(namePattern);
      const path = join(folder, name!);
      expect(statSync(path).size).toBe(0);
      expect(controller.room.session.plan?.path).toBe(path);
      expect(lastNotice(controller.room)).toBe(
        `Created ${path}. Plan mode is on; run /plan off to leave it.`,
      );
      expect(controller.snapshot().plan).toEqual({ path, name, missing: false });
    },
  );
});

describe('plan commands', () => {
  it('turns plan mode on and off without messages, turns or reconnects', async () => {
    const f = fixture();
    const controller = f.controller();
    const room = controller.room;
    await room.start();
    const fake = f.fakes.codex!;
    const fingerprint = room.session.agents.codex!.fingerprint;
    await controller.submit('/plan');
    const path = room.session.plan!.path;
    await expect(controller.submit('/plan')).rejects.toThrow(
      `Plan mode is already on with ${path}. Run /plan off first.`,
    );
    await expect(controller.submit('/plan resume')).rejects.toThrow('Run /plan off first');
    await expect(controller.submit(`/plan resume ${path}`)).rejects.toThrow('Run /plan off first');
    await controller.submit('/plan off');
    expect(room.session.plan).toBeUndefined();
    expect(controller.snapshot().plan).toBeUndefined();
    expect(lastNotice(room)).toBe(
      `Plan mode is off. Detached ${path}; writes follow permissions.edits again.`,
    );
    await controller.submit('/plan off');
    expect(lastNotice(room)).toBe('Plan mode is already off.');
    await expect(controller.submit('/plan sideways')).rejects.toThrow('Usage: /plan');
    await tick();
    expect(room.session.messages).toEqual([]);
    expect(fake.inputs).toEqual([]);
    expect(fake.starts).toEqual([undefined]);
    expect(room.session.agents.codex!.fingerprint).toBe(fingerprint);
  });

  it('lists plans newest first and attaches by file name or three-word part', async () => {
    const f = fixture();
    const folder = f.config.plans!.folder;
    mkdirSync(folder, { recursive: true });
    for (const name of [
      '2026-01-02-0900-amber-quiet-falcon.md',
      '2026-03-04-1000-brisk-calm-otter.md',
      '2026-02-03-1100-brisk-calm-otter.md',
      'notes.md',
      'ignored.txt',
    ])
      writeFileSync(join(folder, name), `# ${name}\n`);
    const controller = f.controller();
    const room = controller.room;
    await room.start();
    await controller.submit('/plan resume');
    expect(lastNotice(room)).toBe(
      `Plans in ${folder}, newest first (4)\n\nnotes.md\n2026-03-04-1000-brisk-calm-otter.md\n2026-02-03-1100-brisk-calm-otter.md\n2026-01-02-0900-amber-quiet-falcon.md\n\nUse /plan resume <name or path> to attach one.`,
    );
    await expect(controller.submit('/plan resume brisk-calm-otter')).rejects.toThrow(
      'brisk-calm-otter matches more than one plan: 2026-03-04-1000-brisk-calm-otter.md, 2026-02-03-1100-brisk-calm-otter.md',
    );
    await expect(controller.submit('/plan resume missing-name')).rejects.toThrow(
      `No plan named missing-name in ${folder}`,
    );
    await controller.submit('/plan resume amber-quiet-falcon');
    expect(room.session.plan!.path).toBe(join(folder, '2026-01-02-0900-amber-quiet-falcon.md'));
    await controller.submit('/plan off');
    await controller.submit('/plan resume 2026-02-03-1100-brisk-calm-otter.md');
    expect(room.session.plan!.path).toBe(join(folder, '2026-02-03-1100-brisk-calm-otter.md'));
    expect(lastNotice(room)).toBe(
      `Plan mode is on with ${room.session.plan!.path}. Run /plan off to leave it.`,
    );
  });

  it('reports an empty plan folder', async () => {
    const f = fixture();
    const controller = f.controller();
    await controller.room.start();
    await controller.submit('/plan resume');
    expect(lastNotice(controller.room)).toBe(
      `No plans in ${f.config.plans!.folder}. Use /plan to create one.`,
    );
  });

  it('attaches paths with spaces, ~/ paths, relative paths and plans from other workspaces', async () => {
    const f = fixture();
    process.env.HOME = f.home;
    const spaced = join(f.other, 'plan with spaces.md');
    const homePlan = join(f.home, 'home plan.md');
    mkdirSync(join(f.workspace, 'docs'));
    const relativePlan = join(f.workspace, 'docs', 'plan.md');
    for (const path of [spaced, homePlan, relativePlan]) writeFileSync(path, '# Plan\n');
    const controller = f.controller();
    const room = controller.room;
    await room.start();
    for (const [argument, expected] of [
      [spaced, spaced],
      ['~/home plan.md', homePlan],
      ['docs/plan.md', relativePlan],
      ['./docs/../docs/plan.md', relativePlan],
    ] as const) {
      await controller.submit(`/plan resume ${argument}`);
      expect(room.session.plan!.path).toBe(expected);
      await controller.submit('/plan off');
    }
  });

  it('refuses non-.md files, symlinks, missing files and files inside a skill bundle', async () => {
    const f = fixture();
    const skill = join(f.root, 'skills', 'review');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: review\n---\n');
    writeFileSync(join(skill, 'notes.md'), 'skill notes');
    f.config.agents.codex!.skills = {
      bundles: [
        {
          name: 'review',
          description: 'Review',
          explicitOnly: false,
          digest: 'x',
          path: skill,
          root: skill,
        },
      ],
      warnings: [],
    };
    writeFileSync(join(f.other, 'plan.txt'), 'text');
    writeFileSync(join(f.other, 'real.md'), 'real');
    symlinkSync(join(f.other, 'real.md'), join(f.other, 'link.md'));
    const controller = f.controller();
    await controller.room.start();
    await expect(controller.submit(`/plan resume ${join(f.other, 'plan.txt')}`)).rejects.toThrow(
      'A plan must be a .md file',
    );
    await expect(controller.submit(`/plan resume ${join(f.other, 'link.md')}`)).rejects.toThrow(
      'A plan cannot be a symlink',
    );
    await expect(controller.submit(`/plan resume ${join(f.other, 'gone.md')}`)).rejects.toThrow(
      'No plan file at',
    );
    await expect(controller.submit(`/plan resume ${f.other}/`)).rejects.toThrow(
      'A plan must be a regular .md file',
    );
    await expect(controller.submit(`/plan resume ${join(skill, 'notes.md')}`)).rejects.toThrow(
      'A plan cannot be inside a skill bundle',
    );
    expect(controller.room.session.plan).toBeUndefined();
  });

  it('refuses to create a plan inside a skill bundle, directly or through a symlinked folder', async () => {
    const f = fixture();
    const skill = join(f.root, 'skills', 'review');
    mkdirSync(join(skill, 'plans'), { recursive: true });
    f.config.agents.codex!.skills = {
      bundles: [
        {
          name: 'review',
          description: 'Review',
          explicitOnly: false,
          digest: 'x',
          path: skill,
          root: skill,
        },
      ],
      warnings: [],
    };
    f.config.plans = { location: skill, folder: planFolder(skill, f.workspace, f.home) };
    const controller = f.controller();
    await controller.room.start();
    await expect(controller.submit('/plan')).rejects.toThrow(
      'plans.location points inside a skill bundle',
    );
    const link = join(f.root, 'linked plans');
    symlinkSync(join(skill, 'plans'), link);
    f.config.plans = { location: link, folder: link };
    await expect(controller.submit('/plan')).rejects.toThrow(
      'A plan cannot be inside a skill bundle',
    );
    expect(readdirSync(join(skill, 'plans'))).toEqual([]);
    expect(readdirSync(skill)).toEqual(['plans']);
    expect(controller.room.session.plan).toBeUndefined();
  });

  it('refuses plan access from every participant once any discovered bundle contains the plan', async () => {
    const f = fixture(
      { edits: false, commands: false, network: false },
      { agents: ['codex', 'claude'] },
    );
    const bundle = join(f.root, 'claude skills');
    mkdirSync(bundle);
    const plan = join(bundle, 'plan.md');
    writeFileSync(plan, '# Plan\n');
    const controller = f.controller();
    const room = controller.room;
    await room.start();
    await controller.submit(`/plan resume ${plan}`);
    const codex = f.fakes.codex!.tools;
    await codex.call('read_file', { path: plan });
    await room.reload({
      ...f.config,
      agents: {
        ...f.config.agents,
        claude: {
          ...f.config.agents.claude!,
          skills: {
            bundles: [
              {
                name: 'ours',
                description: 'Ours',
                explicitOnly: false,
                digest: 'x',
                path: bundle,
                root: bundle,
              },
            ],
            warnings: [],
          },
        },
      },
    });
    expect(f.fakes.codex!.tools).toBe(codex);
    await expect(codex.call('write_file', { path: plan, text: '# Changed\n' })).rejects.toThrow(
      'A plan cannot be inside a skill bundle',
    );
    await expect(codex.call('read_file', { path: plan })).rejects.toThrow(
      'A plan cannot be inside a skill bundle',
    );
    expect(readFileSync(plan, 'utf8')).toBe('# Plan\n');
  });

  it('shows the effective plans.location and its source in /config', async () => {
    const f = fixture();
    const controller = f.controller();
    expect(controller.configSummary().plans).toEqual({ location: 'user', source: null });
    f.config.plans = { location: 'directory', folder: join(f.workspace, '.agents/chittr/plans') };
    f.config.provenance['plans.location'] = '/project/.agents/chittr.yaml';
    expect(controller.configSummary().plans).toEqual({
      location: 'directory',
      source: '/project/.agents/chittr.yaml',
    });
  });
});

describe('plan-mode permissions', () => {
  it.each([true, false])(
    'with edits=%s, writes only the plan, reads it outside the launch directory and sandboxes commands',
    async (edits) => {
      const f = fixture({ edits, commands: true, network: false });
      const plan = join(f.other, 'plan.md');
      writeFileSync(plan, '# Plan\n');
      const controller = f.controller();
      const room = controller.room;
      await room.start();
      const tools = f.fakes.codex!.tools;
      await expect(tools.call('read_file', { path: plan })).rejects.toThrow(
        'limited to the launch directory',
      );
      await controller.submit(`/plan resume ${plan}`);
      // The same tool service applies plan mode from its next call.
      expect(await tools.call('read_file', { path: plan })).toMatchObject({ text: '# Plan\n' });
      expect(await tools.call('write_file', { path: plan, text: '# Plan\n\n- Decided\n' })).toEqual(
        {
          path: plan,
          writtenBytes: 18,
        },
      );
      expect(readFileSync(plan, 'utf8')).toBe('# Plan\n\n- Decided\n');
      for (const path of ['notes.md', join(f.other, 'other.md')])
        await expect(tools.call('write_file', { path, text: 'x' })).rejects.toThrow(
          `Plan mode is on: write_file can write only the attached plan ${plan}. Every other write is refused until the human runs /plan off.`,
        );
      const command = (await tools.call('run_command', {
        command: `echo x > inside.txt; echo y > "${plan}"`,
      })) as { exitCode: number };
      expect(command.exitCode).not.toBe(0);
      expect(existsSync(join(f.workspace, 'inside.txt'))).toBe(false);
      expect(readFileSync(plan, 'utf8')).toBe('# Plan\n\n- Decided\n');
      await controller.submit('/plan off');
      if (edits) {
        await tools.call('write_file', { path: 'notes.md', text: 'x' });
        expect(readFileSync(join(f.workspace, 'notes.md'), 'utf8')).toBe('x');
        const after = (await tools.call('run_command', { command: 'echo x > inside.txt' })) as {
          exitCode: number;
        };
        expect(after.exitCode).toBe(0);
      } else
        await expect(tools.call('write_file', { path: 'notes.md', text: 'x' })).rejects.toThrow(
          'Missing permission: permissions.edits=true',
        );
      await expect(tools.call('read_file', { path: plan })).rejects.toThrow(
        'limited to the launch directory',
      );
      await expect(tools.call('write_file', { path: plan, text: 'x' })).rejects.toThrow(
        edits ? 'limited to the launch directory' : 'Missing permission',
      );
      expect(f.fakes.codex!.starts).toEqual([undefined]);
    },
  );

  it('runs trusted commands sandboxed in plan mode, including commands an MCP child forwards', async () => {
    const f = fixture({ edits: true, commands: true, network: true }, { trusted: true });
    writeFileSync(join(f.home, 'marker'), 'account-config');
    const plan = join(f.other, 'plan.md');
    writeFileSync(plan, '# Plan\n');
    const controller = f.controller();
    const room = controller.room;
    await room.start();
    const tools = f.fakes.codex!.tools;
    const settings = await tools.mcpSettings('codex');
    const probe = `cat "${join(f.home, 'marker')}"; touch trusted.txt`;
    const host = () => tools.call('run_command', { command: probe }) as Promise<any>;
    const forwarded = () =>
      forwardCommand(settings.commandEndpoint, { command: probe }) as Promise<any>;
    expect(await host()).toMatchObject({ exitCode: 0, stdout: 'account-config' });
    rmSync(join(f.workspace, 'trusted.txt'));
    await controller.submit(`/plan resume ${plan}`);
    for (const run of [host, forwarded]) {
      const result = await run();
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain('account-config');
      expect(existsSync(join(f.workspace, 'trusted.txt'))).toBe(false);
    }
    await expect(tools.call('write_file', { path: 'notes.md', text: 'x' })).rejects.toThrow(
      'Plan mode is on',
    );
    await controller.submit('/plan off');
    for (const run of [host, forwarded]) {
      expect(await run()).toMatchObject({ exitCode: 0, stdout: 'account-config' });
      rmSync(join(f.workspace, 'trusted.txt'));
    }
    expect(f.fakes.codex!.starts).toEqual([undefined]);
  });

  it('enforces plan mode in the MCP child from settings passed through mcpSettings', async () => {
    const f = fixture({ edits: true, commands: true, network: false });
    const plan = join(f.other, 'plan.md');
    writeFileSync(plan, '# Plan\n');
    const controller = f.controller();
    await controller.room.start();
    const server = await f.fakes.codex!.runtime.mcp();
    expect(JSON.parse(server.args[1]!).planState).toEqual(f.fakes.codex!.agent.planState);
    const client = new Client({ name: 'plan-mode', version: '1' });
    await client.connect(
      new StdioClientTransport({ command: server.command, args: server.args, stderr: 'pipe' }),
    );
    cleanups.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as any;
      return { error: Boolean(result.isError), text: result.content[0]?.text as string };
    };
    await controller.submit(`/plan resume ${plan}`);
    expect(await call('write_file', { path: 'notes.md', text: 'x' })).toMatchObject({
      error: true,
      text: expect.stringContaining('Plan mode is on'),
    });
    expect(await call('write_file', { path: plan, text: 'stale' })).toMatchObject({
      error: true,
      text: expect.stringContaining('Reread it with read_file'),
    });
    expect((await call('read_file', { path: plan })).text).toContain('# Plan');
    expect((await call('write_file', { path: plan, text: '# Child\n' })).error).toBe(false);
    expect(readFileSync(plan, 'utf8')).toBe('# Child\n');
    expect(
      JSON.parse((await call('run_command', { command: 'touch child.txt' })).text).exitCode,
    ).not.toBe(0);
    expect(existsSync(join(f.workspace, 'child.txt'))).toBe(false);
    await controller.submit('/plan off');
    expect((await call('write_file', { path: 'notes.md', text: 'x' })).error).toBe(false);
    expect(readFileSync(join(f.workspace, 'notes.md'), 'utf8')).toBe('x');
  });

  it('keeps plan-mode state outside the tool scratch directory and the workspace', async () => {
    const f = fixture({ edits: true, commands: true, network: false });
    const plan = join(f.workspace, 'plan.md');
    writeFileSync(plan, '# Plan\n');
    const controller = f.controller();
    const room = controller.room;
    await room.start();
    await controller.submit(`/plan resume ${plan}`);
    const { directory } = f.fakes.codex!.agent.planState!;
    const tools = f.fakes.codex!.tools;
    expect(readPlanMode(directory)?.path).toBe(plan);
    expect(inside(f.workspace, directory)).toBe(false);
    expect(inside(tools.scratch, directory)).toBe(false);
    expect(inside(directory, tools.scratch)).toBe(false);
    const attempt = (await tools.call('run_command', {
      command: `echo '{"path":null}' > "${join(directory, 'mode.json')}"`,
    })) as { exitCode: number };
    expect(attempt.exitCode).not.toBe(0);
    expect(readPlanMode(directory)?.path).toBe(plan);
    await controller.close();
    expect(existsSync(directory)).toBe(false);
  });

  it('keeps plan state in its private root when TMPDIR points into the workspace', async () => {
    const f = fixture({ edits: true, commands: true, network: false });
    const local = join(f.workspace, 'tmp');
    mkdirSync(local);
    process.env.TMPDIR = local;
    const plan = join(f.other, 'plan.md');
    writeFileSync(plan, '# Plan\n');
    const controller = f.controller();
    await controller.room.start();
    await controller.submit('/plan off');
    const tools = f.fakes.codex!.tools;
    const { directory } = f.fakes.codex!.agent.planState!;
    expect(inside(tools.scratch, local)).toBe(false);
    expect(inside(local, tools.scratch)).toBe(true);
    expect(inside(planStateRoot, directory)).toBe(true);
    expect(inside(f.workspace, directory)).toBe(false);
    expect(sandboxProfile(f.workspace, f.config.permissions, tools.scratch)).toContain(
      `(subpath "${planStateRoot}"))`,
    );
    // Plan mode off and edits on: a command still cannot attach a plan by rewriting the state.
    const attempt = (await tools.call('run_command', {
      command: `printf '{"path":"${plan}","skills":[]}' > "${join(directory, 'mode.json')}"`,
    })) as { exitCode: number };
    expect(attempt.exitCode).not.toBe(0);
    expect(readPlanMode(directory)).toBeUndefined();
    await expect(tools.call('read_file', { path: plan })).rejects.toThrow(
      'limited to the launch directory',
    );
  });
});

describe('plan data in turns', () => {
  async function planRoom(text: string, agents = ['codex']) {
    const f = fixture({ edits: false, commands: false, network: false }, { agents });
    const plan = join(f.other, 'plan.md');
    writeFileSync(plan, text);
    const controller = f.controller();
    const room = controller.room;
    await room.start();
    await controller.submit(`/plan resume ${plan}`);
    const turn = async (message = 'Discuss') => {
      room.send(message);
      await tick();
      const input = f.fakes.codex!.inputs.at(-1)!;
      for (const fake of Object.values(f.fakes)) fake.finish();
      await tick();
      return input;
    };
    return { f, plan, controller, room, turn, tools: f.fakes.codex!.tools };
  }

  it('sends the plan when it changed, and neither text nor change flag when unchanged', async () => {
    const { plan, turn } = await planRoom('# Plan\n');
    const first = await turn();
    expect(first.plan).toMatchObject({ path: plan, status: 'changed', text: '# Plan\n' });
    expect(first.plan!.rules).toEqual(
      expect.arrayContaining([
        'Edit the plan only when the human names you and asks you to.',
        'Agreeing to the plan is not an instruction to build it.',
        expect.stringContaining('This overrides the permission text you received at connection.'),
      ]),
    );
    expect(JSON.parse(turnPrompt(first)).plan).toEqual(first.plan);
    const second = await turn();
    expect(second.plan).toEqual({ path: plan, status: 'unchanged', rules: first.plan!.rules });
    writeFileSync(plan, '# Plan\n\n- Human edit\n');
    expect((await turn()).plan).toMatchObject({
      status: 'changed',
      text: '# Plan\n\n- Human edit\n',
    });
  });

  it('keeps plan data out of instructions and the provider-session fingerprint', async () => {
    const { f, plan, controller, room, turn } = await planRoom('# Plan\n');
    await turn();
    const fake = f.fakes.codex!;
    expect(instructions(fake.agent, f.config)).not.toContain(plan);
    expect(instructions(fake.agent, f.config)).not.toContain('Plan mode');
    expect(fake.agent.fingerprint).toBe('codex');
    await controller.submit('/plan off');
    const off = await turn();
    expect(off.plan).toBeUndefined();
    expect(JSON.parse(turnPrompt(off))).not.toHaveProperty('plan');
    expect(room.session.agents.codex!.fingerprint).toBe('codex');
    expect(fake.starts).toEqual([undefined]);
  });

  it('sends only the path and flag above 32 KiB, and refuses plan writes until a read', async () => {
    const large = 'x'.repeat(planTextLimit + 1);
    const { plan, turn, tools } = await planRoom(large);
    const first = await turn();
    expect(first.plan).toEqual({ path: plan, status: 'changed', rules: first.plan!.rules });
    expect((await turn()).plan!.status).toBe('changed');
    await expect(tools.call('write_file', { path: plan, text: '# Short\n' })).rejects.toThrow(
      'The plan changed since you last received or read it. Reread it with read_file, then retry the write.',
    );
    await tools.call('read_file', { path: plan, limit: 10 });
    expect((await turn()).plan!.status).toBe('unchanged');
    await tools.call('write_file', { path: plan, text: '# Short\n' });
    expect(readFileSync(plan, 'utf8')).toBe('# Short\n');
    writeFileSync(plan, 'x'.repeat(planTextLimit));
    expect((await turn()).plan!.text).toHaveLength(planTextLimit);
  });

  it('lets only one of two concurrent agent writes replace the version both saw', async () => {
    const { f, plan, turn } = await planRoom('# Plan\n', ['codex', 'claude']);
    await turn();
    const texts = ['# Codex\n', '# Claude\n'];
    const results = await Promise.allSettled([
      f.fakes.codex!.tools.call('write_file', { path: plan, text: texts[0]! }),
      f.fakes.claude!.tools.call('write_file', { path: plan, text: texts[1]! }),
    ]);
    const written = results.findIndex((result) => result.status === 'fulfilled');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.message).toContain('Reread it with read_file');
    expect(readFileSync(plan, 'utf8')).toBe(texts[written]);
  });

  it('serializes writes to one plan from two rooms in different workspaces', async () => {
    const first = await planRoom('# Plan\n');
    const second = fixture();
    const controller = second.controller();
    await controller.room.start();
    await controller.submit(`/plan resume ${first.plan}`);
    await first.turn();
    controller.room.send('Discuss');
    await tick();
    second.fakes.codex!.finish();
    await tick();
    const texts = ['# First room\n', '# Second room\n'];
    const results = await Promise.allSettled([
      first.tools.call('write_file', { path: first.plan, text: texts[0]! }),
      second.fakes.codex!.tools.call('write_file', { path: first.plan, text: texts[1]! }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const written = results.findIndex((result) => result.status === 'fulfilled');
    expect(readFileSync(first.plan, 'utf8')).toBe(texts[written]);
  });

  it('waits for a plan lock holder and proceeds when that process dies without releasing it', async () => {
    const { plan, turn, tools } = await planRoom('# Plan\n');
    await turn();
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `require('node:fs').openSync(${JSON.stringify(planLockFile(plan))}, 0x2 | 0x200 | 0x4 | 0x20, 0o600); console.log('locked'); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    cleanups.push(() => void holder.kill('SIGKILL'));
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
    let settled = false;
    const write = tools
      .call('write_file', { path: plan, text: '# After crash\n' })
      .finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    expect(readFileSync(plan, 'utf8')).toBe('# Plan\n');
    holder.kill('SIGKILL');
    await write;
    expect(readFileSync(plan, 'utf8')).toBe('# After crash\n');
    expect(existsSync(planLockFile(plan))).toBe(true);
  });

  it('cancels a plan call waiting for the lock on interrupt, maintenance or close', async () => {
    const { plan, turn, tools } = await planRoom('# Plan\n');
    await turn();
    const write = (text: string) => tools.call('write_file', { path: plan, text });
    let lock = tryPlanLock(plan)!;
    expect(lock).toBeDefined();
    const interrupted = write('# Interrupted\n');
    await new Promise((resolve) => setTimeout(resolve, 60));
    tools.interrupt();
    await expect(interrupted).rejects.toThrow('Interrupted');
    const maintenance = write('# Maintenance\n');
    await new Promise((resolve) => setTimeout(resolve, 60));
    tools.setMaintenance(true);
    await expect(maintenance).rejects.toThrow('Interrupted');
    tools.setMaintenance(false);
    // A maintenance flip this process did not interrupt (an MCP child's view) is rechecked on entry.
    const rechecked = write('# Rechecked\n');
    await new Promise((resolve) => setTimeout(resolve, 60));
    writeFileSync(tools.maintenanceFile, JSON.stringify({ active: true }));
    closeSync(lock);
    await expect(rechecked).rejects.toThrow('Task tools are denied during context maintenance');
    tools.setMaintenance(false);
    lock = tryPlanLock(plan)!;
    const closed = write('# Closed\n');
    await new Promise((resolve) => setTimeout(resolve, 60));
    tools.close();
    closeSync(lock);
    await expect(closed).rejects.toThrow(/Interrupted|Tool service closed/);
    expect(readFileSync(plan, 'utf8')).toBe('# Plan\n');
  });

  it('keeps plan-mode work queued while a plan write holds the lock, then sends what the plan warrants', async () => {
    const { f, plan, room } = await planRoom('# Plan\n');
    const fake = () => f.fakes.codex!;
    let inputs = 0;
    const held = async (message: string) => {
      const lock = tryPlanLock(plan)!;
      room.send(message);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(fake().inputs).toHaveLength(inputs);
      expect(room.session.messages.at(-1)!.deliveries.codex!.status).toBe('queued');
      return lock;
    };
    // An unseen short plan still arrives with its text once the writer lets go.
    closeSync(await held('Discuss'));
    await expect.poll(() => fake().inputs.length).toBe(++inputs);
    expect(fake().inputs.at(-1)!.plan).toMatchObject({ status: 'changed', text: '# Plan\n' });
    fake().finish();
    await tick();
    // Contention alone does not report an unchanged plan as changed.
    closeSync(await held('Again'));
    await expect.poll(() => fake().inputs.length).toBe(++inputs);
    expect(fake().inputs.at(-1)!.plan!.status).toBe('unchanged');
    fake().finish();
    await tick();
  });

  it('dispatches promptly on /plan off or a switch even while the old plan stays locked', async () => {
    const { f, plan, controller, room } = await planRoom('# Plan A\n');
    const fake = () => f.fakes.codex!;
    const other = join(f.other, 'plan b.md');
    writeFileSync(other, '# Plan B\n');
    const lock = tryPlanLock(plan)!;
    try {
      room.send('Discuss');
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(fake().inputs).toHaveLength(0);
      await controller.submit('/plan off');
      await expect.poll(() => fake().inputs.length).toBe(1);
      expect(fake().inputs[0]!.plan).toBeUndefined();
      fake().finish();
      await tick();
      await controller.submit(`/plan resume ${plan}`);
      room.send('Again');
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(fake().inputs).toHaveLength(1);
      await controller.submit('/plan off');
      await controller.submit(`/plan resume ${other}`);
      await expect.poll(() => fake().inputs.length).toBe(2);
      expect(fake().inputs[1]!.plan).toMatchObject({
        path: other,
        status: 'changed',
        text: '# Plan B\n',
      });
      // The hash recorded for that turn is plan B's, so the agent may write B without a reread.
      await fake().tools.call('write_file', { path: other, text: '# Plan B\n\n- Agreed\n' });
      fake().finish();
      await tick();
    } finally {
      closeSync(lock);
    }
  });

  it('sends plan data that matches the attachment when the provider receives the turn', async () => {
    const { f, plan, controller, room } = await planRoom('# Plan A\n');
    const other = join(f.other, 'plan b.md');
    writeFileSync(other, '# Plan B\n');
    const seen: [string | undefined, string | undefined][] = [];
    Fake.observe = (input) => seen.push([input.plan?.path, room.session.plan?.path]);
    // Commands queued right behind a send: the turn goes out with the plan attached then.
    room.send('Discuss');
    await controller.submit('/plan off');
    await tick();
    f.fakes.codex!.finish();
    await tick();
    await controller.submit(`/plan resume ${plan}`);
    room.send('Again');
    await controller.submit('/plan off');
    await controller.submit(`/plan resume ${other}`);
    await tick();
    f.fakes.codex!.finish();
    await tick();
    room.send('Third');
    await tick();
    expect(seen).toHaveLength(3);
    for (const [sent, attached] of seen) expect(sent).toBe(attached);
    expect(seen[2]).toEqual([other, other]);
  });

  it('holds a deferred turn through stop, then delivers the current plan on continue', async () => {
    const { f, plan, room, turn } = await planRoom('# Plan\n');
    await turn();
    writeFileSync(plan, '# Plan v2\n');
    const lock = tryPlanLock(plan)!;
    room.send('Discuss v2');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const stopping = room.stop('codex');
    closeSync(lock);
    await stopping;
    expect(room.session.messages.at(-1)!.deliveries.codex!.status).toBe('queued');
    expect(f.fakes.codex!.inputs).toHaveLength(1);
    await room.continue('codex');
    // The same provider session resumes and still receives v2, which it never saw.
    expect(f.fakes.codex!.starts).toEqual(['native-session']);
    await expect.poll(() => f.fakes.codex!.inputs.length).toBe(1);
    const input = f.fakes.codex!.inputs[0]!;
    expect(input.messages.map((message) => message.text)).toEqual(['Discuss v2']);
    expect(input.plan).toMatchObject({ status: 'changed', text: '# Plan v2\n' });
  });

  it('fails a turn whose plan hash cannot be recorded, without calling the provider', async () => {
    const { f, room } = await planRoom('# Plan\n');
    const agents = join(f.fakes.codex!.agent.planState!.directory, 'agents');
    chmodSync(agents, 0o500);
    try {
      room.send('Discuss');
      await expect
        .poll(() => room.session.messages.at(-1)!.deliveries.codex!.status)
        .toBe('failed');
      expect(f.fakes.codex!.inputs).toEqual([]);
      expect(room.session.notices.some((notice) => notice.text.startsWith('codex failed:'))).toBe(
        true,
      );
      await expect.poll(() => room.isIdle()).toBe(true);
    } finally {
      chmodSync(agents, 0o700);
    }
  });

  it('fails a turn whose plan state cannot be read instead of inventing plan data', async () => {
    const { f, room } = await planRoom('# Plan\n');
    const { directory } = f.fakes.codex!.agent.planState!;
    writeFileSync(join(directory, 'agents', 'codex.json'), '{');
    room.send('Discuss');
    await expect.poll(() => room.session.messages.at(-1)!.deliveries.codex!.status).toBe('failed');
    expect(f.fakes.codex!.inputs).toEqual([]);
    expect(room.session.notices.some((notice) => notice.text.startsWith('codex failed:'))).toBe(
      true,
    );
  });

  it('keeps plan-mode work queued past the tool deadline while the lock is held, inventing nothing', async () => {
    const { f, plan, room } = await planRoom('# Plan\n');
    const lock = tryPlanLock(plan)!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      room.send('Discuss');
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.fakes.codex!.inputs).toEqual([]);
      expect(room.session.messages.at(-1)!.deliveries.codex!.status).toBe('queued');
      closeSync(lock);
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
    await expect.poll(() => f.fakes.codex!.inputs.length).toBe(1);
    expect(f.fakes.codex!.inputs[0]!.plan).toMatchObject({ status: 'changed', text: '# Plan\n' });
  });

  it("clears a failed turn's new plan hash unless a tool recorded one since", async () => {
    const { f, plan, room, tools } = await planRoom('# Plan\n');
    const fake = () => f.fakes.codex!;
    room.send('Discuss');
    await tick();
    expect(fake().inputs.at(-1)!.plan!.text).toBe('# Plan\n');
    // A plan read during the turn records identical bytes; the interruption keeps that record.
    await tools.call('read_file', { path: plan });
    await room.stop('codex');
    await room.continue('codex');
    room.send('Next');
    await tick();
    expect(fake().inputs.at(-1)!.plan!.status).toBe('unchanged');
    fake().finish();
    await tick();
    // With no tool record since, an interrupted turn's new text is sent again.
    writeFileSync(plan, '# Plan v2\n');
    room.send('v2');
    await tick();
    expect(fake().inputs.at(-1)!.plan!.text).toBe('# Plan v2\n');
    await room.stop('codex');
    await room.continue('codex');
    room.send('After');
    await tick();
    expect(fake().inputs.at(-1)!.plan).toMatchObject({ status: 'changed', text: '# Plan v2\n' });
  });

  it('hands the plan lock to the file worker, which keeps it after the caller lets go', async () => {
    const { f, plan, turn, tools } = await planRoom('# Plan\n');
    await turn();
    vi.mocked(runProcess).mockClear();
    await tools.call('write_file', { path: plan, text: '# Next\n' });
    await tools.call('list_files', {});
    const workers = vi
      .mocked(runProcess)
      .mock.calls.filter(([, args]) => args.some((arg) => arg.endsWith('tool-worker.js')));
    expect(workers.map(([, , options]) => options?.inheritFds?.length ?? 0)).toEqual([1, 0]);
    // An inherited descriptor holds the lock even after the parent's copy closes, as on a crash.
    const lock = tryPlanLock(plan)!;
    const worker = runProcess(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        sandboxProfile(f.workspace, f.config.permissions, tools.scratch, true),
        '/bin/sleep',
        '1',
      ],
      { inheritFds: [lock] },
    );
    closeSync(lock);
    expect(tryPlanLock(plan)).toBeUndefined();
    expect((await worker).code).toBe(0);
    const free = tryPlanLock(plan);
    expect(free).toBeDefined();
    closeSync(free!);
  });

  it('includes the plan again after the provider compacts during a turn', async () => {
    const { f, room, turn } = await planRoom('# Plan\n');
    await turn();
    room.send('Discuss more');
    await tick();
    f.fakes.codex!.emit!({
      type: 'context',
      usage: { usedTokens: 10, updatedAt: new Date().toISOString() },
    });
    f.fakes.codex!.finish();
    await tick();
    expect((await turn()).plan!.status).toBe('unchanged');
    room.send('Discuss again');
    await tick();
    f.fakes.codex!.emit!({ type: 'context' });
    f.fakes.codex!.finish();
    await tick();
    expect((await turn()).plan).toMatchObject({ status: 'changed', text: '# Plan\n' });
  });

  it('refuses a stale plan write and accepts it after a reread in the same turn', async () => {
    const { plan, room, tools } = await planRoom('# Plan\n');
    room.send('Discuss');
    await tick();
    await tools.call('write_file', { path: plan, text: '# Plan\n\n- Agent edit\n' });
    writeFileSync(plan, '# Plan\n\n- Human edit\n');
    await expect(tools.call('write_file', { path: plan, text: '# Overwrite\n' })).rejects.toThrow(
      'Reread it with read_file',
    );
    expect(readFileSync(plan, 'utf8')).toBe('# Plan\n\n- Human edit\n');
    await tools.call('read_file', { path: plan });
    await tools.call('write_file', { path: plan, text: '# Plan\n\n- Human edit\n- Agent edit\n' });
    expect(readFileSync(plan, 'utf8')).toBe('# Plan\n\n- Human edit\n- Agent edit\n');
  });

  it('includes the plan again after a fresh provider session or compaction', async () => {
    const { room, turn } = await planRoom('# Plan\n');
    await turn();
    expect((await turn()).plan!.status).toBe('unchanged');
    Fake.nextSession = 'replacement-session';
    await room.reconnect('codex');
    await room.continue('codex');
    expect((await turn()).plan).toMatchObject({ status: 'changed', text: '# Plan\n' });
    expect((await turn()).plan!.status).toBe('unchanged');
    room.compact('codex');
    await expect.poll(() => room.session.agents.codex!.maintenance?.status).toBe('completed');
    expect((await turn()).plan).toMatchObject({ status: 'changed', text: '# Plan\n' });
  });

  it('reports a missing plan in turns and the snapshot, and stays in plan mode', async () => {
    const { plan, controller, room, turn, tools } = await planRoom('# Plan\n');
    await turn();
    unlinkSync(plan);
    expect((await turn()).plan).toMatchObject({ path: plan, status: 'missing' });
    expect(controller.snapshot().plan).toEqual({ path: plan, name: 'plan.md', missing: true });
    await expect(tools.call('write_file', { path: plan, text: 'x' })).rejects.toThrow(
      `The plan file is missing: ${plan}`,
    );
    expect(room.session.plan?.path).toBe(plan);
    writeFileSync(plan, '# Back\n');
    expect((await turn()).plan).toMatchObject({ status: 'changed', text: '# Back\n' });
  });

  it('notes an agent plan edit in the transcript without dispatching it', async () => {
    const { f, plan, room, tools } = await planRoom('# Plan\n', ['codex', 'claude']);
    room.send('codex, add a decision');
    await tick();
    await tools.call('write_file', { path: plan, text: '# Plan\n\n- Decision (#m1)\n' });
    expect(room.session.notices.some((notice) => notice.text === 'codex edited the plan.')).toBe(
      false,
    );
    f.fakes.claude!.finish();
    await tick();
    expect(room.session.notices.some((notice) => notice.text === 'claude edited the plan.')).toBe(
      false,
    );
    f.fakes.codex!.finish();
    await tick();
    expect(lastNotice(room)).toBe('codex edited the plan.');
    await tick();
    expect(room.session.messages).toHaveLength(1);
    expect(f.fakes.claude!.inputs).toHaveLength(1);
    expect(f.fakes.codex!.inputs).toHaveLength(1);
  });
});

describe('saved plan mode', () => {
  it('reopens in plan mode with a notice, restores hashes and runs queued messages without a hold', async () => {
    const f = fixture();
    const plan = join(f.other, 'plan.md');
    writeFileSync(plan, '# Plan\n');
    const first = f.open();
    await first.start();
    first.resumePlan(plan);
    first.send('Discuss');
    await tick();
    f.fakes.codex!.finish();
    await tick();
    first.pause();
    first.send('Queued while paused');
    await first.close();
    const saved = f.store.load(first.session.id)!;
    expect(saved.plan).toEqual({ path: plan, hashes: { codex: planHash('# Plan\n') } });
    const reopened = f.open(saved);
    expect(reopened.session.notices.map((notice) => notice.text)).toContain(
      'This conversation is still in plan mode with plan.md. Run /plan off to leave it.',
    );
    expect(reopened.planStatus()).toEqual({ path: plan, name: 'plan.md', missing: false });
    await reopened.start();
    await tick();
    expect(reopened.session.paused).toBe(false);
    const input = f.fakes.codex!.inputs.at(-1)!;
    expect(input.messages.map((message) => message.text)).toEqual(['Queued while paused']);
    expect(input.plan).toMatchObject({ path: plan, status: 'unchanged' });
    await expect(
      f.fakes.codex!.tools.call('write_file', { path: 'x.md', text: 'x' }),
    ).rejects.toThrow('Plan mode is on');
  });

  it('reopens a conversation saved with plan mode off, or saved before plan mode, with it off', async () => {
    const f = fixture();
    const plan = join(f.other, 'plan.md');
    writeFileSync(plan, '# Plan\n');
    const first = f.open();
    await first.start();
    first.resumePlan(plan);
    first.endPlan();
    await first.close();
    const saved = f.store.load(first.session.id)!;
    expect(saved.plan).toBeUndefined();
    const reopened = f.open(saved);
    expect(reopened.planStatus()).toBeUndefined();
    expect(reopened.session.notices.map((notice) => notice.text).join('\n')).not.toContain(
      'plan mode',
    );
    const legacy = structuredClone(saved);
    delete legacy.plan;
    expect(projectRoom(f.open(legacy)).plan).toBeUndefined();
  });

  it('starts /new with plan mode off and restores plan mode through /sessions', async () => {
    const f = fixture();
    const controller = f.controller();
    await controller.room.start();
    await controller.submit('/plan');
    const path = controller.room.session.plan!.path;
    const id = controller.room.session.id;
    await controller.submit('/new');
    expect(controller.room.session.plan).toBeUndefined();
    expect(controller.snapshot().plan).toBeUndefined();
    await controller.submit(`/sessions ${id}`);
    expect(controller.room.session.plan?.path).toBe(path);
    expect(lastNotice(controller.room)).not.toBe('');
    expect(controller.room.session.notices.map((notice) => notice.text)).toContain(
      `This conversation is still in plan mode with ${path.split('/').at(-1)}. Run /plan off to leave it.`,
    );
  });
});
