import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ToolService } from '../src/tools.js';
import { createAdapter } from '../src/adapters/index.js';
import { IsolatedRuntime } from '../src/adapters/isolated.js';
import {
  GrokAdapter,
  grokPermission,
  checkGrokTools,
  grokInitialImageGate,
  legacyRestrictedGrokBuild,
} from '../src/adapters/grok.js';
import {
  antigravityPermission,
  hookObservation,
  probeDestinationMatches,
} from '../src/antigravity-hook.js';
import {
  AntigravityAdapter,
  antigravityEnforcement,
  antigravityEnv,
  antigravityProbeTool,
  antigravitySettings,
  deniedProbeWriteReported,
  hookObservationFile,
} from '../src/adapters/antigravity.js';
import { providerEnv } from '../src/process.js';
import { resolveCommandAccess } from '../src/command-access.js';
import type {
  AgentAdapter,
  AgentConfig,
  Provider,
  RoomConfig,
  TurnInput,
  AdapterEvent,
} from '../src/types.js';
import { attachmentResolverSettingsSchema, type AttachmentAccess } from '../src/attachments.js';
import { tinyPng } from './image-fixture.js';
import { liveImageDriver, liveImageSelection } from '../scripts/live-image-selection.js';

const fixture = vi.hoisted(() => ({
  instances: [] as any[],
  auth: 'Oidc',
  badTools: false,
  stall: false,
  malformed: false,
  version: '1.1.27',
  closed: 0,
  brokenHook: false,
  grokModel: 'grok-test' as string | undefined,
  grokEfforts: ['low', 'medium', 'high', 'xhigh'],
  lastGrokPrompt: undefined as any,
  sessionNew: undefined as any,
  grokConfigOptions: undefined as any,
  grokInitializeError: false,
  grokNoInventory: false,
  grokMcpServers: undefined as any,
  sent: [] as any[],
  // The scripted Antigravity profile: whether its native attempt reaches the
  // hook, whether it honors the denial, and whether the probe turn completes.
  hookSilent: false,
  hookDenyIgnored: false,
  hookOtherTarget: false,
  hookDoubleWrite: false,
  hookNativeAttempt: false,
  probeFail: false,
  probeStall: false,
  /** Whether the scripted CLI reports the denied action in its result. */
  noDeniedReport: false,
  /** Override for the reported denied_actions array; null = ['write_file']. */
  deniedReport: null as unknown[] | null,
  /** The scripted profile also attempts a task tool during the probe. */
  hookTaskAttempt: false,
  /** The native write arguments the scripted profile makes; null = the exact target. */
  probeArgs: null as Record<string, unknown> | null,
}));
const answer = {
  outcomes: [
    {
      messageIds: ['m1'],
      recipients: ['human'],
      kind: 'reply',
      text: 'Read the marker.',
      awaitingHuman: false,
    },
  ],
};

vi.mock('../src/process.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/process.js')>();
  const { EventEmitter } = await import('node:events');
  class FakeProcess extends EventEmitter {
    closed = false;
    stderr = '';
    constructor(
      public command: string,
      public args: string[],
      public cwd: string,
      public env: NodeJS.ProcessEnv,
    ) {
      super();
      fixture.instances.push(this);
      if (command === 'agy')
        queueMicrotask(() =>
          this.emit('message', {
            event: 'init',
            conversation_id: 'agy-session',
            init: { agent: 'chittr', permission_mode: 'request-review', tools: ['call_mcp_tool'] },
          }),
        );
    }
    async rpc(method: string, params?: any) {
      if (method === 'initialize' && fixture.grokInitializeError)
        throw new Error('ACP initialize failed');
      if (method === 'authenticate') return { _meta: { auth_mode: fixture.auth } };
      if (method === 'session/new') {
        fixture.sessionNew = params;
        if (!fixture.grokNoInventory)
          this.emit('message', {
            method: 'session/update',
            params: {
              update: {
                _meta: { tools: fixture.badTools ? ['shell'] : ['search_tool', 'use_tool'] },
              },
            },
          });
        return {
          sessionId: 'grok-session',
          configOptions: fixture.grokConfigOptions,
          models: {
            currentModelId: fixture.grokModel,
            availableModels: [
              { modelId: 'other-model', _meta: { reasoningEfforts: [{ value: 'max' }] } },
              {
                modelId: fixture.grokModel,
                _meta: {
                  reasoningEfforts: fixture.grokEfforts.map((value) => ({ id: value, value })),
                },
              },
            ],
          },
        };
      }
      if (method === '_x.ai/mcp/list' && fixture.grokMcpServers)
        return { result: { servers: fixture.grokMcpServers } };
      if (method === '_x.ai/mcp/list')
        return {
          result: {
            servers: [
              {
                name: 'chittr',
                session: {
                  status: 'ready',
                  tools: [
                    'read_file',
                    'list_files',
                    'write_file',
                    'run_command',
                    'fetch_url',
                    'read_conversation',
                    'read_attachment',
                  ].map((name) => ({ name, enabled: true })),
                },
              },
            ],
          },
        };
      if (method === 'session/prompt') {
        fixture.lastGrokPrompt = params?.prompt;
        return new Promise((resolve, reject) => {
          const disconnected = (error: Error) => reject(error);
          this.once('disconnect', disconnected);
          queueMicrotask(() => {
            const update = (value: unknown) =>
              this.emit('message', {
                method: 'session/update',
                params: { sessionId: 'grok-session', update: value },
              });
            update({ sessionUpdate: 'user_message_chunk' });
            if (this.closed || fixture.stall) return;
            update({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Checking the file...' },
            });
            update({ sessionUpdate: 'tool_call', title: 'use_tool' });
            update({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: fixture.malformed ? '{}' : JSON.stringify(answer) },
            });
            this.off('disconnect', disconnected);
            resolve({ stopReason: 'end_turn' });
          });
        });
      }
      return {};
    }
    send(message: any) {
      fixture.sent.push(message);
      if (message.event !== 'user') return;
      let envelope: any;
      try {
        envelope = JSON.parse(message.message?.content);
      } catch {
        /* Ordinary turn prompt. */
      }
      const marker =
        envelope?.type === 'chittr-maintenance' && typeof envelope.request === 'string'
          ? /named (chittr-policy-probe-[0-9a-f]+\.txt)/.exec(envelope.request)?.[1]
          : undefined;
      const probe = Boolean(marker);
      // The scripted profile attempts the requested native write and routes it
      // through the room hook, which denies it, unless the fixture says the
      // live profile bypasses the hook or ignores its denial.
      // Records go through the real hook function, with the target the
      // adapter wrote into hooks.json, so the correlation itself is exercised.
      const hookCommand = JSON.parse(
        readFileSync(join(this.env.HOME!, '.gemini/config/hooks.json'), 'utf8'),
      )['chittr-policy'].PreToolUse[0].hooks[0].command as string;
      const target = /'([^']*chittr-policy-probe-[0-9a-f]+\.txt)'$/.exec(hookCommand)?.[1];
      const record = (tool: string, decision: string, args?: Record<string, unknown>) =>
        appendFileSync(
          hookObservationFile(this.env.HOME!),
          JSON.stringify(
            hookObservation({ toolCall: { name: tool, args } }, { decision }, target),
          ) + '\n',
        );
      const step = (tool_name: string) =>
        this.emit('message', {
          event: 'step_update',
          step_update: { conversation_id: 'agy-session', step_type: 'tool', tool_name },
        });
      let denied: string[] = [];
      if (probe && !fixture.hookSilent) {
        if (fixture.hookNativeAttempt) record('view_file', 'deny', { path: 'x' });
        if (fixture.hookTaskAttempt)
          record('call_mcp_tool', 'allow', { ServerName: 'chittr', ToolName: 'read_file' });
        record(
          antigravityProbeTool,
          'deny',
          fixture.probeArgs ??
            (fixture.hookOtherTarget
              ? { path: 'other.txt', content: 'probe' }
              : { path: target, content: 'probe' }),
        );
        if (fixture.hookDoubleWrite) record(antigravityProbeTool, 'deny', { path: target });
        denied = [antigravityProbeTool];
      }
      if (probe && fixture.hookDenyIgnored) writeFileSync(join(this.cwd, marker!), 'probe');
      if (probe && fixture.hookOtherTarget) writeFileSync(join(this.cwd, 'other.txt'), 'probe');
      if (!fixture.hookSilent) record('finish', 'allow');
      queueMicrotask(() => {
        this.emit('message', {
          event: 'step_update',
          step_update: { conversation_id: 'agy-session', step_type: 'user_input' },
        });
        if (this.closed || (fixture.stall && !probe) || (fixture.probeStall && probe)) return;
        if (probe) step(antigravityProbeTool);
        const output = probe
          ? { maintenance: { operationId: envelope.operationId, text: 'policy probe' } }
          : answer;
        this.emit('message', {
          event: 'step_update',
          step_update: {
            conversation_id: 'agy-session',
            step_type: 'agent_response',
            step_index: 2,
            text_delta: JSON.stringify(output),
          },
        });
        if (probe) step('finish');
        this.emit('message', {
          event: 'result',
          result: {
            conversation_id: 'agy-session',
            status: probe && fixture.probeFail ? 'FAILED' : 'SUCCESS',
            ...(probe && fixture.probeFail ? { error: 'scripted probe failure' } : {}),
            ...(denied.length && !fixture.noDeniedReport
              ? { denied_actions: fixture.deniedReport ?? denied }
              : {}),
            structured_output: fixture.malformed && !probe ? {} : output,
          },
        });
      });
    }
    async close() {
      if (!this.closed) {
        this.closed = true;
        fixture.closed++;
        this.emit('disconnect', new Error('CLI closed'));
      }
    }
  }
  return {
    ...original,
    JsonLinesProcess: FakeProcess,
    runProcess: vi.fn(async (_command, args) => ({
      code: 0,
      stdout:
        args[0] === '--version'
          ? fixture.version
          : args[0] === 'models'
            ? 'gemini-test\tGemini Test'
            : args[0]?.endsWith('antigravity-hook.js')
              ? (() => {
                  // The scripted hook self-check records its decision as the
                  // real hook does, unless the hook itself is broken.
                  if (!fixture.brokenHook)
                    appendFileSync(
                      args[1],
                      JSON.stringify({ tool: 'view_file', decision: 'deny' }) + '\n',
                    );
                  return JSON.stringify({ decision: fixture.brokenHook ? 'allow' : 'deny' });
                })()
              : '--agent-profile --reasoning-effort stdio',
      stderr:
        '--agent --input-format --output-format --json-schema --disable-slash-commands --effort',
    })),
  };
});

