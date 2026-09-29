// No model calls. Report protocol capabilities without exposing account data.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const flags = [
  'hooks',
  'apps',
  'plugins',
  'browser_use',
  'computer_use',
  'multi_agent',
  'code_mode_host',
  'shell_tool',
];
const proc = spawn(
  'codex',
  ['app-server', ...flags.flatMap((f) => ['-c', `features.${f}=false`])],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
let seq = 0;
const pending = new Map();
const timeout = setTimeout(() => {
  console.error('Protocol timed out');
  proc.kill();
}, 20000);
let errors = '';
proc.stderr.on('data', (c) => {
  errors += c;
});
createInterface({ input: proc.stdout }).on('line', (line) => {
  try {
    const m = JSON.parse(line);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  } catch {}
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  const init = await rpc('initialize', {
    clientInfo: { name: 'chittr', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  proc.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  console.log('initialize', { platform: init.platformOs });
  const account = await rpc('account/read', { refreshToken: false });
  console.log('account', {
    type: account.account?.type,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
  });
  const cfg = await rpc('config/read', { includeLayers: false });
  console.log('config', {
    model: cfg.config.model,
    mcpServerNames: Object.keys(cfg.config.mcp_servers || {}),
    features: cfg.config.features,
  });
  if (process.argv.includes('--recent-probe')) {
    const list = await rpc('thread/list', { limit: 30 });
    const thread = list.data.find((t) => t.cwd?.includes('/chittr-live-'));
    if (thread) {
      const detail = await rpc('thread/read', { threadId: thread.id, includeTurns: true });
      console.log(
        'latest fixture response',
        detail.thread.turns
          .flatMap((t) => t.items)
          .filter((i) => i.type === 'agentMessage')
          .map((i) => i.text),
      );
    }
  }
} catch (e) {
  console.error(e.message);
  if (errors) console.error(errors.slice(-1800));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  proc.kill();
}
