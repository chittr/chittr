// Verification-only preload for the actual built CLI. It observes native
// boundaries without changing mappings, permissions, prompts or provider replies.
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrokAdapter } from '../dist/adapters/grok.js';
import { JsonLinesProcess } from '../dist/process.js';
import { IsolatedRuntime } from '../dist/adapters/isolated.js';
import { Room } from '../dist/room.js';
import { TerminalUI } from '../dist/ui/terminal.js';
const root = process.env.CHITTR_IMAGE_OBSERVATION;
delete process.env.CHITTR_IMAGE_OBSERVATION;
if (!root) throw new Error('Missing disposable observation directory');
const fixture = () => JSON.parse(readFileSync(join(root, 'private-control.json'), 'utf8'));
const record = (event) =>
  appendFileSync(
    join(root, 'native.jsonl'),
    JSON.stringify({ phase: fixture().phase, ...event }) + '\n',
  );
// Observe completion rather than treating a saved ready flag as a new startup,
// or sending another line while the terminal is still applying a command.
const startRoom = Room.prototype.start;
Room.prototype.start = async function (...args) {
  const result = await startRoom.apply(this, args);
  record({ boundary: 'room-start-completed', roomSessionId: this.session.id });
  return result;
};
const terminalSend = TerminalUI.prototype.send;
TerminalUI.prototype.send = async function (...args) {
  const accepted = !this.submitting;
  const command = ['/reconnect @grok', '/continue @grok'].includes(this.value)
    ? this.value
    : undefined;
  const result = await terminalSend.apply(this, args);
  if (accepted && command) record({ boundary: 'terminal-command-completed', command });
  return result;
};
const images = (value) => {
  if (!value || typeof value !== 'object') return [];
  if (value.type === 'image' && (value.source?.type === 'base64' || value.data)) {
    const bytes = Buffer.from(value.source?.data ?? value.data, 'base64');
    return [
      {
        mimeType: value.source?.media_type ?? value.mimeType,
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ];
  }
  return Object.values(value).flatMap(images);
};
const send = JsonLinesProcess.prototype.send;
JsonLinesProcess.prototype.send = function (value, ...rest) {
  if (value.method === 'session/prompt') {
    const text = JSON.stringify(value);
    const control = fixture();
    record({
      boundary: 'initial-native-request',
      sessionId: value.params.sessionId,
      requestId: value.id,
      frameBytes: Buffer.byteLength(text),
      images: images(value),
      hasHiddenId: !!control.hiddenId && text.includes(control.hiddenId),
      hasOracle: control.oracles.some((oracle) => text.includes(oracle)),
      associations: (value.params.prompt ?? [])
        .filter(
          (x) =>
            x.type === 'text' &&
            /^Chittr image for message #[a-zA-Z0-9-]+, attachment att-[a-f0-9]{32}\.$/.test(x.text),
        )
        .map((x) => x.text),
    });
  }
  // Forward every argument: Codex passes a final validator that must still run.
  return send.call(this, value, ...rest);
};
const rpc = JsonLinesProcess.prototype.rpc;
JsonLinesProcess.prototype.rpc = async function (method, ...args) {
  const result = await rpc.call(this, method, ...args);
  if (method === 'session/new')
    record({ boundary: 'native-session-new', sessionId: result.sessionId });
  return result;
};
const mcp = IsolatedRuntime.prototype.mcp;
IsolatedRuntime.prototype.mcp = async function () {
  const original = await mcp.call(this);
  return {
    command: process.execPath,
    args: [
      fileURLToPath(new URL('./attachment-mcp-observer.mjs', import.meta.url)),
      join(root, `${fixture().phase}-mcp.jsonl`),
      original.command,
      ...original.args,
    ],
  };
};
for (const method of ['start', 'run', 'maintain']) {
  const original = GrokAdapter.prototype[method];
  GrokAdapter.prototype[method] = async function (...args) {
    const result = await original.apply(this, args);
    record({
      boundary: `${method}-completed`,
      tuple: this.imageEvidence,
      support: this.imageSupport(),
    });
    return result;
  };
}
