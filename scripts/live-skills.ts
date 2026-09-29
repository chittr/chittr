// Real CLI integration using only disposable skill/workspace fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createAdapter } from '../src/adapters/index.js';
import { skillLocations } from '../src/skills.js';
import type { Message, Provider } from '../src/types.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-live-skills-')));
const workspace = join(base, 'workspace'),
  home = join(base, 'home');
const providers = (
  process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'claude']
) as Provider[];
mkdirSync(join(workspace, '.agents'), { recursive: true });
writeFileSync(
  join(workspace, '.agents/chittr.yaml'),
  JSON.stringify({
    version: 1,
    agents: Object.fromEntries(providers.map((provider) => [provider, { provider }])),
  }),
);
const tokens = new Map<Provider, [string, string]>();
for (const provider of providers) {
  const source = join(base, 'store', provider),
    install = skillLocations(provider, workspace, home)[0]!;
  mkdirSync(join(source, 'references'), { recursive: true });
  mkdirSync(install, { recursive: true });
  const pair: [string, string] = [randomUUID(), randomUUID()];
  tokens.set(provider, pair);
  writeFileSync(
    join(source, 'SKILL.md'),
    `---\nname: chittr-skill-probe\ndescription: Use for the Chittr skill access integration probe\n---\nManifest token: ${pair[0]}\nRead references/marker.txt beside this file and report both tokens to the human.\n`,
  );
  writeFileSync(join(source, 'references/marker.txt'), `Reference token: ${pair[1]}`);
  symlinkSync(source, join(install, 'chittr-skill-probe'));
}
try {
  const config = loadConfig(workspace, home)!;
  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const adapter = createAdapter(config.agents[provider]!, config);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 240000);
      try {
        await adapter.start();
        console.log(provider, 'CONNECTED');
        const message: Message = {
          id: 'm1',
          sequence: 1,
          author: 'human',
          recipients: [provider],
          text: 'Use the chittr-skill-probe skill from the available catalogue. Read its SKILL.md and follow its supporting-file reference. Report both exact tokens briefly to human. Account for m1 only.',
          createdAt: new Date().toISOString(),
          replyTo: [],
          roots: ['m1'],
          deliveries: {},
        };
        const result = await adapter.run(
          { messages: [message], context: [], participants: providers },
          (event) => {
            if (event.type === 'activity' && event.activity === 'working')
              console.log(provider, 'TOOL', event.detail);
          },
          controller.signal,
        );
        assert.deepEqual(
          result.outcomes.flatMap((o) => o.messageIds),
          ['m1'],
        );
        for (const token of tokens.get(provider)!)
          assert.ok(
            result.outcomes.some((o) => o.kind === 'reply' && o.text.includes(token)),
            'Agent must read both the symlinked manifest and its reference',
          );
        console.log(
          provider,
          'PASS discovered skill, symlinked manifest and supporting-file read through room tools',
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
      console.error(providers[i], 'FAIL', result.reason);
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
