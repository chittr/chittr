import {
  liveEvidenceIssue,
  liveImageSelection,
  liveImageDriver,
  liveSourceIdentity,
} from './live-image-selection.js';
import type { AgentAdapter } from '../src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { chromium, type Page } from '@playwright/test';
import { postBrowserCommand } from './browser-command.js';
import { RoomController } from '../src/controller.js';
import { Room } from '../src/room.js';
import { SessionStore } from '../src/store.js';
import { WebUI } from '../src/web.js';
import { turnPrompt } from '../src/protocol.js';
import type { RoomConfig } from '../src/types.js';

const selection = liveImageSelection();
const driver = liveImageDriver(selection);
const recipient = selection.adapter;
const source = liveSourceIdentity();
assert.equal(
  source.untracked,
  false,
  'Stage new source files before running to pin the full patch',
);

// Epic #29 integration acceptance through the real browser entry point: the
// image is pasted into the served web UI in a headless Chromium, uploaded by
// the page, and sent through /api/command with attachment identities. The host,
// storage, web server, Grok adapter and separate MCP process are all real; only
// the private fixture and oracle live in this script, outside task files. No
// oracle, image bytes, or provider transcript is retained in the evidence.
for (const key of Object.keys(process.env))
  if (/PROBE|ORACLE|FIXTURE/i.test(key)) delete process.env[key];
const root = realpathSync(mkdtempSync(join(selection.scratchParent, 'chittr-browser-live-')));
const workspace = join(root, 'workspace');
mkdirSync(workspace);
const colors = [
  ['red', [255, 0, 0]],
  ['green', [0, 160, 0]],
  ['blue', [0, 0, 255]],
  ['yellow', [255, 255, 0]],
  ['cyan', [0, 255, 255]],
  ['purple', [128, 0, 128]],
  ['black', [0, 0, 0]],
  ['white', [255, 255, 255]],
] as const;
const shuffled = [...colors];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = randomInt(i + 1);
  [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
}
const oracle = shuffled.map((x) => x[0]).join(',');
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data = Buffer.alloc(0)) {
  const name = Buffer.from(type);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}
const width = 640,
  height = 160,
  header = Buffer.alloc(13);
header.writeUInt32BE(width);
header.writeUInt32BE(height, 4);
header.set([8, 2, 0, 0, 0], 8);
const raster = Buffer.alloc(height * (width * 3 + 1));
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++)
    raster.set(shuffled[Math.floor(x / 80)]![1], y * (width * 3 + 1) + 1 + x * 3);
const pixels = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raster)),
  chunk('IEND'),
]);
const laterRaster = Buffer.alloc(raster.length);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++)
    laterRaster.set(shuffled[7 - Math.floor(x / 80)]![1], y * (width * 3 + 1) + 1 + x * 3);
const laterPixels = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(laterRaster)),
  chunk('IEND'),
]);
const laterOracle = [...shuffled]
  .reverse()
  .map((x) => x[0])
  .join(',');
