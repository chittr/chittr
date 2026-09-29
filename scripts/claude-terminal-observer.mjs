// Verification-only preload for the actual built CLI. It observes native
// boundaries without changing mappings, permissions, prompts or provider replies.
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../dist/adapters/claude.js';
import { JsonLinesProcess } from '../dist/process.js';
import { turnPrompt } from '../dist/protocol.js';
const root = process.env.CHITTR_IMAGE_OBSERVATION;
delete process.env.CHITTR_IMAGE_OBSERVATION;
if (!root) throw new Error('Missing disposable observation directory');
const fixture = () => JSON.parse(readFileSync(join(root, 'private-control.json'), 'utf8'));
const record = (event) =>
  appendFileSync(
    join(root, 'native.jsonl'),
    JSON.stringify({ phase: fixture().phase, ...event }) + '\n',
  );
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
  if (value.type === 'user') {
    const text = JSON.stringify(value);
    const control = fixture();
    record({
      boundary: 'initial-native-request',
      sessionId: value.session_id,
      requestId: value.uuid,
      frameBytes: Buffer.byteLength(text),
      images: images(value),
      hasHiddenId: !!control.hiddenId && text.includes(control.hiddenId),
      hasOracle: control.oracles.some((oracle) => text.includes(oracle)),
      associations: (Array.isArray(value.message?.content) ? value.message.content : [])
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
const emit = JsonLinesProcess.prototype.emit;
JsonLinesProcess.prototype.emit = function (name, ...args) {
  const value = args[0];
  if (name === 'message' && value?.type === 'user')
    record({
      boundary: 'native-user-replay',
      sessionId: value.session_id,
      requestId: value.uuid,
      frameBytes: Buffer.byteLength(JSON.stringify(value)),
      images: images(value),
    });
  return emit.call(this, name, ...args);
};
const mcp = ClaudeAdapter.prototype.mcpServer;
ClaudeAdapter.prototype.mcpServer = async function (tools) {
  const original = await mcp.call(this, tools);
  return {
    command: process.execPath,
    args: [
      fileURLToPath(new URL('./attachment-mcp-observer.mjs', import.meta.url)),
      join(root, 'mcp.jsonl'),
      original.command,
      ...original.args,
    ],
  };
};
for (const method of ['start', 'run', 'maintain']) {
  const original = ClaudeAdapter.prototype[method];
  ClaudeAdapter.prototype[method] = async function (...args) {
    const result = await original.apply(this, args);
    record({
      boundary: `${method}-completed`,
      tuple: this.imageEvidence,
      support: this.imageSupport(),
    });
    return result;
  };
}
