import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { commandAccessSummary } from '../src/command-access.js';
import { parseCliOptions } from '../src/cli-options.js';
import { ToolService, toolSpecs } from '../src/tools.js';
import { forwardCommand } from '../src/command-broker.js';
import { instructions } from '../src/protocol.js';
import { Room, newSession } from '../src/room.js';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, RoomConfig } from '../src/types.js';

const roots: string[] = [];
const services: ToolService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-trusted-test-')));
  roots.push(root);
  const home = join(root, 'home'),
    workspace = join(home, 'project');
  for (const dir of [home, workspace]) mkdirSync(join(dir, '.agents'), { recursive: true });
  const user = join(home, '.agents/chittr.yaml'),
    project = join(workspace, '.agents/chittr.yaml');
  const write = (edits = true, commands = true, network = true, grant = true) => {
    writeFileSync(
      user,
      `version: 1\nskills: {enabled: false}\ndefaultAgents: {agent: {provider: codex, enabled: false}}\n${grant ? 'trustedCommands: {workspaces: ["~/project"]}\n' : ''}`,
    );
    writeFileSync(
      project,
      `version: 1\npermissions: {edits: ${edits}, commands: ${commands}, network: ${network}}\n`,
    );
    return loadConfig(workspace, home)!;
  };
  return { root, home, workspace, user, project, write };
}

it.each(Array.from({ length: 8 }, (_, n) => [Boolean(n & 1), Boolean(n & 2), Boolean(n & 4)]))(
  'resolves persistent and explicit trust with edits=%s commands=%s network=%s',
  (edits, commands, network) => {
    const f = fixture();
    const config = f.write(edits, commands, network);
    expect(config.commandAccess?.mode).toBe(
      edits && commands && network ? 'trusted' : commands ? 'sandboxed' : 'off',
    );
    expect(config.commandAccess?.source).toContain(f.user);
    if (!(edits && commands && network)) {
      expect(commandAccessSummary(config)).toContain('Trust inactive');
      for (const blocked of config.commandAccess!.blockedBy) {
        expect(blocked.source).toBe(f.project);
        expect(commandAccessSummary(config)).toContain(
          `permissions.${blocked.permission}=false from ${f.project}`,
        );
      }
      expect(() => loadConfig(f.workspace, f.home, { trustedCommands: true })).toThrow(
        '--trusted-commands requires',
      );
    } else {
      expect(
        loadConfig(f.workspace, f.home, { trustedCommands: true })!.commandAccess,
      ).toMatchObject({ mode: 'trusted', source: '--trusted-commands' });
    }
    expect(f.write(edits, commands, network, false).commandAccess?.mode).toBe(
      commands ? 'sandboxed' : 'off',
    );
  },
);

it('grants only an exact canonical workspace, including aliases but not descendants or other worktrees', () => {
  const f = fixture();
  f.write();
  const alias = join(f.root, 'alias'),
    nested = join(f.workspace, 'nested'),
    other = join(f.root, 'other');
  symlinkSync(f.workspace, alias);
  mkdirSync(nested);
  mkdirSync(other);
  expect(loadConfig(alias, f.home)!.commandAccess?.mode).toBe('trusted');
  for (const path of [nested, other])
    expect(loadConfig(path, f.home)!.commandAccess?.source).toBeUndefined();
  writeFileSync(f.user, readFileSync(f.user, 'utf8').replace('~/project', alias));
  expect(loadConfig(f.workspace, f.home)!.commandAccess?.mode).toBe('trusted');
  writeFileSync(f.user, readFileSync(f.user, 'utf8').replace(alias, join(f.root, 'removed')));
  expect(loadConfig(f.workspace, f.home)!.commandAccess?.source).toBeUndefined();
});

it.each([
  'trustedCommands: {workspaces: []}',
  'trustedCommands: {workspaces: ["/"]}',
  'permissions: {commands: trusted}',
])('rejects a project trust declaration: %s', (declaration) => {
  const f = fixture();
  f.write();
  writeFileSync(f.project, `version: 1\n${declaration}`);
  expect(() => loadConfig(f.workspace, f.home)).toThrow(
    `Trust can only be granted through trustedCommands.workspaces in ${f.user}`,
  );
});

