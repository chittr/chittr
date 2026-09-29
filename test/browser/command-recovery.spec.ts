import { expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Room } from '../../src/room.js';
import { RoomController } from '../../src/controller.js';
import { SessionStore } from '../../src/store.js';
import { WebUI } from '../../src/web.js';
import type { RoomConfig } from '../../src/types.js';
import { postBrowserCommand } from '../../scripts/browser-command.js';

// Real browser, client timeout, server request cache and controller queue.
// Only native startup is fake; the test never contacts a provider.
test('checks a timed-out browser reconnect with the same operation ID, without reconnecting twice', async ({
  page,
}) => {
  test.setTimeout(60000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'browser-command-recovery-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const store = new SessionStore(workspace, join(root, 'state'));
  store.acquire();
  const config: RoomConfig = {
    workspace,
    permissions: { edits: false, commands: false, network: false },
    skills: { enabled: false },
    followUpTurns: 1,
    sources: [],
    provenance: {},
    agents: {
      grok: { id: 'grok', provider: 'grok', enabled: true, instructions: '', fingerprint: 'test' },
    },
  };
  let starts = 0;
  let releaseReconnect = () => {};
  const reconnectReady = new Promise<void>((resolve) => {
    releaseReconnect = resolve;
  });
  const controller = new RoomController(config, store, undefined, {
    help: '',
    quit: async () => {},
    createRoom: (cfg, persistence, session) =>
      new Room(cfg, persistence, session, () => ({
        start: async () => {
          starts++;
          if (starts > 1) await reconnectReady;
          return { sessionId: randomUUID(), restored: false };
        },
        run: async () => ({ outcomes: [] }),
        interrupt: async () => {},
        close: async () => {},
      })),
  });
  const web = new WebUI(controller);
  try {
    const url = await web.mount();
    await controller.room.start();
    const previous = controller.room.session.agents.grok!.sessionId;
    const ids: string[] = [];
    const retries: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/command') {
        ids.push(request.postDataJSON().id);
        if (ids.length === 2) releaseReconnect();
      }
    });
    await page.goto(url);
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await postBrowserCommand(page, '/reconnect @grok', 45000, {
      step: () => {},
      retry: (id) => retries.push(id),
    });
    expect(retries).toHaveLength(1);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(retries[0]).toBe(ids[0]);
    expect(starts).toBe(2);
    expect(controller.room.session.agents.grok!.sessionId).not.toBe(previous);
  } finally {
    releaseReconnect();
    await controller.close();
    web.unmount();
    store.release();
    rmSync(root, { recursive: true, force: true });
  }
});