const laterHash = createHash('sha256').update(laterPixels).digest('hex');
const hash = createHash('sha256').update(pixels).digest('hex');
const base64 = pixels.toString('base64');
const nativeEvents: object[] = [];
let phase = 'initial';
let step = 'startup';
const providerSessions: object[] = [];
const restoreObservers = driver.observe(root, () => phase, nativeEvents);
const policy = selection.permissions;
const config: RoomConfig = {
  workspace,
  humanName: 'Bill',
  permissions: policy,
  skills: selection.skills,
  commandAccess: selection.commandAccess,
  followUpTurns: 1,
  agents: {
    [recipient]: {
      id: recipient,
      provider: selection.adapter,
      model: selection.model,
      effort: selection.effort,
      enabled: true,
      instructions:
        'For the visual assertion, reply only to human. Put only the comma-separated lowercase color names in the outcome text, no spaces or explanation.',
      fingerprint: 'browser-live',
    },
  },
  sources: [],
  provenance: {},
};
const store = new SessionStore(workspace, join(root, 'state'));
store.acquire();
const adapters: AgentAdapter[] = [];
const turns: object[] = [];
const seeds: object[] = [];
let historicalId = '';
function makeRoom(c: RoomConfig, s: SessionStore, session?: import('../src/types.js').Session) {
  return new Room(c, s, session, (agent, cfg, env, access) => {
    const adapter = driver.create(agent, cfg, env, access);
    adapters.push(adapter);
    const start = adapter.start.bind(adapter);
    adapter.start = async (previousSession) => {
      const result = await start(previousSession);
      providerSessions.push({
        phase,
        previousSession,
        sessionId: result.sessionId,
        restored: result.restored,
        support: adapter.imageSupport?.(),
        tuple: driver.tuple(adapter),
        policy: driver.policy(adapter, cfg),
      });
      return result;
    };
    const run = adapter.run.bind(adapter);
    adapter.run = async (input, event, signal) => {
      const prompt = turnPrompt(input);
      turns.push({
        phase,
        inlineHasHistoricalId: historicalId ? prompt.includes(historicalId) : false,
        requiredHasAttachments: input.messages.some((x) => x.attachments?.length),
        requiredHasReplyTargets: input.messages.some((x) => x.replyTo.length),
        fullHistoryHasHistoricalId: historicalId
          ? JSON.stringify(input.history).includes(historicalId)
          : false,
      });
      if (phase === 'fresh-seed') {
        assert.ok(!prompt.includes(historicalId) && !prompt.includes(oracle));
        assert.ok(Buffer.byteLength(prompt) <= 131072);
        assert.ok(!input.messages.some((x) => x.attachments?.length || x.replyTo.length));
        seeds.push({
          phase,
          route: 'saved-room bounded first text turn',
          bytes: Buffer.byteLength(prompt),
          hasHistoricalId: false,
          hasOracle: false,
        });
      }
      if (phase === 'retrieval') {
        assert.ok(!prompt.includes(historicalId));
        assert.ok(!prompt.includes(oracle));
        assert.ok(!input.messages.some((x) => x.attachments?.length || x.replyTo.length));
      }
      const result = await run(input, event, signal);
      providerSessions.push({
        phase,
        boundary: 'turn-completed',
        sessionId: result.sessionId,
        tuple: driver.tuple(adapter),
        policy: driver.policy(adapter, cfg),
      });
      return result;
    };
    assert.ok(
      adapter.maintain,
      'Unavailable: selected adapter has no checkpoint seed implementation',
    );
    const maintain = adapter.maintain.bind(adapter);
    adapter.maintain = async (request, signal) => {
      if (request.kind === 'seed') {
        seeds.push({
          phase,
          hasHistoricalId: request.prompt.includes(historicalId),
          hasOracle: request.prompt.includes(oracle),
          bytes: Buffer.byteLength(request.prompt),
        });
        assert.ok(!request.prompt.includes(historicalId));
        assert.ok(!request.prompt.includes(oracle));
      }
      const result = await maintain(request, signal);
      providerSessions.push({
        phase,
        boundary: 'maintenance-completed',
        kind: request.kind,
        sessionId: result.sessionId,
        tuple: driver.tuple(adapter),
        policy: driver.policy(adapter, cfg),
      });
      return result;
    };
    return adapter;
  });
}
const controller: RoomController = new RoomController(config, store, undefined, {
  help: '',
  quit: async () => {},
  createRoom: makeRoom,
});
async function idle() {
  step = 'provider idle';
  const end = Date.now() + 240000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    const bad = Object.values(controller.room.session.agents).find(
      (x) => x.connection === 'unavailable' || x.error,
    );
    if (bad) throw new Error(`${bad.id}: ${bad.error}`);
    if (controller.room.isIdle() && controller.room.pending(recipient).queued === 0) return;
  }
  throw new Error('Live acceptance timed out');
}
async function waitFor(check: () => boolean, what: string, ms = 60000) {
  step = `wait: ${what}`;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const ask =
  'Name the colors of the eight vertical panels from left to right. Use each exact color name from red, green, blue, yellow, cyan, purple, black, white as seen. Return only a comma-separated list in the outcome text.';
// Browser boundary records: identities and shapes only, never bytes or answers.
const browserEvents: object[] = [];
async function pasteImage(page: Page, name: string, bytes = pixels) {
  await page.evaluate(
    ({ name, bytes }) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(bytes)], name, { type: 'image/png' }));
      document
        .querySelector('textarea[aria-label="Message"]')!
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
    },
    { name, bytes: [...bytes] },
  );
  // The page uploads the pasted file itself; wait until its preview rendered.
  await page.locator('.draft-images img').first().waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.draft-images img')].every(
        (node) => (node as HTMLImageElement).naturalWidth > 0,
      ),
    undefined,
    { timeout: 30000 },
  );
}
async function post(page: Page, line: string, timeout: number) {
  return postBrowserCommand(page, line, timeout, {
    step: (value) => {
      step = value;
    },
    retry: (commandId) =>
      browserEvents.push({ phase, boundary: 'browser-command-transport-retry', commandId }),
  });
}
async function send(page: Page, line: string) {
  const before = controller.room.session.messages.length;
  await post(page, line, 60000);
  await waitFor(
    () => controller.room.session.messages.length > before,
    `send of ${line.slice(0, 24)}`,
  );
  return controller.room.session.messages[before]!;
}
async function command(page: Page, line: string) {
  await post(page, line, 240000);
}
const evidence: any = {
  issue: liveEvidenceIssue(selection),
  entryPoint: 'browser',
  startedAt: new Date().toISOString(),
  source,
  selection: {
    adapter: selection.adapter,
    requestedModel: selection.model ?? 'provider default',
    effort: selection.effort ?? 'provider default',
    room: selection.room,
    freshRoute: selection.freshRoute,
  },
  requestedPolicy: {
    permissions: policy,
    skillsEnabled: selection.skills.enabled,
    commandMode: selection.commandAccess.mode,
    commandModeSource: selection.commandAccess.source,
  },
  fixture: { sha256: hash, byteSize: pixels.length, width, height },
};
const web = new WebUI(controller);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const url = await web.mount();
  await controller.room.start();
  browser = await chromium.launch(
    process.env.CHITTR_BROWSER
      ? { executablePath: process.env.CHITTR_BROWSER }
      : { channel: 'chrome' },
  );
  evidence.browser = { name: browser.browserType().name(), version: browser.version() };
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/command') {
      const body = request.postDataJSON?.() ?? {};
      browserEvents.push({
        phase,
        boundary: 'browser-command-request',
        line: typeof body.line === 'string' ? body.line.slice(0, 40) : undefined,
        attachmentIds: body.attachmentIds,
        // The browser's command id doubles as the attachment operation identity.
        commandId: typeof body.id === 'string' ? body.id : undefined,
        hasDraft: body.draft !== undefined,
      });
    }
  });
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname;
    if (path === '/api/command')
      browserEvents.push({
        phase,
        boundary: 'browser-command-response',
        status: response.status(),
      });
    if (path === '/api/attachments' && response.request().method() === 'POST') {
      const text = await response.text().catch(() => '');
      let attachment: any;
      try {
        attachment = JSON.parse(text).attachment;
      } catch {
        attachment = undefined;
      }
      browserEvents.push({
        phase,
        boundary: 'browser-upload-response',
        status: response.status(),
        contentType: response.request().headers()['content-type'],
        attachmentId: attachment?.id,
        byteSize: attachment?.byteSize,
        width: attachment?.width,
        height: attachment?.height,
        responseContainsBase64: text.includes(base64),
      });
    }
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'New conversation', exact: false }).waitFor();
  await waitFor(
    () => controller.room.session.agents[recipient]?.connection === 'ready',
    'Grok ready',
    120000,
  );

  if (selection.adapter === 'claude') {
    phase = 'warmup';
    await send(
      page,
      '@claude Reply to human with ready. This is a text-only model identity check.',
    );
    await idle();
    phase = 'initial';
  }
  const support = adapters[0]?.imageSupport?.();
  evidence.support = support;
  evidence.policy = driver.policy(adapters[0], config);
  assert.ok(
    support?.initial.available,
    support && !support.initial.available
      ? support.initial.reason
      : 'Unavailable: missing initial-image report',
  );
  assert.ok(
    support?.retrieval.available,
    support && !support.retrieval.available
      ? support.retrieval.reason
      : 'Unavailable: missing retrieval report',
  );
  // Initial delivery: paste into the served page, send addressed to Grok.
  await pasteImage(page, 'panels.png');
  const initialMessage = await send(page, `@${recipient} ${ask}`);
  assert.equal(initialMessage.attachments?.length, 1);
  assert.ok(initialMessage.attachmentOperation, 'Browser send carried no attachment operation');
  await idle();
  const initialAnswer = controller.room.session.messages.findLast((x) => x.author === recipient);
  assert.ok(initialAnswer?.text === oracle, 'Initial private visual assertion failed');
  assert.ok(
    nativeEvents.some(
      (event: any) =>
        event.phase === 'initial' &&
        event.sessionId === controller.room.session.agents[recipient]?.sessionId &&
        event.images.some((image: any) => image.sha256 === hash),
    ),
    'Missing correlated initial native delivery',
  );
  await page.locator(`[data-message-id="${initialAnswer.id}"]`).waitFor({ timeout: 15000 });
  const initialState = await (await page.request.get(new URL('/api/state', url).toString())).text();
  evidence.initial = {
    passed: true,
    roomSessionId: controller.room.session.id,
    providerSessionId: controller.room.session.agents[recipient]?.sessionId,
    messageId: initialMessage.id,
    attachmentId: initialMessage.attachments![0]!.id,
    attachmentOperationId: initialMessage.attachmentOperation!.id,
    answerRenderedInBrowser: true,
    browserStateContainsBase64: initialState.includes(base64),
    tuple: driver.tuple(adapters[0]),
    gate: adapters[0]?.imageSupport?.(),
  };
  assert.equal(evidence.initial.browserStateContainsBase64, false);

  if (['claude', 'grok', 'codex'].includes(selection.adapter)) {
    phase = 'later';
    const sameSession = controller.room.session.agents[recipient]?.sessionId;
    await pasteImage(page, 'later.png', laterPixels);
    const laterMessage = await send(page, `@${recipient} ${ask}`);
    await idle();
    assert.equal(
      controller.room.session.messages.findLast((x) => x.author === recipient)?.text,
      laterOracle,
      'Later private visual assertion failed',
    );
    assert.equal(controller.room.session.agents[recipient]?.sessionId, sameSession);
    assert.ok(
      nativeEvents.some(
        (e: any) =>
          e.phase === 'later' &&
          e.boundary === 'initial-native-request' &&
          e.sessionId === sameSession &&
          e.images.some((i: any) => i.sha256 === laterHash),
      ),
    );
    evidence.later = {
      passed: true,
      providerSessionId: sameSession,
      roomSessionId: controller.room.session.id,
      attachmentOperationId: laterMessage.attachmentOperation?.id,
      messageId: laterMessage.id,
      attachmentId: laterMessage.attachments![0]!.id,
      sha256: laterHash,
      byteSize: laterPixels.length,
      tuple: driver.tuple(adapters[0]),
    };
  }

  // Preparation: a separate saved room with the same pixels and no visual answer.
  // Address the image to human through the browser so Grok never receives it.
  phase = 'preparation';
  const previousRoomId = controller.room.session.id;
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await waitFor(() => controller.room.session.id !== previousRoomId, 'new conversation');
  await waitFor(
    () => controller.room.session.agents[recipient]?.connection === 'ready',
    'Grok ready in new room',
    120000,
  );
  await pasteImage(page, 'panels.png');
  const oldMessage = await send(page, '@human Saved visual reference.');
  historicalId = oldMessage.attachments![0]!.id;
  assert.ok(oldMessage.attachmentOperation);
  for (let i = 0; i < (selection.freshRoute === 'saved-room' ? 220 : 24); i++)
    await send(page, '@human ' + `Background note ${i}. ` + 'No pending task. '.repeat(70));
  await idle();
  // Fixture a valid saved checkpoint with an intentionally lossy summary. The
  // product reconnect path must keep full history despite that omission.
  const last = controller.room.session.messages.at(-1)!;
  controller.room.session.checkpoints = [
    {
      version: 1,
      createdAt: new Date().toISOString(),
      sourceAgent: recipient,
      through: last.sequence,
      messageId: last.id,
      entries: [
        {
          category: 'objective',
          text: 'The later background notes have no pending task.',
          sources: [{ messageId: last.id, author: last.author }],
        },
      ],
    },
  ];
  store.save(controller.room.session);
  assert.deepEqual(
    store.load(controller.room.session.id)?.checkpoints,
    controller.room.session.checkpoints,
  );
  evidence.checkpointRoundTripPassed = true;
  // Since #105 Codex selects native compaction on every build, so `/compact` is
  // no longer a fresh-thread route for it; use `--fresh-route saved-room`.
  if (selection.adapter === 'codex' && selection.freshRoute === 'checkpoint')
    assert.equal(
      (driver.tuple(adapters.at(-1)) as any)?.nativeCompaction,
      false,
      'Codex /compact runs natively on this build; rerun with --fresh-route saved-room',
    );
  const previousProviderSessionId = controller.room.session.agents[recipient]?.sessionId;

  // Retrieval: fresh provider session through the browser's /reconnect, then a
  // question with no new image, no replayed pixels and no reply target.
  if (selection.freshRoute === 'saved-room') {
    const savedId = controller.room.session.id;
    await page.getByRole('button', { name: 'New conversation', exact: false }).click();
    await waitFor(() => controller.room.session.id !== savedId, 'close historical fixture room');
    const saved = store.load(savedId)!;
    delete saved.agents[recipient]!.sessionId;
    saved.agents[recipient]!.contextThrough = 0;
    store.save(saved);
    phase = 'fresh-seed';
    await command(page, `/sessions ${savedId}`);
    await waitFor(
      () =>
        controller.room.session.id === savedId &&
        controller.room.session.agents[recipient]?.connection === 'ready',
      'fresh saved room',
    );
    await send(page, `@${recipient} Reply to human with ready. Do not inspect images yet.`);
    await idle();
    assert.notEqual(
      controller.room.session.agents[recipient]?.sessionId,
      previousProviderSessionId,
    );
    phase = 'retrieval';
  } else {
    phase = 'retrieval';
    await command(page, `/${selection.adapter === 'grok' ? 'reconnect' : 'compact'} @${recipient}`);
    await waitFor(
      () =>
        controller.room.session.agents[recipient]?.sessionId !== previousProviderSessionId &&
        controller.room.session.agents[recipient]?.connection === 'ready',
      'fresh Grok session',
      180000,
    );
    await idle();
    assert.equal(controller.room.session.agents[recipient]?.contextThrough, last.sequence);
    assert.equal(controller.room.session.agents[recipient]?.checkpointVersion, 1);
    assert.notEqual(
      controller.room.session.agents[recipient]?.sessionId,
      previousProviderSessionId,
    );
  }
  const question = await send(
    page,
    `@${recipient} Inspect the older saved visual reference in this room and answer: ${ask}`,
  );
  assert.equal(question.attachments, undefined);
  assert.deepEqual(question.replyTo, []);
  await command(page, `/continue @${recipient}`);
  await idle();
  const answer = controller.room.session.messages.findLast((x) => x.author === recipient);
  assert.ok(answer?.text === oracle, 'Fresh retrieval private visual assertion failed');
  await page.locator(`[data-message-id="${answer.id}"]`).waitFor({ timeout: 15000 });
  const trace: any[] =
    selection.adapter === 'codex'
      ? nativeEvents.filter((e: any) => e.phase === 'retrieval')
      : readFileSync(
          join(
            root,
            selection.freshRoute === 'saved-room' ? 'fresh-seed-mcp.jsonl' : 'retrieval-mcp.jsonl',
          ),
          'utf8',
        )
          .trim()
          .split('\n')
          .map((x) => JSON.parse(x));
  const discovery = trace.findIndex(
    (x) =>
      x.name === 'read_conversation' &&
      x.boundary === (selection.adapter === 'codex' ? 'history-discovery' : 'mcp-result') &&
      x.discovered?.some((d: any) => d.attachmentId === historicalId),
  );
  const request = trace.findIndex(
    (x) =>
      x.name === 'read_attachment' &&
      x.boundary === (selection.adapter === 'codex' ? 'dynamic-request' : 'mcp-request') &&
      (selection.adapter === 'codex' ? x.attachmentId : x.arguments.attachment_id) === historicalId,
  );
  const native = trace.find(
    (x) =>
      x.name === 'read_attachment' &&
      x.boundary === (selection.adapter === 'codex' ? 'dynamic-result' : 'mcp-result') &&
      x.images?.some((i: any) => i.sha256 === hash),
  );
  assert.ok(
    discovery >= 0 &&
      request > discovery &&
      (selection.adapter === 'codex'
        ? native?.success === true &&
          native?.sessionId === controller.room.session.agents[recipient]?.sessionId &&
          trace[request]?.roomSessionId === controller.room.session.id &&
          trace.indexOf(native) > request &&
          native.messageId === oldMessage.id &&
          native.attachmentId === oldMessage.attachments?.[0]?.id
        : native?.active === true && native?.roomSessionId === controller.room.session.id),
    'Missing correlated discovery, authorization and native image result',
  );
  assert.ok(seeds.length > 0);
  assert.ok(
    !nativeEvents.some(
      (event: any) =>
        ['retrieval', 'fresh-seed'].includes(event.phase) &&
        event.boundary === 'initial-native-request' &&
        event.images.length,
    ),
    'Fresh retrieval replayed initial pixels',
  );
  const retrievalState = await (
    await page.request.get(new URL('/api/state', url).toString())
  ).text();
  if (selection.adapter === 'claude') {
    const replay = nativeEvents.filter(
      (e: any) =>
        e.phase === 'retrieval' &&
        e.boundary === 'native-user-replay' &&
        e.sessionId === controller.room.session.agents[recipient]?.sessionId &&
        e.images.some((i: any) => i.sha256 === hash),
    );
    assert.ok(replay.length > 0, 'Missing correlated retrieval replay');
    assert.ok(
      replay.every(
        (e: any) =>
          e.images.length === 2 &&
          e.images.every((i: any) => i.sha256 === hash) &&
          e.frameBytes < 8 * 1024 * 1024,
      ),
      'Unexpected Claude replay representation',
    );
  }
  evidence.retrieval = {
    passed: true,
    roomSessionId: controller.room.session.id,
    previousProviderSessionId,
    providerSessionId: controller.room.session.agents[recipient]?.sessionId,
    attachmentId: historicalId,
    messageId: oldMessage.id,
    questionMessageId: question.id,
    contextThrough: selection.freshRoute === 'checkpoint' ? last.sequence : undefined,
    checkpointVersion: selection.freshRoute === 'checkpoint' ? 1 : undefined,
    freshRoute:
      selection.freshRoute === 'saved-room'
        ? 'saved-room fresh start'
        : selection.adapter !== 'grok'
          ? 'compact checkpoint replacement'
          : 'reconnect checkpoint replacement',
    checkpointFixture:
      'Schema-valid attributed saved checkpoint; SessionStore round-trip; selected browser fresh route and actual clean seed recorded separately',
    answerRenderedInBrowser: true,
    browserStateContainsBase64: retrievalState.includes(base64),
    tuple: driver.tuple(adapters.at(-1)),
    gate: adapters.at(-1)?.imageSupport?.(),
    trace,
  };
  assert.equal(evidence.retrieval.browserStateContainsBase64, false);
  if (selection.adapter === 'grok' || selection.adapter === 'codex') {
    for (const [name, path, digest] of [
      ['initial', evidence.initial, hash],
      ['later', evidence.later, laterHash],
    ] as const) {
      const requests = nativeEvents.filter(
        (e: any) => e.phase === name && e.boundary === 'initial-native-request',
      );
      assert.equal(requests.length, 1, 'Expected one ACP image request for this send');
      const request = requests[0] as any;
      assert.equal(request.sessionId, path.providerSessionId);
      assert.equal(request.images.length, 1, 'Only the newly sent image may be delivered');
      assert.equal(request.images[0].sha256, digest);
      assert.deepEqual(request.associations, [
        `Chittr image for message #${path.messageId}, attachment ${path.attachmentId}.`,
      ]);
      assert.ok(path.attachmentOperationId);
      path.nativeRequestId = request.requestId;
    }
  }
  evidence.visualAssertion = {
    rule: 'whole-field exact equality',
    initialPassed: true,
    retrievalPassed: true,
    oracleRetained: false,
    privateFixtureOutsideTaskFiles: true,
  };
  evidence.browserEvents = browserEvents;
  evidence.nativeEvents = nativeEvents;
  evidence.providerSessions = providerSessions;
  evidence.observedEffort =
    selection.adapter === 'grok' || selection.adapter === 'codex'
      ? ((driver.tuple(adapters.at(-1)) as { observedEffort?: string })?.observedEffort ??
        'unknown')
      : 'unknown';
  evidence.turns = turns;
  evidence.seeds = seeds;
  evidence.serialization = {
    sessionContainsBase64: JSON.stringify(controller.room.session).includes(base64),
    seedContainsAttachmentId: false,
    retrievalInlineContainsAttachmentId: false,
  };
  assert.equal(evidence.serialization.sessionContainsBase64, false);
  assert.ok(
    browserEvents.some(
      (x: any) =>
        x.boundary === 'browser-command-request' &&
        x.phase === 'initial' &&
        Array.isArray(x.attachmentIds) &&
        x.attachmentIds[0] === evidence.initial.attachmentId &&
        x.commandId === evidence.initial.attachmentOperationId,
    ),
    'Initial send did not originate from the browser with attachment identities',
  );
  assert.ok(
    browserEvents.every((x: any) => x.responseContainsBase64 !== true),
    'An upload response echoed image bytes',
  );
  evidence.endedAt = new Date().toISOString();
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(
    `PASS browser-origin initial and fresh-session aged-history visual acceptance. Evidence: ${root}/evidence.json`,
  );
} catch (error) {
  console.error('BLOCKED: live image verification did not complete; inspect sanitized evidence');
  writeFileSync(
    join(root, 'partial-evidence.json'),
    JSON.stringify(
      {
        ...evidence,
        status: 'failed',
        phase,
        step,
        failureType: error instanceof Error ? error.name : 'unknown',
        providerSessions,
        browserEvents,
        nativeEvents,
        turns,
        seeds,
      },
      null,
      2,
    ),
  );
  console.error(`Preserved sanitized boundary evidence: ${root}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await controller.close().catch(() => {});
  web.unmount();
  store.release();
  restoreObservers();
}