it('rejects relative workspace grants and leaves the launch flag out of YAML', () => {
  const f = fixture();
  f.write(true, true, true, false);
  const before = readFileSync(f.user, 'utf8');
  expect(
    parseCliOptions(['resume', 'saved-id', '--web', '--trusted-commands']).values[
      'trusted-commands'
    ],
  ).toBe(true);
  expect(loadConfig(f.workspace, f.home, { trustedCommands: true })!.commandAccess?.mode).toBe(
    'trusted',
  );
  expect(readFileSync(f.user, 'utf8')).toBe(before);
  writeFileSync(f.user, before + 'trustedCommands: {workspaces: [project]}\n');
  expect(() => loadConfig(f.workspace, f.home)).toThrow('absolute paths or ~/');
});

function trustedService(f = fixture(), environment: NodeJS.ProcessEnv = {}) {
  const service = new ToolService(
    f.workspace,
    { edits: true, commands: true, network: true },
    undefined,
    [],
    { mode: 'trusted', environment },
  );
  services.push(service);
  return { f, service };
}

it('executes MCP commands in the room launch environment, keeps credentials out of settings, and binds each endpoint to its policy', async () => {
  const f = fixture();
  writeFileSync(join(f.home, 'marker'), 'external-config');
  const env = {
    HOME: f.home,
    PATH: '/usr/bin:/bin',
    GOOGLE_APPLICATION_CREDENTIALS: 'exported-marker',
  };
  const { service } = trustedService(f, env);
  env.HOME = '/isolated-provider-home';
  const settings = await service.mcpSettings('grok');
  expect(JSON.stringify(settings)).not.toContain('exported-marker');
  const result = (await forwardCommand(settings.commandEndpoint, {
    command: 'cat "$HOME/marker"; printf " %s" "$GOOGLE_APPLICATION_CREDENTIALS"',
  })) as any;
  expect(result).toMatchObject({ exitCode: 0, stdout: 'external-config exported-marker' });
  const other = new ToolService(f.workspace, { edits: false, commands: false, network: false });
  services.push(other);
  const disabled = await other.mcpSettings('claude');
  await expect(
    forwardCommand(disabled.commandEndpoint, { command: 'echo forbidden' }),
  ).rejects.toThrow('Missing permission');
  await expect(
    forwardCommand(
      { ...settings.commandEndpoint, credentialFile: disabled.commandEndpoint.credentialFile },
      { command: 'echo forbidden' },
    ),
  ).rejects.toThrow('not authorized');
  await expect(
    forwardCommand(settings.commandEndpoint, {
      command: 'echo forbidden',
      environment: { HOME: '/' },
    } as any),
  ).rejects.toThrow('Invalid command request');
  service.close();
  await expect(
    forwardCommand(settings.commandEndpoint, { command: 'echo revoked' }),
  ).rejects.toThrow();
});

it('kills a forwarded command on cancellation and enforces timeout and output bounds', async () => {
  const { f, service } = trustedService(undefined, { PATH: '/usr/bin:/bin' });
  const settings = await service.mcpSettings('claude');
  const signal = new AbortController();
  const running = forwardCommand(
    settings.commandEndpoint,
    { command: 'echo $$ > shell.pid; sleep 20' },
    signal.signal,
  );
  await expect.poll(() => existsSync(join(f.workspace, 'shell.pid'))).toBe(true);
  const pid = Number(readFileSync(join(f.workspace, 'shell.pid'), 'utf8'));
  signal.abort();
  await expect(running).rejects.toThrow('Interrupted');
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  await expect(
    forwardCommand(settings.commandEndpoint, { command: 'sleep 20', timeout_ms: 100 }),
  ).rejects.toThrow('timed out');
  await expect(service.call('run_command', { command: '/usr/bin/yes output' })).rejects.toThrow(
    'output exceeded',
  );
});

