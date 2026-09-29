import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAdapter, codexVersionSatisfies } from '../src/adapters/codex.js';
import { ClaudeAdapter, claudeLaunchControls } from '../src/adapters/claude.js';
import { ToolService } from '../src/tools.js';
import type { AgentAdapter, AgentConfig, RoomConfig } from '../src/types.js';

const fixture = vi.hoisted(() => ({
  processes: [] as any[],
  codexModels: [] as any[],
  claudeModels: [] as any[],
  paginate: false,
  claudeVersion: '2.1.266 (Claude Code)',
  codexVersion: 'codex-cli 0.153.4',
  /** Overrides merged into the scripted config/read and thread/start policy. */
  codexConfig: {} as any,
  codexThread: {} as any,
  claudeFlags:
    '--restricted --replay-user-messages --include-partial-messages --strict-mcp-config --tools --disallowedTools --allowedTools --permission-mode --setting-sources --settings --mcp-config --json-schema --no-chrome --effort',
}));
vi.mock('../src/process.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/process.js')>();
  const { EventEmitter } = await import('node:events');
  class FakeProcess extends EventEmitter {
    closed = false;
    calls: { method: string; params: any }[] = [];
    sent: any[] = [];
    settings: Record<string, string> = {};
    profile = '';
    constructor(
      public command: string,
      public args: string[],
      _cwd: string,
      public env = original.providerEnv(),
    ) {
      super();
      fixture.processes.push(this);
      for (let i = 0; i < args.length; i++)
        if (args[i] === '-c') {
          const setting = args[++i]!;
          this.settings[setting.slice(0, setting.indexOf('='))] = setting.slice(
            setting.indexOf('=') + 1,
          );
        }
      this.profile =
        Object.keys(this.settings)
          .find((key) => key.startsWith('permissions.') && key.endsWith('.filesystem'))
          ?.split('.')[1] ?? '';
    }
    async rpc(method: string, params: any) {
      this.calls.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      // The scripted native policy satisfies every check the adapter observes;
      // fixture.codexConfig and fixture.codexThread override parts of it.
      if (method === 'config/read')
        return {
          config: {
            features: Object.fromEntries(
              Object.entries(this.settings)
                .filter(([key]) => key.startsWith('features.'))
                .map(([key, value]) => [key.slice(9), JSON.parse(value)]),
            ),
            web_search: 'disabled',
            mcp_servers: {},
            permissions: {
              [this.profile]: {
                extends: null,
                network: { enabled: false },
                filesystem: JSON.parse(
                  this.settings[`permissions.${this.profile}.filesystem`]!.replaceAll(' = ', ': '),
                ),
              },
            },
            ...fixture.codexConfig,
          },
        };
      if (method === 'thread/start' || method === 'thread/resume')
        return {
          thread: { id: 'test-thread', environments: [] },
          model: 'test-model',
          cwd: params.cwd,
          activePermissionProfile: { id: this.profile, extends: null },
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly', networkAccess: false },
          runtimeWorkspaceRoots: [],
          ...fixture.codexThread,
        };
      if (method === 'model/list')
        return fixture.paginate && !params.cursor
          ? { data: [], nextCursor: 'next-page' }
          : { data: fixture.codexModels, nextCursor: null };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.emit('message', {
            method: 'item/completed',
            params: {
              item: {
                type: 'agentMessage',
                text: JSON.stringify({
                  outcomes: [
                    {
                      messageIds: ['m1'],
                      kind: 'pass',
                      text: 'Nothing to add',
                      recipients: [],
                    },
                  ],
                }),
              },
            },
          });
          this.emit('message', {
            method: 'turn/completed',
            params: { turn: { status: 'completed' } },
          });
        });
        return { turn: { id: 'test-turn' } };
      }
      return {};
    }
    send(message: any) {
      this.sent.push(message);
      if (message.type === 'control_request' && message.request.subtype === 'initialize')
        queueMicrotask(() =>
          this.emit('message', {
            type: 'control_response',
            response: {
              request_id: message.request_id,
              subtype: 'success',
              response: { models: fixture.claudeModels },
            },
          }),
        );
    }
    async close() {
      this.closed = true;
    }
  }
  return {
    ...original,
    JsonLinesProcess: FakeProcess,
    runProcess: vi.fn(async (command: string, args: string[]) => ({
      code: 0,
      stderr: '',
      stdout:
        command === 'codex'
          ? fixture.codexVersion
          : args[0] === '--version'
            ? fixture.claudeVersion
            : JSON.stringify({
                loggedIn: true,
                authMethod: 'oauth',
                flags: fixture.claudeFlags,
              }),
    })),
  };
});

