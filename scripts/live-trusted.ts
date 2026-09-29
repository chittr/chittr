// Opt-in: actual provider turns and a read-only GitHub identity-wrapper call.
// One operator-selected test identity is used across provider transports.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, join, isAbsolute } from 'node:path';
import { createAdapter } from '../src/adapters/index.js';
import { ToolService } from '../src/tools.js';
import { providerIds } from '../src/providers.js';
import type { Message, Provider, RoomConfig } from '../src/types.js';

const [wrapper, ...requested] = process.argv.slice(2);
if (!wrapper || !isAbsolute(wrapper) || !/^gh-[a-z]+$/.test(basename(wrapper)))
  throw new Error(
    'Usage: npm run test:trusted -- /absolute/path/to/gh-IDENTITY [codex claude grok antigravity]',
  );
const providers = requested.length ? requested : [...providerIds];
if (providers.some((p) => !providerIds.includes(p as Provider)))
  throw new Error('Unknown provider');
const identity = basename(wrapper).slice(3);
const registry = JSON.parse(
  readFileSync(
    join(process.env.AGENT_TOOLS_HOME ?? join(homedir(), '.config/agent-tools'), 'identities.json'),
    'utf8',
  ),
);
const entry = registry.identities[identity];
assert.ok(entry?.login && entry?.token_env, 'Registered test identity is required');
const source = process.env.GH_TOKEN
  ? 'launch environment: GH_TOKEN'
  : process.env[entry.token_env]
    ? `launch environment: ${entry.token_env}`
    : 'Keychain fallback; prompt visibility is not instrumented';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-trusted-live-')));
const command = `'${wrapper.replaceAll("'", "'\\''")}' api user --jq .login`;
const calls = new Map<string, { exitCode: number; stdout: string }[]>();
const original = ToolService.prototype.call;
ToolService.prototype.call = async function (name, args, signal) {
  if (name !== 'run_command')
    throw new Error('This fixture requires only its one read-only command');
  assert.equal((args as any).command, command, 'Only the prescribed identity check may run');
  const result = (await original.call(this, name, args, signal)) as {
    exitCode: number;
    stdout: string;
  };
  calls.get(this.workspace)!.push(result);
  return result;
};
try {
  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const workspace = join(root, provider);
      mkdirSync(workspace);
      calls.set(workspace, []);
      const config: RoomConfig = {
        workspace,
        permissions: { edits: true, commands: true, network: true },
        commandAccess: { mode: 'trusted', source: '--trusted-commands', blockedBy: [] },
        skills: { enabled: false },
        followUpTurns: 1,
        sources: [],
        provenance: {},
        agents: {
          [provider]: {
            id: provider,
            provider: provider as Provider,
            enabled: true,
            instructions: '',
            fingerprint: provider,
          },
        },
      };
      const adapter = createAdapter(config.agents[provider]!, config);
      const signal = new AbortController();
      const timer = setTimeout(() => signal.abort(), 240000);
      try {
        await adapter.start();
        console.log(provider, 'CONNECTED');
        const message: Message = {
          id: 'm1',
          sequence: 1,
          author: 'human',
          recipients: [provider],
          replyTo: [],
          roots: ['m1'],
          deliveries: {},
          createdAt: new Date().toISOString(),
          text: `Run this exact read-only fixture command once using run_command, then report the returned login: ${command}\nThis fixture uses an operator-selected test identity to verify command transport, not a participant account assignment. Do not run other commands or change files. Reply to human, be brief, and account for m1 only.`,
        };
        const result = await adapter.run(
          { messages: [message], context: [], participants: [provider] },
          (event) => {
            if (event.type === 'activity' && event.activity === 'working')
              console.log(provider, 'WORKING');
          },
          signal.signal,
        );
        const observed = calls.get(workspace)!;
        assert.equal(observed.length, 1, 'The real room executor must run the wrapper once');
        assert.equal(observed[0]!.exitCode, 0, 'Identity wrapper must succeed');
        assert.equal(
          observed[0]!.stdout.trim(),
          entry.login,
          'The wrapper must verify its registered identity',
        );
        assert.ok(result.outcomes.some((o) => o.kind === 'reply' && o.text.includes(entry.login)));
        console.log(
          JSON.stringify({
            provider,
            route: provider === 'codex' ? 'dynamic tool' : 'MCP to room executor',
            result: 'PASS',
            authentication: source,
          }),
        );
      } finally {
        clearTimeout(timer);
        await adapter.close();
      }
    }),
  );
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'rejected') {
      console.error(
        providers[i],
        'FAILED',
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
      process.exitCode = 1;
    }
  }
} finally {
  ToolService.prototype.call = original;
  rmSync(root, { recursive: true, force: true });
}
