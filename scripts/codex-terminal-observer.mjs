// Observation preload for the built CLI. All private controls stay in disposable state.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../dist/adapters/codex.js';
import { JsonLinesProcess } from '../dist/process.js';
import { ToolService } from '../dist/tools.js';
import { observeCodex } from './codex-native-observer.mjs';
const root = process.env.CHITTR_IMAGE_OBSERVATION;
delete process.env.CHITTR_IMAGE_OBSERVATION;
if (!root) throw new Error('Missing disposable observation directory');
const control = () => JSON.parse(readFileSync(join(root, 'private-control.json'), 'utf8'));
const record = (event) =>
  appendFileSync(
    join(root, 'native.jsonl'),
    JSON.stringify({ phase: control().phase, ...event }) + '\n',
  );
observeCodex(JsonLinesProcess, ToolService, record, control);
for (const method of ['start', 'run', 'maintain']) {
  const original = CodexAdapter.prototype[method];
  CodexAdapter.prototype[method] = async function (...args) {
    const result = await original.apply(this, args);
    record({
      boundary: `${method}-completed`,
      tuple: this.imageEvidence,
      support: this.imageSupport(),
    });
    return result;
  };
}