const adapters: AgentAdapter[] = [];
const config: RoomConfig = {
  workspace: '/fixture',
  permissions: { edits: false, commands: false, network: false },
  followUpTurns: 8,
  sources: [],
  provenance: {},
  agents: {},
  skills: { enabled: false },
};
const input: TurnInput = {
  participants: ['grok', 'antigravity'],
  context: [],
  messages: [
    {
      id: 'm1',
      sequence: 1,
      author: 'human',
      recipients: [],
      text: 'Read the marker',
      createdAt: '',
      replyTo: [],
      roots: ['m1'],
      deliveries: {},
    },
  ],
};
function adapter(
  provider: Provider,
  settings: Partial<AgentConfig> = {},
  attachments?: AttachmentAccess,
) {
  const result = createAdapter(
    {
      id: 'reviewer',
      provider,
      enabled: true,
      instructions: 'Custom instructions',
      fingerprint: 'test',
      ...settings,
    },
    config,
    undefined,
    attachments,
  );
  adapters.push(result);
  return result;
}
beforeEach(() => {
  Object.assign(fixture, {
    instances: [],
    auth: 'Oidc',
    badTools: false,
    stall: false,
    malformed: false,
    version: '1.1.27',
    closed: 0,
    brokenHook: false,
    grokModel: 'grok-test',
    grokEfforts: ['low', 'medium', 'high', 'xhigh'],
    lastGrokPrompt: undefined,
    sessionNew: undefined,
    grokConfigOptions: undefined,
    grokInitializeError: false,
    grokNoInventory: false,
    grokMcpServers: undefined,
    sent: [],
    hookSilent: false,
    hookDenyIgnored: false,
    hookOtherTarget: false,
    hookDoubleWrite: false,
    hookNativeAttempt: false,
    probeFail: false,
    probeStall: false,
    noDeniedReport: false,
    deniedReport: null,
    hookTaskAttempt: false,
    probeArgs: null,
  });
  antigravityEnforcement.timeoutMs = 60000;
  vi.spyOn(ToolService.prototype, 'check').mockResolvedValue();
});
afterEach(async () => {
  for (const value of adapters.splice(0)) await value.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(['grok', ...(process.platform === 'darwin' ? ['antigravity'] : [])] as Provider[])(
  '%s transport',
  (provider) => {
    it('passes model and effort together at launch and omits effort when unset', async () => {
      await adapter(provider, { model: 'gemini-test', effort: 'high' }).start('previous-session');
      const args = fixture.instances[0].args as string[];
      expect(args[args.indexOf('--model') + 1]).toBe('gemini-test');
      const flag = provider === 'grok' ? '--reasoning-effort' : '--effort';
      expect(args[args.indexOf(flag) + 1]).toBe('high');
      await adapter(provider).start();
      expect(fixture.instances[1].args).not.toContain(flag);
      expect(fixture.instances[1].args).not.toContain('--model');
    });
    it('streams a validated reply, discloses context reset, and removes isolated state after stopping', async () => {
      const value = adapter(provider);
      expect((await value.start('old-session')).restored).toBe(true);
      const proc = fixture.instances[0];
      expect(proc.cwd).not.toBe(config.workspace);
      expect(proc.env.HOME).not.toBe(process.env.HOME);
      const events: AdapterEvent[] = [];
      expect(
        (await value.run(input, (event) => events.push(event), new AbortController().signal))
          .outcomes,
      ).toEqual(answer.outcomes);
      expect(events).toContainEqual({ type: 'received' });
      expect(events).toContainEqual({ type: 'text', text: 'Read the marker.' });
      await value.close();
      expect(proc.closed).toBe(true);
      expect(existsSync(proc.cwd)).toBe(false);
    });
    it('interrupts after receipt without returning an outcome', async () => {
      fixture.stall = true;
      const value = adapter(provider),
        controller = new AbortController();
      await value.start();
      await expect(
        value.run(
          input,
          (event) => {
            if (event.type === 'received') controller.abort();
          },
          controller.signal,
        ),
      ).rejects.toThrow('Interrupted');
      expect(fixture.instances[0].closed).toBe(true);
    });
    it('rejects malformed completed output', async () => {
      fixture.malformed = true;
      const value = adapter(provider);
      await value.start();
      await expect(value.run(input, () => {}, new AbortController().signal)).rejects.toThrow();
    });
  },
);

it('rejects API-key Grok authentication and cleans failed startup', async () => {
  fixture.auth = 'ApiKey';
  await expect(adapter('grok').start()).rejects.toThrow('subscription');
  expect(existsSync(fixture.instances[0].cwd)).toBe(false);
});
it('rejects effort unsupported by the selected Grok model and cleans failed startup', async () => {
  fixture.grokEfforts = ['low', 'medium', 'high'];
  await expect(adapter('grok', { effort: 'max' }).start()).rejects.toThrow(
    '@reviewer: Unsupported effort "max" for grok model "grok-test". Accepted values: low, medium, high',
  );
  expect(fixture.instances[0].closed).toBe(true);
  expect(existsSync(fixture.instances[0].cwd)).toBe(false);
});
it('refuses Grok profiles that expose unexpected native tools', async () => {
  fixture.badTools = true;
  await expect(adapter('grok').start()).rejects.toThrow('unexpected tools');
});
it('only approves identified room MCP requests, not a spoofed title or a different MCP server', () => {
  const request = {
    toolCall: {
      title: 'chittr__read_file',
      rawInput: { variant: 'UseTool', tool_name: 'chittr__read_file' },
      _meta: { 'x.ai/tool': { name: 'use_tool' } },
    },
    options: [{ kind: 'allow_once', optionId: 'one' }],
  };
  expect(grokPermission(request)).toEqual({ outcome: { outcome: 'selected', optionId: 'one' } });
  for (const name of ['other__read_file', 'chittr__unknown']) {
    expect(
      grokPermission({
        ...request,
        toolCall: { ...request.toolCall, rawInput: { variant: 'UseTool', tool_name: name } },
      }),
    ).toEqual({ outcome: { outcome: 'cancelled' } });
  }
  expect(grokPermission({ ...request, toolCall: { title: 'chittr__read_file' } })).toEqual({
    outcome: { outcome: 'cancelled' },
  });
  expect(() => checkGrokTools(['search_tool', 'use_tool', 'chittr__read_file'])).not.toThrow();
  expect(() => checkGrokTools(['run_command'])).toThrow();
  expect(() => checkGrokTools(undefined)).toThrow();
});
it('denies Antigravity native tools and malformed hooks; grants only exact room MCP calls', () => {
  for (const payload of [
    null,
    {},
    { toolCall: { name: 'view_file' } },
    { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'other', ToolName: 'read_file' } } },
    {
      toolCall: { name: 'call_mcp_tool', args: { ServerName: 'chittr', ToolName: 'constructor' } },
    },
  ])
    expect(antigravityPermission(payload)).toMatchObject({ decision: 'deny' });
  expect(
    antigravityPermission({
      toolCall: { name: 'call_mcp_tool', args: { ServerName: 'chittr', ToolName: 'write_file' } },
    }),
  ).toEqual({ decision: 'allow', permissionOverrides: ['mcp(chittr/write_file)'] });
  expect(antigravitySettings().permissions.deny).toContain('read_file(*)');
  expect(antigravitySettings().useG1Credits).toBe(false);
});
// #105: no Antigravity version is catalogued. Startup passes on the historical
// build and on uncatalogued newer ones only when the live selected profile is
// observed consulting the room policy hook for a native write and honoring its
// denial, before the room gets the session.
const probeEnvelopes = () =>
  fixture.sent
    .filter((message) => message.event === 'user')
    .map((message) => {
      try {
        return JSON.parse(message.message.content);
      } catch {
        return message.message.content;
      }
    });
