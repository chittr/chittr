// Verification-only preload for #57's integrated PTY scenarios. It loads the
// provider tickets' existing preloads, one per enabled provider, so a mixed room is
// watched by exactly the observers that were accepted with each provider. Its one
// observation of its own, at the end, is whether the unsupported recipient's
// adapter was ever run. Each provider preload reads and deletes the private
// observation variable when it loads, so it is restored before each import and
// removed for good afterwards. Child providers never see it.
const root = process.env.CHITTR_IMAGE_OBSERVATION;
const names = (process.env.CHITTR_IMAGE_OBSERVERS ?? '').split(',').filter(Boolean);
delete process.env.CHITTR_IMAGE_OBSERVERS;
if (!root) throw new Error('Missing disposable observation directory');
if (!names.length || names.some((name) => !['codex', 'claude', 'grok'].includes(name)))
  throw new Error('Unavailable: observers must name codex, claude or grok');
if (new Set(names).size !== names.length) throw new Error('Unavailable: repeated observer');
for (const name of names) {
  process.env.CHITTR_IMAGE_OBSERVATION = root;
  await import(`./${name}-terminal-observer.mjs`);
}
delete process.env.CHITTR_IMAGE_OBSERVATION;
// Antigravity has no provider preload. The mixed row must prove the image message
// never reached its adapter, so record which messages each run was handed: identities
// only, written before the run so a dispatch is seen even if the provider then fails.
const { appendFileSync, readFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { AntigravityAdapter } = await import('../dist/adapters/antigravity.js');
const run = AntigravityAdapter.prototype.run;
AntigravityAdapter.prototype.run = function (input, ...rest) {
  const { phase } = JSON.parse(readFileSync(join(root, 'private-control.json'), 'utf8'));
  appendFileSync(
    join(root, 'native.jsonl'),
    JSON.stringify({
      phase,
      boundary: 'unsupported-run-started',
      messageIds: input.messages.map((message) => message.id),
    }) + '\n',
  );
  return run.call(this, input, ...rest);
};