let directory: string;
let config: RoomConfig;
const adapters: AgentAdapter[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'chittr-effort-adapters-'));
  // Satisfy Codex's executable discovery without requiring an installed CLI.
  symlinkSync(process.execPath, join(directory, 'codex'));
  vi.stubEnv('PATH', directory);
  vi.stubEnv('CODEX_HOME', directory);
  fixture.processes = [];
  fixture.paginate = false;
  fixture.claudeVersion = '2.1.266 (Claude Code)';
  fixture.codexVersion = 'codex-cli 0.153.4';
  fixture.codexConfig = {};
  fixture.codexThread = {};
  fixture.claudeFlags =
    '--restricted --replay-user-messages --include-partial-messages --strict-mcp-config --tools --disallowedTools --allowedTools --permission-mode --setting-sources --settings --mcp-config --json-schema --no-chrome --effort';
  fixture.codexModels = [
    {
      id: 'test-model',
      model: 'test-model',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(
        (reasoningEffort) => ({ reasoningEffort }),
      ),
    },
  ];
  fixture.claudeModels = [
    {
      value: 'test-model',
      resolvedModel: 'test-model',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  ];
  vi.spyOn(ToolService.prototype, 'check').mockResolvedValue();
  config = {
    workspace: directory,
    permissions: { edits: false, commands: false, network: false },
    skills: { enabled: false },
    followUpTurns: 8,
    agents: {},
    sources: [],
    provenance: {},
  };
});
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function agent(id: string, provider: 'codex' | 'claude', effort?: string): AgentConfig {
  return {
    id,
    provider,
    effort,
    model: 'test-model',
    enabled: true,
    instructions: '',
    fingerprint: id,
  };
}

it.each([undefined, 'saved-thread'])(
  'keeps Codex effort independent at launch and on every turn, resuming %s',
  async (sessionId) => {
    for (const [id, effort] of [
      ['astra', 'high'],
      ['sol', 'medium'],
      ['default', undefined],
    ]) {
      const adapter = new CodexAdapter(agent(id!, 'codex', effort), config);
      adapters.push(adapter);
      await adapter.start(sessionId);
      const process = fixture.processes.at(-1)!;
      expect(process.command).toBe(realpathSync(join(directory, 'codex')));
      const overrides = process.args.filter((arg: string) =>
        arg.startsWith('model_reasoning_effort='),
      );
      expect(overrides).toEqual(effort ? [`model_reasoning_effort="${effort}"`] : []);
      expect(process.calls.some((call: any) => call.method === 'model/list')).toBe(Boolean(effort));
      expect(
        process.calls.some(
          (call: any) => call.method === (sessionId ? 'thread/resume' : 'thread/start'),
        ),
      ).toBe(true);
      for (let turn = 0; turn < 2; turn++) {
        await adapter.run(
          { participants: [id!], context: [], messages: [] },
          () => {},
          new AbortController().signal,
        );
        const params = process.calls
          .filter((call: any) => call.method === 'turn/start')
          .at(-1)!.params;
        if (effort) expect(params.effort).toBe(effort);
        else expect(params).not.toHaveProperty('effort');
        expect(params.approvalPolicy).toBe('never');
        expect(params.environments).toEqual([]);
      }
    }
  },
);

it.each([undefined, 'saved-thread'])(
  'rejects effort outside the resolved Codex model catalogue on start or resume: %s',
  async (sessionId) => {
    fixture.paginate = true;
    fixture.codexModels[0].supportedReasoningEfforts = [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'high' },
    ];
    const adapter = new CodexAdapter(
      { ...agent('astra', 'codex', 'max'), model: 'model-alias' },
      config,
    );
    adapters.push(adapter);
    await expect(adapter.start(sessionId)).rejects.toThrow(
      '@astra: Unsupported effort "max" for codex model "test-model". Accepted values: low, high',
    );
    const calls = fixture.processes[0].calls;
    expect(
      calls.filter((call: any) => call.method === 'model/list').map((call: any) => call.params),
    ).toEqual([{ includeHidden: true }, { includeHidden: true, cursor: 'next-page' }]);
    expect(calls.some((call: any) => call.method === 'turn/start')).toBe(false);
  },
);

it('rejects a Codex model that advertises no effort levels', async () => {
  fixture.codexModels[0].supportedReasoningEfforts = [];
  const adapter = new CodexAdapter(agent('astra', 'codex', 'high'), config);
  adapters.push(adapter);
  await expect(adapter.start()).rejects.toThrow('this model does not support effort');
});