it.runIf(process.platform === 'darwin').each(['1.1.27', '1.1.28', '1.2.5', '2.0.0'])(
  'starts Antigravity %s when the selected profile lets the room hook deny its native write',
  async (version) => {
    fixture.version = version;
    const value = adapter('antigravity') as AntigravityAdapter;
    expect((await value.start()).restored).toBe(false);
    expect(fixture.instances).toHaveLength(1);
    // Exactly one startup probe reached the process: a maintenance envelope
    // with task tools denied, no room history and no outcome, asking for one
    // native write inside the isolated scratch directory.
    expect(probeEnvelopes()).toEqual([
      expect.objectContaining({
        type: 'chittr-maintenance',
        kind: 'handoff',
        request: expect.stringMatching(
          /^Startup policy probe\. Step 1: call the native write_file tool exactly once to create a file named chittr-policy-probe-[0-9a-f]{8}\.txt in the current directory/,
        ),
      }),
    ]);
    expect(value.enforcementEvidence).toEqual({
      cliVersion: version,
      hookObservations: [
        { tool: 'write_file', decision: 'deny', probeTarget: true },
        { tool: 'finish', decision: 'allow', probeTarget: false },
      ],
      probeMarkerWritten: false,
      probeScratchAdditions: 0,
      deniedActionsReported: 1,
      deniedProbeWriteReported: true,
      enforcementObserved: true,
    });
    const hooks = JSON.parse(
      readFileSync(join(fixture.instances[0].env.HOME, '.gemini/config/hooks.json'), 'utf8'),
    );
    // The hook command names the observation file and the host-chosen absolute target.
    expect(hooks['chittr-policy'].PreToolUse[0].hooks[0].command).toMatch(
      /'[^']*chittr-hook-observations\.jsonl' '\/[^']*\/workspace\/chittr-policy-probe-[0-9a-f]{8}\.txt'$/,
    );
    expect(value.nativeCompaction).toBe(false);
    expect(value.sourceHandoff).toBe(false);
    expect(value.imageSupport()).toMatchObject({
      initial: { available: false, status: 'unsupported' },
      retrieval: { available: false, status: 'unsupported' },
    });
    expect(hooks['chittr-policy'].PreToolUse[0].hooks[0].command).toContain(
      hookObservationFile(fixture.instances[0].env.HOME),
    );
    // The room turn after startup is an ordinary turn, not a second probe.
    const events: AdapterEvent[] = [];
    expect(
      (await value.run(input, (event) => events.push(event), new AbortController().signal))
        .outcomes,
    ).toEqual(answer.outcomes);
    expect(probeEnvelopes()).toHaveLength(2);
  },
);
it.runIf(process.platform === 'darwin').each(['1.1.27', '1.2.5'])(
  'refuses Antigravity %s before task access when the live profile never consults the room hook',
  async (version) => {
    fixture.version = version;
    fixture.hookSilent = true;
    const value = adapter('antigravity') as AntigravityAdapter;
    await expect(value.start()).rejects.toThrow(
      'completed the policy probe without routing its native write_file call through the room policy hook',
    );
    expect(fixture.instances).toHaveLength(1);
    expect(fixture.instances[0].closed).toBe(true);
    expect(existsSync(fixture.instances[0].cwd)).toBe(false);
    // Only the probe was sent; the refusal is not a version comparison.
    expect(probeEnvelopes()).toHaveLength(1);
    expect(value.enforcementEvidence.enforcementObserved).toBe(false);
    // The closed adapter can run no room turn.
    await expect(value.run(input, () => {}, new AbortController().signal)).rejects.toThrow();
  },
);
it.runIf(process.platform === 'darwin')(
  'refuses Antigravity startup when the denied native write still produced its file',
  async () => {
    fixture.version = '1.2.5';
    fixture.hookDenyIgnored = true;
    const value = adapter('antigravity') as AntigravityAdapter;
    await expect(value.start()).rejects.toThrow(
      'executed a native write during the policy enforcement probe despite the room policy hook (the probe target exists)',
    );
    expect(value.enforcementEvidence).toMatchObject({
      probeMarkerWritten: true,
      enforcementObserved: false,
    });
    expect(fixture.instances[0].closed).toBe(true);
    expect(existsSync(fixture.instances[0].cwd)).toBe(false);
  },
);
it.runIf(process.platform === 'darwin')(
  'refuses Antigravity startup when a denied write recorded against another target produced another file',
  async () => {
    // The denial is correlated to the host-named target: a write elsewhere,
    // and the file it left, are not enforcement evidence.
    fixture.version = '1.2.5';
    fixture.hookOtherTarget = true;
    const value = adapter('antigravity') as AntigravityAdapter;
    await expect(value.start()).rejects.toThrow(
      'executed a native write during the policy enforcement probe despite the room policy hook (1 new scratch entries)',
    );
    expect(value.enforcementEvidence).toMatchObject({
      probeMarkerWritten: false,
      probeScratchAdditions: 1,
      enforcementObserved: false,
    });
    expect(fixture.instances[0].closed).toBe(true);
  },
);
it.runIf(process.platform === 'darwin')(
  'refuses Antigravity startup when the denied write did not name the probe target or was attempted twice',
  async () => {
    fixture.version = '1.2.5';
    fixture.hookOtherTarget = true;
    // No file this time: the uncorrelated record alone is refused.
    const first = adapter('antigravity') as AntigravityAdapter;
    const originalWrite = writeFileSync;
    void originalWrite;
    fixture.hookOtherTarget = true;
    fixture.hookDenyIgnored = false;
    await expect(first.start()).rejects.toThrow(
      /did not name the probe target|new scratch entries/,
    );
    fixture.hookOtherTarget = false;
    fixture.hookDoubleWrite = true;
    const second = adapter('antigravity') as AntigravityAdapter;
    await expect(second.start()).rejects.toThrow(
      'attempted 2 native write_file call(s) during the policy enforcement probe whose destination was not exactly the probe target',
    );
    expect(second.enforcementEvidence.enforcementObserved).toBe(false);
  },
);
const targetFromHooks = () => {
  const home = fixture.instances[0]?.env.HOME;
  if (!home) return '';
  const command = JSON.parse(readFileSync(join(home, '.gemini/config/hooks.json'), 'utf8'))[
    'chittr-policy'
  ].PreToolUse[0].hooks[0].command as string;
  return /'([^']*chittr-policy-probe-[0-9a-f]+\.txt)'$/.exec(command)?.[1] ?? '';
};
it.runIf(process.platform === 'darwin').each([
  [
    'a parent-directory destination',
    (t: string) => ({ path: `../${t.slice(t.lastIndexOf('/') + 1)}` }),
  ],
  [
    'a nested relative destination',
    (t: string) => ({ path: `sub/${t.slice(t.lastIndexOf('/') + 1)}` }),
  ],
  ['the target in an unrelated field', (t: string) => ({ path: 'notes.txt', content: t })],
  ['an unrecognized argument shape', (t: string) => ({ AbsolutePathOfFile: t })],
  ['a non-object argument', (t: string) => t as unknown as Record<string, unknown>],
  [
    'a conflicting destination field beside the target',
    (t: string) => ({ path: '../outside.txt', destination: t, content: 'probe' }),
  ],
  ['a non-string destination beside the target', (t: string) => ({ path: t, file: [t] })],
  ['content other than the probe content', (t: string) => ({ path: t, content: 'something else' })],
  [
    'an unknown field beside a matching destination',
    (t: string) => ({ path: t, AbsolutePathOfFile: '../outside.txt', content: 'probe' }),
  ],
  ['no content field', (t: string) => ({ path: t })],
])('refuses Antigravity startup when the denied write had %s', async (_name, make) => {
  fixture.version = '1.2.5';
  const value = adapter('antigravity') as AntigravityAdapter;
  // The fixture reads the target from hooks.json at send time; supply the
  // arguments through a getter so the target is known by then.
  Object.defineProperty(fixture, 'probeArgs', {
    configurable: true,
    get: () => make(targetFromHooks()),
    set: () => {},
  });
  try {
    await expect(value.start()).rejects.toThrow(
      'whose destination was not exactly the probe target',
    );
    expect(value.enforcementEvidence.enforcementObserved).toBe(false);
  } finally {
    Object.defineProperty(fixture, 'probeArgs', {
      configurable: true,
      writable: true,
      value: null,
    });
  }
});
it('matches a probe write only under the closed argument contract', () => {
  const target = '/isolated/workspace/chittr-policy-probe-0123abcd.txt';
  for (const args of [
    { path: target, content: 'probe' },
    { file_path: target, content: 'probe' },
    { TargetFile: 'chittr-policy-probe-0123abcd.txt', Content: 'probe' },
    { destination: 'chittr-policy-probe-0123abcd.txt', text: 'probe' },
    { path: target, file: target, content: 'probe', contents: 'probe' },
  ])
    expect(probeDestinationMatches(args, target), JSON.stringify(args)).toBe(true);
  for (const args of [
    { path: '../chittr-policy-probe-0123abcd.txt', content: 'probe' },
    { path: './chittr-policy-probe-0123abcd.txt', content: 'probe' },
    { path: '/elsewhere/chittr-policy-probe-0123abcd.txt', content: 'probe' },
    { path: 'sub/chittr-policy-probe-0123abcd.txt', content: 'probe' },
    { path: 'other.txt', content: target },
    { content: 'chittr-policy-probe-0123abcd.txt' },
    { AbsolutePathOfFile: target, content: 'probe' },
    { path: [target], content: 'probe' },
    // Conflicting, unknown, invalid or missing fields are not the target.
    { path: '../outside.txt', destination: target, content: 'probe' },
    { destination: target, path: '/elsewhere/x.txt', content: 'probe' },
    { path: target, file: [target], content: 'probe' },
    { path: target, content: 'not the probe content' },
    { path: target, contents: '' },
    { path: target, AbsolutePathOfFile: '../outside.txt', content: 'probe' },
    { path: target, content: 'probe', mode: 'append' },
    { path: target },
    { content: 'probe' },
    {},
    null,
    target,
    [target],
  ])
    expect(probeDestinationMatches(args, target), JSON.stringify(args)).toBe(false);
  expect(
    hookObservation(
      { toolCall: { name: 'write_file', args: { path: target, content: 'probe' } } },
      { decision: 'deny' },
      target,
    ),
  ).toEqual({ tool: 'write_file', decision: 'deny', probeTarget: true });
  expect(
    hookObservation(
      { toolCall: { name: 'write_file', args: { path: '../x', content: 'probe' } } },
      { decision: 'deny' },
      target,
    ),
  ).toEqual({ tool: 'write_file', decision: 'deny', probeTarget: false });
  expect(hookObservation({ toolCall: { name: 'finish' } }, { decision: 'allow' })).toEqual({
    tool: 'finish',
    decision: 'allow',
  });
  expect(hookObservation(null, { decision: 'deny' }, target)).toEqual({
    tool: 'unrecognized',
    decision: 'deny',
    probeTarget: false,
  });
});
it.runIf(process.platform === 'darwin')(
  'refuses Antigravity startup when the probe reached another native tool, even though the hook denied it',
  async () => {
    fixture.version = '1.2.5';
    fixture.hookNativeAttempt = true;
    await expect(adapter('antigravity').start()).rejects.toThrow(
      'attempted native tools during the policy enforcement probe: view_file (deny)',
    );
    expect(fixture.instances[0].closed).toBe(true);
  },
);
it.runIf(process.platform === 'darwin')(
  'refuses Antigravity startup with the probe failure when the probe turn fails without a denial',
  async () => {
    fixture.version = '1.2.5';
    fixture.probeFail = true;
    fixture.hookSilent = true;
    const value = adapter('antigravity') as AntigravityAdapter;
    await expect(value.start()).rejects.toThrow(
      'policy enforcement probe failed before room access: scripted probe failure',
    );
    expect(value.enforcementEvidence.enforcementObserved).toBe(false);
    expect(fixture.instances[0].closed).toBe(true);
  },
);
it.runIf(process.platform === 'darwin')(
  'refuses Antigravity startup when the probe turn fails even though the write was denied',
  async () => {
    // A CLI that ends the probe turn as a failure has closed its own process
    // through the ordinary failure path; the recorded denial cannot admit it.
    fixture.version = '1.2.5';
    fixture.probeFail = true;
    const value = adapter('antigravity') as AntigravityAdapter;
    await expect(value.start()).rejects.toThrow(
      'policy enforcement probe failed before room access: scripted probe failure',
    );
    expect(value.enforcementEvidence).toMatchObject({
      probeMarkerWritten: false,
      deniedActionsReported: 1,
    });
    expect(fixture.instances[0].closed).toBe(true);
  },
);
it.runIf(process.platform === 'darwin')(
  'releases the task-tool gate and keeps the process after a denied probe',
  async () => {
    fixture.version = '1.2.5';
    const value = adapter('antigravity') as AntigravityAdapter;
    await value.start();
    expect(fixture.instances[0].closed).toBe(false);
    const events: AdapterEvent[] = [];
    expect(
      (await value.run(input, (event) => events.push(event), new AbortController().signal))
        .outcomes,
    ).toEqual(answer.outcomes);
    expect(events).toContainEqual({ type: 'received' });
  },
);
it.runIf(process.platform === 'darwin')(
  'refuses Antigravity startup when the CLI reports no denied action for the denied write',
  async () => {
    // A call the CLI rejected for its own reasons leaves the file absent too;
    // only the CLI's own denied-action report distinguishes an honored denial.
    fixture.version = '1.2.5';
    fixture.noDeniedReport = true;
    const value = adapter('antigravity') as AntigravityAdapter;
    await expect(value.start()).rejects.toThrow(
      'did not report exactly the denied write_file call the room policy hook denied (0 denied action(s) reported)',
    );
    expect(value.enforcementEvidence).toMatchObject({
      probeMarkerWritten: false,
      deniedActionsReported: 0,
      deniedProbeWriteReported: false,
      enforcementObserved: false,
    });
    expect(fixture.instances[0].closed).toBe(true);
  },
);
it.runIf(process.platform === 'darwin').each([
  ['another denied tool', ['call_mcp_tool']],
  ['a malformed entry', [null]],
  ['the write beside another entry', ['write_file', 'call_mcp_tool']],
  ['an object naming another tool', [{ tool: 'read_file' }]],
  ['an object with conflicting names', [{ name: 'write_file', tool: 'read_file' }]],
  ['an empty report', []],
])('refuses Antigravity startup when the denied-action report is %s', async (_name, report) => {
  fixture.version = '1.2.5';
  fixture.deniedReport = report;
  const value = adapter('antigravity') as AntigravityAdapter;
  await expect(value.start()).rejects.toThrow(
    'did not report exactly the denied write_file call the room policy hook denied',
  );
  expect(value.enforcementEvidence).toMatchObject({
    deniedProbeWriteReported: false,
    enforcementObserved: false,
  });
});
it.runIf(process.platform === 'darwin')(
  'accepts a denied-action report that names the probe write as an object',
  async () => {
    fixture.version = '1.2.5';
    fixture.deniedReport = [{ tool_name: 'write_file', reason: 'hook' }];
    const value = adapter('antigravity') as AntigravityAdapter;
    await value.start();
    expect(value.enforcementEvidence).toMatchObject({
      deniedProbeWriteReported: true,
      enforcementObserved: true,
    });
  },
);
it.runIf(process.platform === 'darwin')(
  'refuses Antigravity startup when the profile also attempted a task tool during the probe',
  async () => {
    fixture.version = '1.2.5';
    fixture.hookTaskAttempt = true;
    await expect(adapter('antigravity').start()).rejects.toThrow(
      'attempted native tools during the policy enforcement probe: call_mcp_tool (allow)',
    );
  },
);
it('recognizes only a single denied-action entry that names the probe write', () => {
  for (const report of [
    ['write_file'],
    [{ name: 'write_file' }],
    [{ tool_name: 'write_file', reason: 'denied by hook' }],
    [{ name: 'write_file', tool: 'write_file' }],
  ])
    expect(deniedProbeWriteReported(report), JSON.stringify(report)).toBe(true);
  for (const report of [
    [],
    ['call_mcp_tool'],
    ['write_file', 'write_file'],
    [null],
    [{}],
    [{ reason: 'write_file' }],
    [{ name: 'write_file', tool: 'read_file' }],
    [['write_file']],
    'write_file',
    undefined,
    null,
    1,
  ])
    expect(deniedProbeWriteReported(report), JSON.stringify(report)).toBe(false);
});
it.runIf(process.platform === 'darwin')(
  'refuses Antigravity startup when the probe never completes, with the timeout reason',
  async () => {
    fixture.version = '1.2.5';
    fixture.probeStall = true;
    antigravityEnforcement.timeoutMs = 200;
    const value = adapter('antigravity') as AntigravityAdapter;
    await expect(value.start()).rejects.toThrow(
      'policy enforcement probe timed out before room access',
    );
    expect(fixture.instances[0].closed).toBe(true);
    expect(existsSync(fixture.instances[0].cwd)).toBe(false);
  },
);
it.runIf(process.platform === 'darwin')(
  'still aborts an ordinary Antigravity turn on the native write outside the probe',
  async () => {
    fixture.version = '1.2.5';
    const value = adapter('antigravity') as AntigravityAdapter;
    await value.start();
    // Hold the scripted turn open after receipt so the native step arrives
    // while the turn is still running.
    fixture.stall = true;
    const proc = fixture.instances[0];
    const turn = value.run(input, () => {}, new AbortController().signal);
    await Promise.resolve();
    proc.emit('message', {
      event: 'step_update',
      step_update: { conversation_id: 'agy-session', step_type: 'tool', tool_name: 'write_file' },
    });
    await expect(turn).rejects.toThrow('attempted an unexpected native tool: write_file');
  },
);
it.runIf(process.platform === 'darwin')(
  'refuses Antigravity when its version cannot be read, without a native session',
  async () => {
    fixture.version = '';
    await expect(adapter('antigravity').start()).rejects.toThrow('could not be read');
    expect(fixture.instances).toHaveLength(0);
  },
);
it.runIf(process.platform === 'darwin').each(['1.1.27', '1.2.5'])(
  'refuses Antigravity %s startup when its policy hook is broken, before any native session',
  async (version) => {
    fixture.version = version;
    fixture.brokenHook = true;
    await expect(adapter('antigravity').start()).rejects.toThrow('policy hook');
    expect(fixture.instances).toHaveLength(0);
  },
);
it.runIf(process.platform === 'darwin')(
  'writes an isolated Antigravity profile with only completion and room MCP tools',
  async () => {
    await adapter('antigravity').start();
    const root = join(fixture.instances[0].env.HOME, '.gemini/config');
    const profile = readFileSync(join(root, 'agents/chittr/agent.md'), 'utf8');
    expect(profile).toContain('tools: [finish]\ninheritMcp: true');
    expect(profile).toContain('Custom instructions');
    const mcp = JSON.parse(readFileSync(join(root, 'mcp_config.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['chittr']);
    expect(JSON.parse(mcp.mcpServers.chittr.args[1]).workspace).toBe('/fixture');
  },
);
it('removes billing switches and inherited Antigravity server/config environment', () => {
  for (const key of [
    'XAI_API_KEY',
    'GROK_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'JETSKI_OAUTH_TOKEN',
    'ANTIGRAVITY_LS_ADDRESS',
    'AGY_ADC_AUTH',
  ]) {
    vi.stubEnv(key, 'test-only');
    expect(providerEnv()[key]).toBeUndefined();
  }
  vi.stubEnv('JETSKI_APP_DATA_DIR', '/unsafe');
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://example.invalid');
  const env = antigravityEnv('/isolated');
  expect(env.HOME).toBe('/isolated');
  expect(env.JETSKI_APP_DATA_DIR).toBeUndefined();
  expect(env.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
});

it('plumbs only host-scoped attachment resolver settings through every tool-hosting path', async () => {
  const access: AttachmentAccess = {
    settings: { directory: '/host/attachments', sessionId: randomUUID() },
    resolve: () => {
      throw new Error('unused');
    },
  };
  expect(
    attachmentResolverSettingsSchema.safeParse({ ...access.settings, path: '/agent/path' }).success,
  ).toBe(false);
  expect(
    attachmentResolverSettingsSchema.safeParse({ ...access.settings, url: 'https://example.test' })
      .success,
  ).toBe(false);

  const codex = adapter('codex', {}, access) as any;
  const claude = adapter('claude', {}, access) as any;
  const grok = adapter('grok', {}, access) as any;
  const antigravity = adapter('antigravity', {}, access) as any;
  expect(codex.tools.attachmentAccess).toBe(access);
  expect(claude.attachments).toBe(access);
  expect(grok.attachments).toBe(access);
  expect(antigravity.attachments).toBe(access);

  const runtime = new IsolatedRuntime(
    {
      id: 'reviewer',
      provider: 'grok',
      enabled: true,
      instructions: '',
      fingerprint: 'test',
    },
    config,
    {},
    access,
  );
  const settings = await runtime.tools.mcpSettings('reviewer');
  expect(runtime.tools.attachmentAccess).toBe(access);
  expect(settings.attachmentStore).toEqual(access.settings);
  expect(settings.permissions).toEqual({ edits: false, commands: false, network: false });
  runtime.close();
});

// #105: the native compaction route is selected after every successful start,
// on the historical build and on uncatalogued newer ones. compact() validates
// the actual operation; a failed start leaves the route off.
it.each([
  'grok 1.0.13 (5e9a58528b76) [stable]',
  'grok 1.0.14 (unknown) [stable]',
  'grok 1.0.30 (04b7ffed98c6) [stable]',
  'grok 1.0.34 (3736acbc8658) [stable]',
  'grok 1.1.0 (0123abcd) [stable]',
  'grok 2.0.0 (ffffffff) [stable]',
])('selects Grok native compaction after startup on %s', async (version) => {
  fixture.version = version;
  const value = adapter('grok');
  expect(value.nativeCompaction).toBe(false);
  await value.start();
  expect(value.nativeCompaction).toBe(true);
  await value.close();
  expect(value.nativeCompaction).toBe(false);
});
it('leaves the Grok native route off when startup fails its policy checks', async () => {
  fixture.version = 'grok 2.0.0 (ffffffff) [stable]';
  fixture.badTools = true;
  const value = adapter('grok');
  await expect(value.start()).rejects.toThrow('unexpected tools');
  expect(value.nativeCompaction).toBe(false);
});

it('maps ordered required-message images for the observed Grok runtime, whatever the model', async () => {
  fixture.version = 'grok 1.0.13 (5e9a58528b76) [stable]';
  fixture.grokModel = 'grok-4.6';
  const bytes = tinyPng();
  const metadata = {
    id: 'att-0123456789abcdef0123456789abcdef',
    filename: 'fixture.png',
    mediaType: 'image/png' as const,
    byteSize: bytes.length,
    width: 1,
    height: 1,
  };
  const access: AttachmentAccess = {
    settings: {
      directory: '/host/attachments',
      sessionId: '00000000-0000-4000-8000-000000000001',
    },
    resolve: (id) => {
      expect(id).toBe(metadata.id);
      return { metadata, sha256: '0'.repeat(64), bytes };
    },
  };
  const value = adapter('grok', {}, access);
  await value.start();
  const imageInput = structuredClone(input);
  imageInput.messages[0]!.attachments = [metadata];
  await value.run(imageInput, () => {}, new AbortController().signal);
  expect(value.nativeInitialImages).toBe(true);
  expect(value.imageSupport!()).toMatchObject({
    initial: { available: true },
    retrieval: { available: true },
  });
  expect(fixture.lastGrokPrompt.slice(0, 2)).toEqual([
    {
      type: 'text',
      text: `Chittr image for message #m1, attachment ${metadata.id}.`,
    },
    { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
  ]);
  expect(JSON.parse(fixture.sessionNew.mcpServers[0].args[1]).attachmentStore).toEqual(
    access.settings,
  );
  const oversized = structuredClone(imageInput);
  // 34 messages of 2 MiB pass the 64 MiB provider reader cap.
  oversized.context = Array.from({ length: 34 }, (_, index) => ({
    ...structuredClone(input.messages[0]!),
    id: `m${index + 2}`,
    sequence: index + 2,
    text: 'x'.repeat(2 * 1024 * 1024),
    roots: [`m${index + 2}`],
    attachments: undefined,
  }));
  oversized.messages[0]!.replyTo = oversized.context.map((message) => message.id);
  await expect(value.run(oversized, () => {}, new AbortController().signal)).rejects.toThrow(
    'provider frame limit',
  );

  expect(value.imageSupport!()).toMatchObject({
    initial: { available: false },
    retrieval: { available: false },
  });
  expect(value.initialImageSupport!()).toEqual(value.imageSupport!().initial);

  // #69: a version-only change keeps the same observed contract eligible. The
  // CLI identity is evidence and diagnostics, never a gate. #105: so is the
  // model, and the native compaction route is selected on this build too.
  fixture.version = 'grok 1.0.14 (unverified) [stable]';
  const newer = adapter('grok', {}, access);
  await newer.start();
  expect(newer.nativeInitialImages).toBe(true);
  expect(newer.imageSupport!()).toEqual({
    provider: 'grok',
    initial: { available: true, status: 'available' },
    retrieval: { available: true, status: 'available' },
  });
  expect(newer.nativeCompaction).toBe(true);
  fixture.grokModel = 'grok-other';
  const otherModel = adapter('grok', { model: 'grok-other' }, access) as GrokAdapter;
  await otherModel.start();
  expect(otherModel.nativeInitialImages).toBe(true);
  expect(otherModel.imageEvidence).toMatchObject({
    requestedModel: 'grok-other',
    observedModel: 'grok-other',
  });

  // Room permissions, skills and command mode never close a current build: the
  // default room (permissions off, skills on) is eligible.
  fixture.grokModel = 'grok-4.6';
  const defaults = createAdapter(
    {
      id: 'reviewer',
      provider: 'grok',
      enabled: true,
      instructions: '',
      fingerprint: 'default-room',
    },
    { ...config, skills: { enabled: true } },
    undefined,
    access,
  );
  adapters.push(defaults);
  await defaults.start();
  expect(defaults.imageSupport!().initial).toEqual({ available: true, status: 'available' });
  // Without room preflight the direct guard still rejects, as an invariant failure
  // that repeats the shared tuple diagnostic rather than a second explanation. The
  // legacy build keeps its restricted-room requirement.
  fixture.version = legacyRestrictedGrokBuild;
  const unavailable = createAdapter(
    {
      id: 'reviewer',
      provider: 'grok',
      enabled: true,
      instructions: '',
      fingerprint: 'mixed-room',
    },
    { ...config, skills: { enabled: true } },
    undefined,
    access,
  );
  adapters.push(unavailable);
  await unavailable.start();
  expect(unavailable.nativeInitialImages).toBe(false);
  expect(unavailable.initialImageSupport!()).toEqual({
    available: false,
    status: 'unsupported',
    reason: `Grok's verified initial-image tuple does not match: skills are enabled; the verified tuple requires skills disabled; observed model grok-4.6`,
  });
  fixture.lastGrokPrompt = undefined;
  const failure = unavailable.run(imageInput, () => {}, new AbortController().signal);
  await expect(failure).rejects.toThrow(
    'Invariant violation: Grok received initial images that room preflight should have rejected',
  );
  await expect(failure).rejects.toThrow('skills are enabled');
  await expect(failure).rejects.not.toThrow('CLI version is');
  await expect(failure).rejects.not.toThrow('unavailable for this Grok CLI version');
  // No prompt, so no pixels, reached the provider.
  expect(fixture.lastGrokPrompt).toBeUndefined();
});

it('explains every mismatched Grok tuple condition from live effective state', () => {
  const verified = {
    cliVersion: legacyRestrictedGrokBuild,
    requestedModel: 'provider default',
    observedModel: 'grok-4.6',
    permissions: { edits: false, commands: false, network: false },
    skillsEnabled: false,
    nativeInventoryVerified: true,
  };
  expect(grokInitialImageGate(verified)).toEqual({ available: true, status: 'available' });
  // The on-disk example room: explicit grok-4.6, every permission on, skills
  // default. #105: the explicit request is evidence, not a mismatch; the room
  // policy still is one for the legacy build.
  const gate = grokInitialImageGate({
    ...verified,
    requestedModel: 'grok-4.6',
    permissions: { edits: true, commands: true, network: true },
    skillsEnabled: true,
  });
  expect(gate.available).toBe(false);
  const reason = gate.available ? '' : gate.reason;
  expect(reason).toBe(
    "Grok's verified initial-image tuple does not match: " +
      'room permissions edits, commands and network are on; the verified tuple requires edits, commands and network off; ' +
      'skills are enabled; the verified tuple requires skills disabled; ' +
      'observed model grok-4.6',
  );
  expect(reason).not.toContain('CLI version');
  expect(reason).not.toContain('requested explicitly');
  const single = grokInitialImageGate({
    ...verified,
    permissions: { edits: false, commands: true, network: false },
  });
  expect(single.available ? '' : single.reason).toContain('room permission commands is on');
  // Requested and observed models vary independently; none of them is compared.
  for (const models of [
    { requestedModel: 'grok-3', observedModel: 'grok-3' },
    { requestedModel: 'grok-4.6', observedModel: 'grok-4.6' },
    { requestedModel: 'provider default', observedModel: 'grok-other' },
    { requestedModel: 'grok-4.6', observedModel: 'grok-5' },
  ])
    expect(grokInitialImageGate({ ...verified, ...models }), JSON.stringify(models)).toEqual({
      available: true,
      status: 'available',
    });
  // A missing model observation is still missing evidence.
  expect(grokInitialImageGate({ ...verified, observedModel: 'unavailable' })).toEqual({
    available: false,
    status: 'not_observed',
    reason: 'Grok initial images not observed: the session model has not been observed',
  });
});

it('keeps unverified Grok policy tuples unavailable for native images, with the model as evidence', async () => {
  fixture.version = 'grok 1.0.13 (5e9a58528b76) [stable]';
  const bytes = tinyPng();
  const metadata = {
    id: 'att-0123456789abcdef0123456789abcdef',
    filename: 'fixture.png',
    mediaType: 'image/png' as const,
    byteSize: bytes.length,
    width: 1,
    height: 1,
  };
  const access: AttachmentAccess = {
    settings: { directory: '/host/attachments', sessionId: randomUUID() },
    resolve: () => ({ metadata, sha256: '0'.repeat(64), bytes }),
  };
  const configurations = [
    {
      name: 'missing observed model',
      model: undefined,
      observed: undefined,
      room: config,
      status: 'not_observed' as const,
      reason: 'Grok initial images not observed: the session model has not been observed',
    },
    {
      name: 'skills enabled',
      model: undefined,
      observed: 'grok-4.6',
      room: { ...config, skills: { enabled: true } },
      status: 'unsupported' as const,
      reason:
        'skills are enabled; the verified tuple requires skills disabled; observed model grok-4.6',
    },
    {
      name: 'expanded room permissions with an explicit other model',
      model: 'grok-other',
      observed: 'grok-other',
      room: { ...config, permissions: { edits: true, commands: false, network: false } },
      status: 'unsupported' as const,
      reason:
        'room permission edits is on; the verified tuple requires edits, commands and network off; observed model grok-other',
    },
  ];
  for (const scenario of configurations) {
    fixture.grokModel = scenario.observed;
    const value = createAdapter(
      {
        id: 'reviewer',
        provider: 'grok',
        enabled: true,
        instructions: '',
        fingerprint: scenario.name,
        model: scenario.model,
      },
      scenario.room,
      undefined,
      access,
    );
    adapters.push(value);
    await value.start();
    expect(value.nativeInitialImages, scenario.name).toBe(false);
    expect(value.initialImageSupport!(), scenario.name).toEqual({
      available: false,
      status: scenario.status,
      reason:
        scenario.status === 'not_observed'
          ? scenario.reason
          : `Grok's verified initial-image tuple does not match: ${scenario.reason}`,
    });
  }
});

it('revokes the live image report when the Grok native process is interrupted', async () => {
  fixture.version = legacyRestrictedGrokBuild;
  fixture.grokModel = 'grok-4.6';
  const value = adapter('grok');
  await value.start();
  expect(value.imageSupport!().initial.available).toBe(true);
  await value.interrupt();
  expect(value.imageSupport!().initial.available).toBe(false);
  expect(value.imageSupport!().retrieval.available).toBe(false);
  expect(value.nativeInitialImages).toBe(false);
});

// #56 exercises the adapter boundary with host tools/skills enabled. Native
// permissions remain the same exact allowlist in both accepted room profiles.
it.each([false, true])(
  'keeps the native Grok policy isolated with host permissions=%s',
  async (enabled) => {
    fixture.version = 'grok 1.0.30 (04b7ffed98c6) [stable]';
    fixture.grokModel = 'grok-4.6';
    fixture.grokConfigOptions = [{ id: 'reasoning_effort', type: 'select', currentValue: 'high' }];
    const value = new GrokAdapter(
      {
        id: 'grok',
        provider: 'grok',
        enabled: true,
        instructions: '',
        fingerprint: 'policy',
        effort: enabled ? 'high' : undefined,
      },
      {
        ...config,
        permissions: { edits: enabled, commands: enabled, network: enabled },
        skills: { enabled },
        commandAccess: { mode: enabled ? 'sandboxed' : 'off', blockedBy: [] },
      },
    );
    adapters.push(value);
    await value.start();
    expect(value.imageSupport()).toMatchObject({
      initial: { available: true },
      retrieval: { available: true },
    });
    expect(value.nativeCompaction).toBe(true);
    expect(value.imageEvidence).toMatchObject({
      sessionId: 'grok-session',
      observedModel: 'grok-4.6',
      requestedEffort: enabled ? 'high' : 'provider default',
      observedEffort: 'high',
      nativeInventoryVerified: true,
    });
    expect(
      liveImageDriver(liveImageSelection(['--adapter', 'grok'])).policy(value, {
        ...config,
        permissions: { edits: enabled, commands: enabled, network: enabled },
        commandAccess: { mode: enabled ? 'sandboxed' : 'off', blockedBy: [] },
      }),
    ).toMatchObject({
      commandMode: enabled ? 'sandboxed' : 'off',
      commandModeSource: 'permissions.commands',
    });
    const proc = fixture.instances.at(-1);
    const profile = readFileSync(proc.args[proc.args.indexOf('--agent-profile') + 1], 'utf8');
    expect(profile).toContain('discoverSkills: false');
    expect(profile).toContain('injectDefaultTools: false');
    expect(profile).toContain('  - mcp__chittr__*');
    expect(proc.cwd).not.toBe(config.workspace);
    expect(proc.env.HOME).not.toBe(process.env.HOME);
    expect(readFileSync(join(proc.env.GROK_HOME, 'config.toml'), 'utf8')).toContain(
      'image_gen=false',
    );
    expect(JSON.parse(fixture.sessionNew.mcpServers[0].args[1])).toMatchObject({
      permissions: { edits: enabled, commands: enabled, network: enabled },
      commandMode: enabled ? 'sandboxed' : 'off',
    });
    for (const name of ['image_gen', 'run_command', 'read_file', 'other__read_attachment']) {
      proc.emit('message', {
        id: name,
        method: 'session/request_permission',
        params: {
          toolCall: { _meta: { 'x.ai/tool': { name } } },
          options: [{ kind: 'allow_once', optionId: 'allow' }],
        },
      });
      expect(fixture.sent.at(-1)).toMatchObject({
        id: name,
        result: { outcome: { outcome: 'cancelled' } },
      });
    }
    proc.emit('message', {
      method: 'session/update',
      params: { update: { _meta: { tools: ['image_gen'] } } },
    });
    expect(value.imageSupport()).toMatchObject({
      initial: { available: false },
      retrieval: { available: false },
    });
    expect(proc.closed).toBe(true);
  },
);
// #69 accepts effective command mode `trusted` under the observed isolated-room
// contract, on any well-formed CLI identity. The gate never sees how trust was
// granted: both valid sources resolve through the product resolver to the same
// tuple, and only byte-free evidence records the source. A synthetic source
// string stands in for the user-level file, so this launches no Grok process
// and neither reads nor modifies any real user config.
const trustedGrokRoom = (persistentSource: string | undefined, requested: boolean): RoomConfig => {
  const permissions = { edits: true, commands: true, network: true };
  return {
    ...config,
    permissions,
    skills: { enabled: true },
    commandAccess: resolveCommandAccess(
      { permissions, provenance: {} },
      persistentSource,
      requested,
    ),
  };
};
const trustedGrokAgent = {
  id: 'grok',
  provider: 'grok' as const,
  enabled: true,
  instructions: '',
  fingerprint: 'trusted-policy',
  effort: 'high',
};
const userLevelGrant = '/synthetic-home/.agents/chittr.yaml (trustedCommands.workspaces)';
const observedRoomContract = {
  policy: 'isolated-rooms-v1',
  isolatedRuntime: true,
  acpInitialized: true,
  subscriptionAuthenticated: true,
  roomMcpInventory: true,
  processLive: true,
};
it.each([
  ['--trusted-commands', undefined, true, '--trusted-commands', '1.0.30 (04b7ffed98c6)'],
  ['--trusted-commands', undefined, true, '--trusted-commands', '1.0.34 (3736acbc8658)'],
  [
    'user-level trustedCommands.workspaces',
    userLevelGrant,
    false,
    userLevelGrant,
    '1.0.30 (04b7ffed98c6)',
  ],
  [
    'user-level trustedCommands.workspaces',
    userLevelGrant,
    false,
    userLevelGrant,
    '9.8.7 (0a1b2c3d)',
  ],
])(
  'accepts Grok images under trusted command mode granted by %s and keeps the native policy isolated',
  async (_name, persistentSource, requested, source, build) => {
    const cliVersion = `grok ${build} [stable]`;
    fixture.version = cliVersion;
    fixture.grokModel = 'grok-4.6';
    fixture.grokConfigOptions = [{ id: 'reasoning_effort', type: 'select', currentValue: 'high' }];
    const room = trustedGrokRoom(persistentSource, requested);
    expect(room.commandAccess).toEqual({ mode: 'trusted', source, blockedBy: [] });
    const value = new GrokAdapter(trustedGrokAgent, room);
    adapters.push(value);
    await value.start();
    expect(value.imageSupport()).toEqual({
      provider: 'grok',
      initial: { available: true, status: 'available' },
      retrieval: { available: true, status: 'available' },
    });
    expect(value.nativeInitialImages).toBe(true);
    // The gate input carries the effective mode, the host-observed runtime
    // contract and no trust source. The identity is recorded, not compared.
    expect(value.initialImageTuple).toEqual({
      cliVersion,
      requestedModel: 'provider default',
      observedModel: 'grok-4.6',
      permissions: { edits: true, commands: true, network: true },
      skillsEnabled: true,
      commandMode: 'trusted',
      nativeInventoryVerified: true,
      roomContract: observedRoomContract,
    });
    expect(value.imageEvidence).toMatchObject({
      cliVersion,
      roomContract: observedRoomContract,
      sessionId: 'grok-session',
      observedModel: 'grok-4.6',
      requestedEffort: 'high',
      observedEffort: 'high',
      commandMode: 'trusted',
      commandModeSource: source,
      nativeInventoryVerified: true,
    });
    expect(
      liveImageDriver(liveImageSelection(['--adapter', 'grok'])).policy(value, room),
    ).toMatchObject({ commandMode: 'trusted', commandModeSource: source, trustGrant: source });
    // Trusted command mode changes the host run_command path only. The native
    // process keeps the same isolation, denied tools and disabled image_gen.
    const proc = fixture.instances.at(-1);
    const profile = readFileSync(proc.args[proc.args.indexOf('--agent-profile') + 1], 'utf8');
    expect(profile).toContain('discoverSkills: false');
    expect(profile).toContain('injectDefaultTools: false');
    expect(profile).toContain('  - mcp__chittr__*');
    expect(proc.cwd).not.toBe(config.workspace);
    expect(proc.env.HOME).not.toBe(process.env.HOME);
    expect(readFileSync(join(proc.env.GROK_HOME, 'config.toml'), 'utf8')).toContain(
      'image_gen=false',
    );
    expect(JSON.parse(fixture.sessionNew.mcpServers[0].args[1])).toMatchObject({
      permissions: { edits: true, commands: true, network: true },
      commandMode: 'trusted',
    });
    for (const name of ['image_gen', 'run_command', 'read_file', 'other__read_attachment']) {
      proc.emit('message', {
        id: name,
        method: 'session/request_permission',
        params: {
          toolCall: { _meta: { 'x.ai/tool': { name } } },
          options: [{ kind: 'allow_once', optionId: 'allow' }],
        },
      });
      expect(fixture.sent.at(-1)).toMatchObject({
        id: name,
        result: { outcome: { outcome: 'cancelled' } },
      });
    }
    proc.emit('message', {
      method: 'session/update',
      params: { update: { _meta: { tools: ['image_gen'] } } },
    });
    expect(value.imageSupport()).toMatchObject({
      initial: { available: false },
      retrieval: { available: false },
    });
    expect(value.imageEvidence.nativeInventoryVerified).toBe(false);
    expect(value.imageEvidence.roomContract).toEqual({
      ...observedRoomContract,
      processLive: false,
    });
    expect(proc.closed).toBe(true);
  },
);
it('keeps the exact 1.0.13 legacy identity restricted even when the full contract is observed', async () => {
  fixture.version = legacyRestrictedGrokBuild;
  fixture.grokModel = 'grok-4.6';
  const value = new GrokAdapter(trustedGrokAgent, trustedGrokRoom(undefined, true));
  adapters.push(value);
  await value.start();
  expect(value.imageEvidence.roomContract).toEqual(observedRoomContract);
  expect(value.initialImageTuple).toBeUndefined();
  expect(value.nativeInitialImages).toBe(false);
  expect(value.imageSupport()).toEqual({
    provider: 'grok',
    initial: {
      available: false,
      status: 'unsupported',
      reason:
        "Grok's verified initial-image tuple does not match: room permissions edits, commands and network are on; the verified tuple requires edits, commands and network off; skills are enabled; the verified tuple requires skills disabled; command mode is on; the verified tuple requires command mode off; observed model grok-4.6",
    },
    retrieval: {
      available: false,
      status: 'unsupported',
      reason:
        "Grok's verified retrieval tuple does not match: room permissions edits, commands and network are on; the verified tuple requires edits, commands and network off; skills are enabled; the verified tuple requires skills disabled; command mode is on; the verified tuple requires command mode off; observed model grok-4.6",
    },
  });
  expect(value.nativeCompaction).toBe(true);
});
it('never reports Grok images when subscription authentication is not observed', async () => {
  fixture.version = 'grok 1.0.34 (3736acbc8658) [stable]';
  fixture.grokModel = 'grok-4.6';
  fixture.auth = 'ApiKey';
  const value = new GrokAdapter(trustedGrokAgent, trustedGrokRoom(undefined, true));
  adapters.push(value);
  await expect(value.start()).rejects.toThrow('Sign in to Grok Build');
  expect(value.imageSupport()).toMatchObject({
    initial: { available: false, status: 'not_observed' },
    retrieval: { available: false, status: 'not_observed' },
  });
  expect(value.nativeInitialImages).toBe(false);
  expect(value.initialImageTuple).toBeUndefined();
});
// The contract flags are host-derived: each one follows a real start step, so a
// step that fails must reject start, close the process and leave no tuple.
const roomTools = [
  'read_file',
  'list_files',
  'write_file',
  'run_command',
  'fetch_url',
  'read_conversation',
  'read_attachment',
].map((name) => ({ name, enabled: true }));
const mcpServer = (tools = roomTools, name = 'chittr', status = 'ready') => ({
  name,
  session: { status, tools },
});
it.each([
  ['ACP initialization fails', { grokInitializeError: true }, 'ACP initialize failed'],
  [
    'the native inventory is never reported',
    { grokNoInventory: true },
    'Grok did not report its effective tool inventory',
  ],
  [
    'an extra MCP server is loaded',
    { grokMcpServers: [mcpServer(), mcpServer(roomTools, 'other')] },
    'Grok loaded an unexpected MCP configuration',
  ],
  [
    'the MCP server has another name',
    { grokMcpServers: [mcpServer(roomTools, 'other')] },
    'Grok loaded an unexpected MCP configuration',
  ],
  [
    'no MCP server is loaded',
    { grokMcpServers: [] },
    'Grok loaded an unexpected MCP configuration',
  ],
  [
    'a room tool is missing',
    { grokMcpServers: [mcpServer(roomTools.slice(1))] },
    'Grok did not connect all room tools',
  ],
  [
    'an extra MCP tool is enabled',
    { grokMcpServers: [mcpServer([...roomTools, { name: 'image_gen', enabled: true }])] },
    'Grok did not connect all room tools',
  ],
  [
    'a room tool is disabled',
    {
      grokMcpServers: [
        mcpServer(roomTools.map((tool, index) => ({ ...tool, enabled: index !== 0 }))),
      ],
    },
    'Grok did not connect all room tools',
  ],
  [
    'the MCP session failed',
    { grokMcpServers: [mcpServer(roomTools, 'chittr', 'failed')] },
    'Grok could not connect the room MCP tools',
  ],
])(
  'observes no Grok runtime contract and no image path when %s',
  async (_name, failure, message) => {
    fixture.version = 'grok 1.0.34 (3736acbc8658) [stable]';
    fixture.grokModel = 'grok-4.6';
    Object.assign(fixture, failure);
    const value = new GrokAdapter(trustedGrokAgent, trustedGrokRoom(undefined, true));
    adapters.push(value);
    await expect(value.start()).rejects.toThrow(message);
    expect(fixture.instances.at(-1).closed).toBe(true);
    expect(value.imageSupport()).toMatchObject({
      initial: { available: false, status: 'not_observed' },
      retrieval: { available: false, status: 'not_observed' },
    });
    expect(value.nativeInitialImages).toBe(false);
    expect(value.initialImageTuple).toBeUndefined();
    expect(value.imageEvidence.roomContract).toBeUndefined();
  },
);
it('fails Grok start on an unexpected native inventory in a trusted-command room, with no degraded image support', async () => {
  fixture.version = 'grok 1.0.34 (3736acbc8658) [stable]';
  fixture.grokModel = 'grok-4.6';
  fixture.badTools = true;
  const value = new GrokAdapter(trustedGrokAgent, trustedGrokRoom(undefined, true));
  adapters.push(value);
  await expect(value.start()).rejects.toThrow('unexpected tools');
  expect(value.imageSupport()).toMatchObject({
    initial: { available: false },
    retrieval: { available: false },
  });
  expect(value.nativeInitialImages).toBe(false);
  expect(value.initialImageTuple).toBeUndefined();
});
it('does not infer active Grok effort from the requested flag or supported-efforts catalogue', async () => {
  fixture.version = 'grok 1.0.30 (04b7ffed98c6) [stable]';
  fixture.grokModel = 'grok-4.6';
  const value = adapter('grok', { effort: 'high' }) as GrokAdapter;
  await value.start();
  expect(value.imageEvidence).toMatchObject({
    requestedEffort: 'high',
    observedEffort: 'unknown',
    effortObservationSource: 'unknown',
  });
  expect(value.imageSupport().initial.available).toBe(true);
});
