import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
import { toolInputs } from './tools.js';

/**
 * Byte-free record of one hook invocation: a bounded tool name, the decision
 * and, when the adapter named a startup probe target, whether the call's
 * destination is exactly that target. Arguments themselves are never recorded.
 */
export interface HookObservation {
  tool: string;
  decision: 'allow' | 'deny';
  probeTarget?: boolean;
}
/**
 * The probe argument contract, closed. No live build has established the
 * native `write_file` argument schema, so the hook admits nothing it does not
 * recognize: the arguments must be a plain object whose every key is a known
 * destination or content key; every destination field must equal the
 * host-owned absolute target path or its bare file name exactly; every content
 * field must equal the probe content; and at least one destination field and
 * one content field must be present. An unknown field, a relative path with a
 * separator, a different directory, a conflicting destination field, other
 * content, or a missing field is not the target. A build whose arguments do
 * not meet this contract therefore yields no enforcement evidence and is
 * refused, never admitted on a guess.
 */
export const probeContent = 'probe';
const contentKeys = new Set(['content', 'contents', 'text', 'data', 'body']);
const destinationKeys = new Set([
  'path',
  'file',
  'filepath',
  'file_path',
  'filename',
  'file_name',
  'target',
  'targetfile',
  'target_file',
  'destination',
  'dest',
  'absolutepath',
  'absolute_path',
]);
export function probeDestinationMatches(args: unknown, target: string): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const bare = target.slice(target.lastIndexOf('/') + 1);
  let destinations = 0;
  let contents = 0;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const name = key.toLowerCase();
    if (destinationKeys.has(name)) {
      if (typeof value !== 'string') return false;
      if (value !== target && !(value === bare && !value.includes('/') && !value.includes('\\')))
        return false;
      destinations++;
    } else if (contentKeys.has(name)) {
      if (value !== probeContent) return false;
      contents++;
    } else return false;
  }
  return destinations > 0 && contents > 0;
}
export function hookObservation(
  payload: any,
  decision: object,
  probeTarget?: string,
): HookObservation {
  const name = payload?.toolCall?.name;
  return {
    tool: typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : 'unrecognized',
    decision: (decision as { decision?: string }).decision === 'allow' ? 'allow' : 'deny',
    ...(probeTarget
      ? { probeTarget: probeDestinationMatches(payload?.toolCall?.args, probeTarget) }
      : {}),
  };
}

export function antigravityPermission(payload: any): object {
  const call = payload?.toolCall;
  const args = call?.args;
  if (call?.name === 'finish') return { decision: 'allow' };
  if (
    call?.name === 'call_mcp_tool' &&
    args?.ServerName === 'chittr' &&
    typeof args.ToolName === 'string' &&
    Object.hasOwn(toolInputs, args.ToolName)
  )
    return { decision: 'allow', permissionOverrides: [`mcp(chittr/${args.ToolName})`] };
  return {
    decision: 'deny',
    reason:
      'Use the room MCP tools. Missing permissions require a YAML config change and idle reload.',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The adapter names an observation file inside the isolated runtime. Every
  // invocation appends its bounded record there, which is how the adapter can
  // tell that the live selected profile routed a tool call through this hook.
  // Recording never changes the decision, and a recording failure denies.
  const observations = process.argv[2];
  const probeTarget = process.argv[3];
  const answer = (payload: unknown) => {
    let decision = antigravityPermission(payload);
    if (observations)
      try {
        appendFileSync(
          observations,
          JSON.stringify(hookObservation(payload, decision, probeTarget)) + '\n',
          { mode: 0o600 },
        );
      } catch {
        decision = { decision: 'deny', reason: 'Room policy observation could not be recorded.' };
      }
    process.stdout.write(JSON.stringify(decision) + '\n');
  };
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > 2 * 1024 * 1024) {
      answer(null);
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let payload: unknown;
    try {
      payload = JSON.parse(input);
    } catch {
      /* Deny malformed input. */
    }
    answer(payload);
  });
}
