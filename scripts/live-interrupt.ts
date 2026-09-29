// No file edits. Interrupt each real CLI after it acknowledges a synthetic turn.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter } from '../src/adapters/index.js';
import type { RoomConfig, Provider } from '../src/types.js';
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-interrupt-')));
const config: RoomConfig = {
  workspace,
  permissions: { edits: false, commands: false, network: false },
  followUpTurns: 8,
  sources: [],
  provenance: {},
  agents: {},
};
const results = await Promise.allSettled(
  ((process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'claude']) as Provider[]).map(
    async (provider) => {
      const adapter = createAdapter(
        {
          id: provider,
          provider,
          enabled: true,
          instructions: 'This is an interruption check; use only the room tools.',
          fingerprint: provider,
        },
        config,
      );
      const controller = new AbortController();
      let received = false;
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        await adapter.start();
        await assert.rejects(
          adapter.run(
            {
              messages: [
                {
                  id: 'm1',
                  sequence: 1,
                  author: 'human',
                  text: 'Inspect this workspace and describe the files. Account for m1.',
                  recipients: [provider],
                  createdAt: new Date().toISOString(),
                  replyTo: [],
                  roots: ['m1'],
                  deliveries: {},
                },
              ],
              context: [],
              participants: ['codex', 'claude'],
            },
            (event) => {
              if (event.type === 'received') {
                received = true;
                controller.abort();
              }
            },
            controller.signal,
          ),
          /Interrupted/,
        );
        assert.equal(
          received,
          true,
          'The CLI must acknowledge the turn before the test interrupts it',
        );
        console.log(
          provider,
          'PASS explicit interruption after receipt; no completed outcome published',
        );
      } finally {
        clearTimeout(timeout);
        await adapter.close();
      }
    },
  ),
);
rmSync(workspace, { recursive: true, force: true });
for (const result of results)
  if (result.status === 'rejected') {
    console.error(result.reason);
    process.exitCode = 1;
  }