it('refreshes all executors and instructions when trust changes, without restoring saved authorization', async () => {
  const f = fixture();
  const config = f.write();
  config.agents.agent!.enabled = true;
  const starts: { mode?: string; id?: string; environment: NodeJS.ProcessEnv }[] = [];
  let closed = 0;
  const factory = (
    _agent: unknown,
    c: RoomConfig,
    environment: NodeJS.ProcessEnv,
  ): AgentAdapter => ({
    async start(id) {
      starts.push({ mode: c.commandAccess?.mode, id, environment });
      return { sessionId: 'provider-session', restored: false };
    },
    async run() {
      return { outcomes: [] };
    },
    async interrupt() {},
    async close() {
      closed++;
    },
  });
  let saved = newSession(config);
  const room = new Room(
    config,
    {
      save(s) {
        saved = structuredClone(s);
      },
    },
    undefined,
    factory,
    { HOME: 'launch-home' },
  );
  try {
    await room.start();
    const next = { ...config, commandAccess: { mode: 'sandboxed' as const, blockedBy: [] } };
    await room.reload(next);
    expect(closed).toBe(1);
    expect(starts.map((s) => [s.mode, s.id, s.environment.HOME])).toEqual([
      ['trusted', undefined, 'launch-home'],
      ['sandboxed', undefined, 'launch-home'],
    ]);
    await room.reload(config);
    expect(saved.commandMode).toBe('trusted');
  } finally {
    await room.close();
  }
  const current = f.write(true, true, true, false);
  const resumed = new Room(current, { save() {} }, saved, factory);
  try {
    expect(resumed.session.commandMode).toBe('sandboxed');
    expect(resumed.session.agents.agent!.sessionId).toBeUndefined();
    expect(resumed.session.notices.at(-1)?.text).toContain('no longer active');
    const prompt = instructions(config.agents.agent!, config);
    expect(prompt).toContain('not a room-wide filesystem boundary');
    expect(toolSpecs('trusted').find((s) => s.name === 'run_command')?.description).toContain(
      'outside the workspace',
    );
  } finally {
    await resumed.close();
  }
});

it('rereads authorization when switching saved chats in the same process', async () => {
  const f = fixture();
  const config = f.write();
  const store = new SessionStore(f.workspace, join(f.root, 'state'));
  store.acquire();
  const saved = newSession(config);
  store.save(saved);
  const controller = new RoomController(config, store, undefined, {
    help: '',
    async quit() {},
    loadConfig: () => loadConfig(f.workspace, f.home),
  });
  try {
    await controller.room.start();
    f.write(true, true, true, false);
    await controller.submit(`/sessions ${saved.id}`);
    expect(controller.room.config.commandAccess?.mode).toBe('sandboxed');
    expect(controller.room.session.commandMode).toBe('sandboxed');
  } finally {
    await controller.close();
    store.release();
  }
});

it('keeps a launch flag through reload and conversation switching but never through a new launch', async () => {
  const f = fixture();
  f.write(true, true, true, false);
  const current = () => loadConfig(f.workspace, f.home, { trustedCommands: true })!;
  const store = new SessionStore(f.workspace, join(f.root, 'state'));
  store.acquire();
  const controller = new RoomController(current(), store, undefined, {
    help: '',
    async quit() {},
    loadConfig: current,
  });
  try {
    await controller.room.start();
    const previous = controller.room.session.id;
    await controller.submit('/reload');
    await controller.submit('/new');
    await controller.submit(`/sessions ${previous}`);
    expect(controller.room.config.commandAccess).toMatchObject({
      mode: 'trusted',
      source: '--trusted-commands',
    });
    const saved = store.load(previous);
    expect(saved?.commandMode).toBe('trusted');
    const relaunched = new Room(loadConfig(f.workspace, f.home)!, { save() {} }, saved);
    try {
      expect(relaunched.session.commandMode).toBe('sandboxed');
    } finally {
      await relaunched.close();
    }
    f.write(true, true, false, false);
    await expect(controller.submit('/reload')).rejects.toThrow('--trusted-commands requires');
    expect(controller.room.config.commandAccess?.mode).toBe('trusted');
  } finally {
    await controller.close();
    store.release();
  }
});
