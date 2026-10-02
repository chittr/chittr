// Synthetic provider protocols only. No provider executable is launched.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const roomToolNames = [
  'read_file',
  'list_files',
  'write_file',
  'run_command',
  'fetch_url',
  'read_conversation',
  'read_attachment',
];
export const wires: Wire[] = [];
export const script = { resumeError: '' };
export class Wire extends EventEmitter {
  closed = false;
  sessionId: string = randomUUID();
  promptId = 0;
  sent: any[] = [];
  servers: any[] = [];
  settings: Record<string, string> = {};
  profile = '';
  instructions = '';
  resume = false;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
  /** Where the generated Antigravity hook records invocations, read from hooks.json. */
  private hookObservations?: string;
  private probeTarget?: string;
  constructor(
    public command: string,
    args: string[] = [],
    _cwd?: string,
    env?: NodeJS.ProcessEnv,
  ) {
    super();
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
    if (command === 'claude') {
      this.instructions = args[args.indexOf('--append-system-prompt') + 1]!;
      this.resume = args.includes('--resume');
      this.sessionId = args[args.indexOf(this.resume ? '--resume' : '--session-id') + 1]!;
      this.servers = [JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.chittr];
    }
    if (command === 'agy') {
      this.instructions = readFileSync(
        join(env!.HOME!, '.gemini/config/agents/chittr/agent.md'),
        'utf8',
      );
      this.servers = [
        JSON.parse(readFileSync(join(env!.HOME!, '.gemini/config/mcp_config.json'), 'utf8'))
          .mcpServers.chittr,
      ];
      const hook = JSON.parse(readFileSync(join(env!.HOME!, '.gemini/config/hooks.json'), 'utf8'))[
        'chittr-policy'
      ].PreToolUse[0].hooks[0].command as string;
      this.hookObservations = /'([^']*chittr-hook-observations\.jsonl)'/.exec(hook)![1]!;
      this.probeTarget = /'([^']*chittr-policy-probe-[0-9a-f]+\.txt)'$/.exec(hook)?.[1];
      queueMicrotask(() =>
        this.emit('message', {
          event: 'init',
          conversation_id: this.sessionId,
          init: { agent: 'chittr', permission_mode: 'request-review', tools: ['call_mcp_tool'] },
        }),
      );
    }
    if (command === 'grok')
      this.instructions = readFileSync(args[args.indexOf('--agent-profile') + 1]!, 'utf8');
    wires.push(this);
  }
  send(value: any, validate?: (serialized: string) => void) {
    const serialized = JSON.stringify(value);
    validate?.(serialized);
    this.sent.push(JSON.parse(serialized));
    if (this.command === 'agy' && value.event === 'user') {
      // The scripted selected profile routes every tool call through the room
      // hook. The startup enforcement probe is answered here: the requested
      // native write is attempted, denied by the hook and reported as a denied
      // action, and no file appears. Other maintenance and turn results stay
      // script-driven.
      let envelope: any;
      try {
        envelope = JSON.parse(value.message?.content);
      } catch {
        /* Not a maintenance envelope. */
      }
      const probe =
        envelope?.type === 'chittr-maintenance' &&
        envelope.kind === 'handoff' &&
        /^Startup policy probe\./.test(envelope.request);
      if (probe)
        appendFileSync(
          this.hookObservations!,
          // The real hook records whether the destination equals the host
          // target; this scripted profile writes exactly there. (The hook
          // module is not imported here: it would re-enter the process mock.)
          JSON.stringify({ tool: 'write_file', decision: 'deny', probeTarget: true }) + '\n',
        );
      appendFileSync(
        this.hookObservations!,
        JSON.stringify({ tool: 'finish', decision: 'allow' }) + '\n',
      );
      if (probe)
        queueMicrotask(() =>
          this.emit('message', {
            event: 'result',
            result: {
              conversation_id: this.sessionId,
              status: 'SUCCESS',
              denied_actions: ['write_file'],
              structured_output: {
                maintenance: { operationId: envelope.operationId, text: 'policy probe' },
              },
            },
          }),
        );
    }
    if (this.command === 'claude' && value.request?.subtype === 'initialize')
      queueMicrotask(() =>
        this.emit('message', {
          type: 'control_response',
          response: {
            request_id: value.request_id,
            subtype: this.resume && script.resumeError ? 'error' : 'success',
            error: script.resumeError,
            response: {
              models: [
                {
                  value: 'opus',
                  resolvedModel: 'claude-opus-5',
                  supportedEffortLevels: ['xhigh'],
                },
              ],
            },
          },
        }),
      );
    if (this.command === 'claude' && value.type === 'user')
      this.emit('message', {
        type: 'system',
        subtype: 'init',
        session_id: this.sessionId,
        tools: ['StructuredOutput', ...roomToolNames.map((x) => `mcp__chittr__${x}`)],
      });
  }
  async rpc(
    method: string,
    params: any = {},
    _timeout?: number,
    validate?: (serialized: string) => void,
  ) {
    this.sent.push({ method, params });
    if (method === 'thread/resume' && script.resumeError) throw new Error(script.resumeError);
    if (method === 'authenticate') return { _meta: { auth_mode: 'Oidc' } };
    if (method === 'session/new') {
      this.servers = params.mcpServers;
      this.emit('message', {
        method: 'session/update',
        params: { update: { _meta: { tools: ['search_tool', 'use_tool'] } } },
      });
      return { sessionId: this.sessionId, models: { currentModelId: 'grok-4.6' } };
    }
    if (method === '_x.ai/mcp/list')
      return {
        result: {
          servers: [
            {
              name: 'chittr',
              session: {
                status: 'ready',
                tools: roomToolNames.map((name) => ({ name, enabled: true })),
              },
            },
          ],
        },
      };
    if (method === 'session/prompt')
      return new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
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
        },
      };
    if (method === 'thread/start' || method === 'thread/resume')
      return {
        thread: {
          id: method === 'thread/resume' ? (this.sessionId = params.threadId) : this.sessionId,
          environments: [],
        },
        model: 'gpt-6-astra',
        reasoningEffort: 'xhigh',
        cwd: params.cwd,
        activePermissionProfile: { id: this.profile, extends: null },
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        runtimeWorkspaceRoots: [],
      };
    if (method === 'model/list')
      return {
        data: [{ model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] }],
      };
    if (method === 'turn/start') {
      this.send({ id: `request-${this.promptId + 1}`, method, params }, validate);
      return { turn: { id: `turn-${++this.promptId}` } };
    }
    return {};
  }
  complete(
    value = {
      outcomes: [{ kind: 'pass', text: 'Done', recipients: [], messageIds: ['m2'] }],
    },
  ) {
    const text = JSON.stringify(value);
    if (this.command === 'claude') {
      this.emit('message', {
        type: 'assistant',
        session_id: this.sessionId,
        message: { model: 'claude-opus-5' },
      });
      this.emit('message', {
        type: 'result',
        subtype: 'success',
        session_id: this.sessionId,
        structured_output: JSON.parse(text),
        user_message_uuid: this.sent.findLast((v: any) => v.type === 'user')?.uuid,
      });
    } else if (this.command === 'agy') {
      this.emit('message', {
        event: 'result',
        result: { conversation_id: this.sessionId, status: 'SUCCESS', structured_output: value },
      });
    } else if (this.command === 'grok') {
      this.emit('message', {
        method: 'session/update',
        params: {
          sessionId: this.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        },
      });
      this.resolve?.({ stopReason: 'end_turn' });
    } else {
      this.emit('message', {
        method: 'item/completed',
        params: { threadId: this.sessionId, item: { type: 'agentMessage', text } },
      });
      this.emit('message', {
        method: 'turn/completed',
        params: {
          threadId: this.sessionId,
          turn: { id: `turn-${this.promptId}`, status: 'completed' },
        },
      });
    }
  }
  receipt() {
    if (this.command === 'claude')
      this.emit('message', { type: 'user', session_id: this.sessionId, message: { role: 'user' } });
    if (this.command === 'grok')
      this.emit('message', {
        method: 'session/update',
        params: { sessionId: this.sessionId, update: { sessionUpdate: 'user_message_chunk' } },
      });
    if (this.command === 'agy')
      this.emit('message', {
        step_update: { conversation_id: this.sessionId, step_type: 'user_input' },
      });
    // Codex emits receipt when turn/start resolves.
  }
  activity(stale = false) {
    const id = stale ? 'foreign-session' : this.sessionId;
    if (this.command === 'claude')
      this.emit('message', { type: 'tool_progress', session_id: id, tool_name: 'contract-marker' });
    else if (this.command === 'grok')
      this.emit('message', {
        method: 'session/update',
        params: { sessionId: id, update: { sessionUpdate: 'tool_call', title: 'contract-marker' } },
      });
    else if (this.command === 'agy')
      this.emit('message', {
        step_update: {
          conversation_id: id,
          step_type: 'tool',
          tool_name: 'call_mcp_tool',
          tool_info: { parameters: { ToolName: 'contract-marker' } },
        },
      });
    else
      this.emit('message', {
        method: 'item/started',
        params: {
          threadId: this.sessionId,
          turnId: `turn-${stale ? this.promptId - 1 : this.promptId}`,
          item: { type: 'mcpToolCall', tool: 'contract-marker' },
        },
      });
  }
  async close() {
    this.closed = true;
    this.reject?.(new Error('Provider closed'));
    this.emit('disconnect', new Error('Provider closed'));
  }
}
export async function runProcess(command: string, args: string[]) {
  let stdout = '';
  if (command === 'codex') stdout = 'codex-cli 0.154.0';
  else if (command === 'claude')
    stdout =
      args[0] === '--version'
        ? '2.1.268 (Claude Code)'
        : args[0] === '--help'
          ? '--restricted --replay-user-messages --include-partial-messages --strict-mcp-config --tools --disallowedTools --allowedTools --permission-mode --setting-sources --settings --mcp-config --json-schema --no-chrome --effort'
          : JSON.stringify({ loggedIn: true, authMethod: 'oauth' });
  else if (command === 'grok')
    stdout = args.includes('--version')
      ? 'grok 1.0.30 (04b7ffed98c6) [stable]'
      : '--agent-profile --reasoning-effort stdio';
  else if (command === 'agy')
    stdout =
      args[0] === '--version'
        ? '1.1.27'
        : args[0] === 'models'
          ? 'gemini-test\tGemini Test'
          : '--agent --input-format --output-format --json-schema --disable-slash-commands --effort';
  else if (args[0]?.endsWith('antigravity-hook.js')) {
    // The scripted hook self-check records its decision like the real hook.
    appendFileSync(args[1]!, JSON.stringify({ tool: 'view_file', decision: 'deny' }) + '\n');
    stdout = JSON.stringify({ decision: 'deny' });
  } else if (args.at(-1) === 'sandbox-ready') stdout = 'sandbox-ready';
  else throw new Error(`Unexpected subprocess: ${command} ${args.join(' ')}`);
  return { code: 0, stderr: '', stdout };
}
