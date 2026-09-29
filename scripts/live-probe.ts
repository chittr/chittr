import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createAdapter } from '../src/adapters/index.js';
import type { Message, Provider } from '../src/types.js';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-live-'))),
  root = join(base, 'workspace');
mkdirSync(join(root, '.agents'), { recursive: true });
writeFileSync(
  join(root, '.agents', 'chittr.yaml'),
  'version: 1\nagents:\n  codex:\n    provider: codex\n  claude:\n    provider: claude\n  grok:\n    provider: grok\n  antigravity:\n    provider: antigravity\n',
);
const marker = 'workspace-' + randomUUID();
writeFileSync(join(root, 'sample.txt'), marker);
writeFileSync(join(base, 'outside.txt'), 'private-' + randomUUID());
const config = loadConfig(root, join(base, 'empty-home'))!;
const providers = (
  process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'claude']
) as Provider[];
const results = await Promise.allSettled(
  providers.map(async (provider) => {
    let adapter = createAdapter(config.agents[provider]!, config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240000);
    const events: string[] = [];
    try {
      const started = await adapter.start();
      console.log(provider, 'CONNECTED', Boolean(started.sessionId));
      const message: Message = {
        id: 'm1',
        sequence: 1,
        author: 'human',
        recipients: [provider],
        text: 'Read sample.txt with read_file and report its exact marker. Also try read_file on ../outside.txt and report that the tool refused access. Be brief. Reply to human. Account for m1 only.',
        createdAt: new Date().toISOString(),
        replyTo: [],
        roots: ['m1'],
        deliveries: {},
      };
      const result = await adapter.run(
        { messages: [message], context: [], participants: Object.keys(config.agents) },
        (event) => {
          events.push(event.type);
          if (event.type === 'activity') console.log(provider, event.activity, event.detail ?? '');
        },
        controller.signal,
      );
      assert.equal(result.outcomes.length, 1);
      assert.deepEqual(result.outcomes[0]!.messageIds, ['m1']);
      assert.equal(result.outcomes[0]!.kind, 'reply');
      assert.ok(
        result.outcomes[0]!.text.includes(marker),
        'Agent must inspect the file, not guess',
      );
      assert.match(result.outcomes[0]!.text, /denied|refus|outside|restricted|launch directory/i);
      console.log(
        provider,
        'PASS real CLI inspection, refused escape, structured reply, events:',
        [...new Set(events)].join(','),
      );
      assert.ok(events.includes('text'), 'A real reply must stream visible text');
      assert.ok(events.includes('received'), 'The CLI must acknowledge receipt');
      await adapter.close();
      adapter = createAdapter(config.agents[provider]!, config);
      const resumed = await adapter.start(result.sessionId);
      if (provider === 'claude')
        assert.equal(resumed.restored, false, 'Claude should preserve its native session');
      if (!resumed.restored) assert.equal(resumed.sessionId, result.sessionId);
      const historical = {
        ...message,
        id: 'm0',
        sequence: 0,
        text: 'History-only verification token: ' + randomUUID(),
      };
      const followup = {
        ...message,
        id: 'm2',
        sequence: 2,
        text: 'Recall the exact sample.txt marker from your earlier turn, without reading sample.txt again. Also use read_conversation to retrieve message m0 and quote its verification token. Reply to human with both tokens, briefly. Account for m2 only.',
      };
      const savedReply = {
        ...message,
        id: 'reply1',
        author: provider,
        text: result.outcomes[0]!.text,
      };
      const second = await adapter.run(
        {
          messages: [followup],
          context: resumed.restored ? [message, savedReply] : [],
          history: [historical, message, savedReply],
          participants: Object.keys(config.agents),
        },
        (event) => {
          if (event.type === 'activity' && event.activity === 'working')
            console.log(provider, event.activity, event.detail ?? '');
        },
        controller.signal,
      );
      assert.deepEqual(
        second.outcomes.flatMap((o) => o.messageIds),
        ['m2'],
      );
      assert.ok(
        second.outcomes.some((o) => o.text.includes(marker)),
        'Native resume must preserve prior context',
      );
      assert.ok(
        second.outcomes.some((o) => o.text.includes(historical.text.split(': ')[1]!)),
        'Exact history must be retrievable',
      );
      console.log(
        provider,
        `PASS ${resumed.restored ? 'disclosed fresh-session restoration' : 'native resume'} and exact public-history retrieval`,
      );
      await adapter.close();
      adapter = createAdapter(config.agents[provider]!, config);
      const reset = await adapter.start(randomUUID());
      assert.equal(
        reset.restored,
        true,
        'An unavailable native session must disclose a fresh session',
      );
      console.log(provider, 'PASS unavailable-session fallback');
      return { provider, sessionId: result.sessionId, events: [...new Set(events)] };
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
rmSync(base, { recursive: true, force: true });
