// Acceptance-only transparent MCP observer. Persist identities and boundary
// events, never text results, request captions, image data, or provider answers.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [log, command, ...args] = process.argv.slice(2);
const settings = JSON.parse(args.at(-1));
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
const record = (value) => appendFileSync(log, JSON.stringify(value) + '\n', { mode: 0o600 });
createInterface({ input: process.stdin }).on('line', (line) => {
  const call = JSON.parse(line);
  if (call.method === 'tools/call') {
    pending.set(call.id, call.params.name);
    record({
      boundary: 'mcp-request',
      requestId: call.id,
      name: call.params.name,
      arguments:
        call.params.name === 'read_attachment' || call.params.name === 'read_conversation'
          ? call.params.arguments
          : undefined,
    });
  }
  child.stdin.write(line + '\n');
});
createInterface({ input: child.stdout }).on('line', (line) => {
  const response = JSON.parse(line);
  const name = pending.get(response.id);
  if (name) {
    const images = (response.result?.content ?? [])
      .filter((x) => x.type === 'image')
      .map((x) => ({
        type: x.type,
        mimeType: x.mimeType,
        byteSize: Buffer.from(x.data, 'base64').length,
        sha256: createHash('sha256').update(Buffer.from(x.data, 'base64')).digest('hex'),
      }));
    const discovered = [];
    if (name === 'read_conversation')
      for (const item of response.result?.content ?? []) {
        if (item.type !== 'text') continue;
        const result = JSON.parse(item.text);
        for (const message of result.messages ?? [result])
          for (const attachment of message.attachments ?? [])
            discovered.push({ messageId: message.id, attachmentId: attachment.id });
      }
    let state;
    try {
      state = JSON.parse(readFileSync(settings.attachmentTurnFile, 'utf8'));
    } catch {
      state = { active: false };
    }
    record({
      boundary: 'mcp-result',
      frameBytes: Buffer.byteLength(line) + 1,
      frameCharacters: line.length + 1,
      requestId: response.id,
      name,
      images,
      discovered,
      active: state.active,
      roomSessionId: state.sessionId,
      turnRevision: state.revision,
      bridge: state.bridge,
      isError: response.result?.isError === true,
    });
    pending.delete(response.id);
  }
  process.stdout.write(line + '\n');
});
process.stdin.on('end', () => child.stdin.end());
process.on('SIGTERM', () => child.kill());
child.on('exit', (code) => process.exit(code ?? 1));