it.each(['sonnet', 'claude-test', undefined])(
  'checks Claude effort against advertised model capabilities for %s',
  async (model) => {
    fixture.claudeModels = [
      {
        value: model ? 'sonnet[1m]' : 'default',
        resolvedModel: 'claude-test',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
    ];
    const adapter = new ClaudeAdapter({ ...agent('reviewer', 'claude', 'xhigh'), model }, config);
    adapters.push(adapter);
    await expect(adapter.start()).rejects.toThrow(
      '@reviewer: Unsupported effort "xhigh" for claude model "claude-test". Accepted values: low, medium, high',
    );
  },
);

it('rejects effort when Claude explicitly reports that the model does not support it', async () => {
  fixture.claudeModels = [{ value: 'test-model', supportsEffort: false }];
  const adapter = new ClaudeAdapter(agent('reviewer', 'claude', 'high'), config);
  adapters.push(adapter);
  await expect(adapter.start()).rejects.toThrow('this model does not support effort');
});

it('does not mistake the current Claude default for an unreported model in a resumed session', async () => {
  fixture.claudeModels = [{ value: 'default', supportedEffortLevels: ['low'] }];
  const adapter = new ClaudeAdapter(
    { ...agent('reviewer', 'claude', 'high'), model: undefined },
    config,
  );
  adapters.push(adapter);
  await expect(adapter.start('saved-session')).resolves.toMatchObject({
    sessionId: 'saved-session',
  });
});

it('keeps CLI model aliases usable when no matching capability entry is available', async () => {
  fixture.codexModels = [];
  fixture.claudeModels = [];
  for (const [Adapter, provider] of [
    [CodexAdapter, 'codex'],
    [ClaudeAdapter, 'claude'],
  ] as const) {
    const adapter = new Adapter(agent('reviewer', provider, 'high'), config);
    adapters.push(adapter);
    await expect(adapter.start()).resolves.toMatchObject({ restored: false });
  }
});

it('clears a prior Claude refusal boundary after start creates a fresh transport', async () => {
  const adapter = new ClaudeAdapter(agent('reviewer', 'claude', 'high'), config);
  adapters.push(adapter);
  await adapter.start();
  let process = fixture.processes.at(-1)!;
  const refused = adapter.run(
    { participants: ['reviewer'], context: [], messages: [] },
    () => {},
    new AbortController().signal,
  );
  const requestUuid = process.sent.find((message: any) => message.type === 'user').uuid;
  process.emit('message', {
    type: 'system',
    subtype: 'model_refusal_no_fallback',
    api_refusal_category: 'reasoning_extraction',
    api_refusal_explanation: 'Provider refusal',
    refused_user_message_uuid: requestUuid,
  });
  await expect(refused).rejects.toThrow('Claude provider refusal');
  await expect(
    adapter.run(
      { participants: ['reviewer'], context: [], messages: [] },
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow('unavailable after a provider refusal');

  await adapter.start();
  process = fixture.processes.at(-1)!;
  const pending = adapter.run(
    { participants: ['reviewer'], context: [], messages: [] },
    () => {},
    new AbortController().signal,
  );
  expect(process.sent.some((message: any) => message.type === 'user')).toBe(true);
  process.emit('message', {
    type: 'result',
    structured_output: {
      outcomes: [{ messageIds: ['m1'], kind: 'pass', text: 'Nothing to add', recipients: [] }],
    },
  });
  await expect(pending).resolves.toMatchObject({ sessionId: expect.any(String) });
});

it.each([undefined, 'saved-session'])(
  'sets Claude effort per process without leaking or losing inherited defaults, resuming %s',
  async (sessionId) => {
    vi.stubEnv('CLAUDE_CODE_EFFORT_LEVEL', 'low');
    for (const effort of ['high', 'max', undefined]) {
      const adapter = new ClaudeAdapter(agent('reviewer', 'claude', effort), config);
      adapters.push(adapter);
      await adapter.start(sessionId);
      const child = fixture.processes.at(-1)!;
      if (effort) {
        expect(child.args[child.args.indexOf('--effort') + 1]).toBe(effort);
        expect(child.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
      } else {
        expect(child.args).not.toContain('--effort');
        expect(child.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
      }
      expect(process.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
      expect(child.args).toContain(sessionId ? '--resume' : '--session-id');
      expect(child.args).toContain('--restricted');
    }
  },
);

// #105: the native compaction route is attempt-then-validate on every build.
// The built-in /compact command is reachable, so no build launches with
// `--disable-slash-commands`; the native task surface is bounded by the launch
// controls instead, on the historical build and on uncatalogued newer ones.
it.each([
  '2.1.266 (Claude Code)',
  '2.1.267 (Claude Code)',
  '2.1.274 (Claude Code)',
  '2.1.400 (Claude Code)',
  '3.0.0 (Claude Code)',
])('exposes built-in /compact under the same launch controls on %s', async (version) => {
  fixture.claudeVersion = version;
  const adapter = new ClaudeAdapter(agent('reviewer', 'claude'), config);
  adapters.push(adapter);
  expect(adapter.nativeCompaction).toBe(false);
  await adapter.start();
  const child = fixture.processes.at(-1)!;
  expect(adapter.nativeCompaction).toBe(true);
  expect(adapter.sourceHandoff).toBe(false);
  expect(child.args).not.toContain('--disable-slash-commands');
  expect(child.args[child.args.indexOf('--tools') + 1]).toBe('');
  expect(child.args[child.args.indexOf('--disallowedTools') + 1]).toBe('Skill,Agent,Task');
  expect(child.args[child.args.indexOf('--allowedTools') + 1]).toBe('mcp__chittr__*');
  expect(child.args[child.args.indexOf('--setting-sources') + 1]).toBe('');
  expect(child.args[child.args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  expect(JSON.parse(child.args[child.args.indexOf('--settings') + 1])).toMatchObject({
    disableAllHooks: true,
    disableBundledSkills: true,
    disableSkillShellExecution: true,
    enabledPlugins: {},
  });
  expect(child.args).toContain('--restricted');
  expect(child.args).toContain('--strict-mcp-config');
  expect(child.args).toContain('--no-chrome');
  await adapter.close();
  expect(adapter.nativeCompaction).toBe(false);
});

it.each([...claudeLaunchControls])(
  'refuses a Claude CLI that lacks the %s launch control, naming the flag, before any process starts',
  async (flag) => {
    fixture.claudeVersion = '3.0.0 (Claude Code)';
    fixture.claudeFlags = fixture.claudeFlags.replace(flag, '');
    const adapter = new ClaudeAdapter(agent('reviewer', 'claude'), config);
    adapters.push(adapter);
    await expect(adapter.start()).rejects.toThrow(`Installed Claude Code lacks ${flag}`);
    expect(adapter.nativeCompaction).toBe(false);
    expect(fixture.processes).toHaveLength(0);
  },
);

// #105: the only Codex version condition is a forward-compatible minimum for
// app-server restricted-read support. No ceiling, no catalog row.
it.each([
  ['codex-cli 0.152.9', false],
  ['codex-cli 0.153.0', true],
  ['codex-cli 0.153.4', true],
  ['codex-cli 0.156.1', true],
  ['codex-cli 0.999.0', true],
  ['codex-cli 1.0.0', true],
  ['codex-cli 1.2.3', true],
  ['codex-cli 12.0.0', true],
  ['codex-cli 0.153.4 (build abc)', true],
])('compares the Codex minimum forward-compatibly: %s', (stdout, accepted) => {
  expect(codexVersionSatisfies(stdout)).toBe(accepted);
  expect(codexVersionSatisfies(stdout, [1, 0, 0])).toBe(
    !stdout.startsWith('codex-cli 0.') && accepted,
  );
});
it.each(['', 'codex 0.156.1', 'codex-cli x.y.z', 'not a version at all'])(
  'reports an unreadable Codex identity instead of guessing: %s',
  (stdout) => {
    expect(codexVersionSatisfies(stdout)).toBeUndefined();
  },
);
it.each(['codex-cli 0.153.0', 'codex-cli 0.156.1', 'codex-cli 1.0.0', 'codex-cli 7.3.1'])(
  'starts Codex on %s and selects the native compaction and handoff routes after the policy passed',
  async (version) => {
    fixture.codexVersion = version;
    const adapter = new CodexAdapter(agent('astra', 'codex'), config);
    adapters.push(adapter);
    expect(adapter.nativeCompaction).toBe(false);
    expect(adapter.sourceHandoff).toBe(false);
    await adapter.start();
    expect(adapter.nativeCompaction).toBe(true);
    expect(adapter.sourceHandoff).toBe(true);
    expect(adapter.imageEvidence).toMatchObject({
      cliVersion: version,
      nativePolicyVerified: true,
      nativeMaintenancePolicyFailures: [],
    });
    const child = fixture.processes.at(-1)!;
    expect(child.settings.default_permissions).toBe(JSON.stringify(child.profile));
    await adapter.close();
    expect(adapter.nativeCompaction).toBe(false);
    expect(adapter.sourceHandoff).toBe(false);
  },
);
// The maintenance routes need the observed native policy, on any identity. The
// fresh-thread projection is image-only (#63): a resumed thread keeps them.
it.each([
  [
    'a sandbox with network access',
    { thread: { sandbox: { type: 'readOnly', networkAccess: true } } },
    ['networkDisabled'],
  ],
  [
    'a writable sandbox',
    { thread: { sandbox: { type: 'workspaceWrite', networkAccess: false } } },
    ['readOnly'],
  ],
  [
    'another active permission profile',
    { thread: { activePermissionProfile: { id: 'other', extends: null } } },
    ['namedProfileMatches'],
  ],
  ['a non-user approvals reviewer', { thread: { approvalsReviewer: 'agent' } }, ['reviewerIsUser']],
  [
    'a missing policy observation',
    { thread: { sandbox: undefined } },
    ['readOnly', 'networkDisabled'],
  ],
  ['an enabled web search', { config: { web_search: 'live' } }, ['webSearchDisabled']],
])(
  'refuses Codex startup, naming the failed observation, for %s',
  async (_name, overrides: any, failures) => {
    fixture.codexVersion = 'codex-cli 1.4.0';
    fixture.codexThread = overrides.thread ?? {};
    fixture.codexConfig = overrides.config ?? {};
    const adapter = new CodexAdapter(agent('astra', 'codex'), config);
    adapters.push(adapter);
    await expect(adapter.start()).rejects.toThrow(
      `Codex native policy checks failed on the started thread: ${failures.join(', ')}; the room cannot enforce its policy`,
    );
    expect(adapter.nativeCompaction).toBe(false);
    expect(adapter.sourceHandoff).toBe(false);
    expect(adapter.imageEvidence.nativeMaintenancePolicyFailures).toEqual(failures);
    expect(fixture.processes.at(-1)!.closed).toBe(true);
    // Neither a native route nor a replacement can start on that thread.
    await expect(
      adapter.maintain({ id: 'x', kind: 'seed', prompt: 'seed' }, new AbortController().signal),
    ).rejects.toThrow();
  },
);
it('keeps Codex maintenance routes on a resumed thread whose only failures are the fresh-thread projection', async () => {
  fixture.codexVersion = 'codex-cli 1.4.0';
  fixture.codexThread = {
    thread: { id: 'saved', environments: [{}] },
    runtimeWorkspaceRoots: ['/x'],
  };
  const adapter = new CodexAdapter(agent('astra', 'codex'), config);
  adapters.push(adapter);
  await adapter.start('saved');
  expect(adapter.nativeCompaction).toBe(true);
  expect(adapter.sourceHandoff).toBe(true);
  expect(adapter.imageEvidence.nativeMaintenancePolicyFailures).toEqual([]);
  expect(adapter.imageEvidence.sessionOrigin).toBe('resumed');
  expect(adapter.imageSupport().initial.available).toBe(false);
});
it.each([
  [
    'codex-cli 0.152.9',
    'Codex 0.153.0 or newer with app-server restricted-read support is required',
  ],
  [
    'codex-cli 0.99.99',
    'Codex 0.153.0 or newer with app-server restricted-read support is required',
  ],
  ['', 'Codex version could not be read from codex --version'],
  ['codex 1.0.0', 'Codex version could not be read from codex --version'],
])(
  'refuses Codex startup on %s with a specific reason and no native route',
  async (version, reason) => {
    fixture.codexVersion = version;
    const adapter = new CodexAdapter(agent('astra', 'codex'), config);
    adapters.push(adapter);
    await expect(adapter.start()).rejects.toThrow(reason);
    expect(adapter.nativeCompaction).toBe(false);
    expect(adapter.sourceHandoff).toBe(false);
    expect(fixture.processes).toHaveLength(0);
  },
);
it('refuses a Codex startup whose native policy is overridden, on a newer build too', async () => {
  fixture.codexVersion = 'codex-cli 1.4.0';
  fixture.codexConfig = { features: { shell_tool: true } };
  const adapter = new CodexAdapter(agent('astra', 'codex'), config);
  adapters.push(adapter);
  await expect(adapter.start()).rejects.toThrow('overrides features.shell_tool');
  expect(adapter.nativeCompaction).toBe(false);
  expect(adapter.sourceHandoff).toBe(false);
});
