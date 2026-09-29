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
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { RoomController } from '../src/controller.js';
import { Room } from '../src/room.js';
import { SessionStore } from '../src/store.js';
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

// The private fixture and oracle stay in this host process, outside task files.
// No oracle, image, or full provider transcript is retained in the evidence.
for (const key of Object.keys(process.env))
  if (/PROBE|ORACLE|FIXTURE/i.test(key)) delete process.env[key];
const root = realpathSync(mkdtempSync(join(selection.scratchParent, 'chittr-retrieval-live-')));
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
const nativeEvents: object[] = [];
let phase = 'initial';
let step = 'startup';
const providerSessions: object[] = [];
const restoreObservers = driver.observe(root, () => phase, nativeEvents);
const policy = selection.permissions;
const config: RoomConfig = {
  workspace,
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
      fingerprint: 'retrieval-live',
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
function controller(session?: Parameters<typeof makeRoom>[2]) {
  return new RoomController(config, store, session, {
    help: '',
    quit: async () => {},
    createRoom: makeRoom,
  });
}
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
async function idle(c: RoomController) {
  step = 'provider idle';
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    const bad = Object.values(c.room.session.agents).find(
      (x) => x.connection === 'unavailable' || x.error,
    );
    if (bad) throw new Error(`${bad.id}: ${bad.error}`);
    if (c.room.isIdle() && c.room.pending(recipient).queued === 0) return;
  }
  throw new Error('Live acceptance timed out');
}
const ask =
  'Name the colors of the eight vertical panels from left to right. Use each exact color name from red, green, blue, yellow, cyan, purple, black, white as seen. Return only a comma-separated list in the outcome text.';
let initial = controller();
let retrieval: RoomController | undefined;
const evidence: any = {
  issue: liveEvidenceIssue(selection),
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
try {
  await initial.room.start();
  if (selection.adapter === 'claude') {
    phase = 'warmup';
    await initial.submit(
      '@claude Reply to human with ready. This is a text-only model identity check.',
    );
    await idle(initial);
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
  const initialMeta = await initial.stageAttachment({
    sessionId: initial.room.session.id,
    operationId: randomUUID(),
    filename: 'fixture.png',
    mediaType: 'image/png',
    bytes: pixels,
  });
  const initialOperation = randomUUID();
  await initial.submit(`@${recipient} ${ask}`, initial.room.session.id, {
    attachmentIds: [initialMeta.id],
    operationId: initialOperation,
  });
  await idle(initial);
  const initialAnswer = initial.room.session.messages.findLast((x) => x.author === recipient);
  assert.ok(initialAnswer?.text === oracle, 'Initial private visual assertion failed');
  assert.ok(
    nativeEvents.some(
      (event: any) =>
        event.phase === 'initial' &&
        event.sessionId === initial.room.session.agents[recipient]?.sessionId &&
        event.images.some((image: any) => image.sha256 === hash),
    ),
    'Missing correlated initial native delivery',
  );
  evidence.initial = {
    passed: true,
    roomSessionId: initial.room.session.id,
    providerSessionId: initial.room.session.agents[recipient]?.sessionId,
    attachmentId: initialMeta.id,
    messageId: initial.room.session.messages.find(
      (x) => x.attachmentOperation?.id === initialOperation,
    )?.id,
    attachmentOperationId: initialOperation,
    tuple: driver.tuple(adapters[0]),
  };
  if (['claude', 'grok', 'codex'].includes(selection.adapter)) {
    phase = 'later';
    const sameSession = initial.room.session.agents[recipient]?.sessionId;
    const metadata = await initial.stageAttachment({
      sessionId: initial.room.session.id,
      operationId: randomUUID(),
      filename: 'later.png',
      mediaType: 'image/png',
      bytes: laterPixels,
    });
    const laterOperation = randomUUID();
    await initial.submit(`@${recipient} ${ask}`, initial.room.session.id, {
      attachmentIds: [metadata.id],
      operationId: laterOperation,
    });
    await idle(initial);
    assert.equal(
      initial.room.session.messages.findLast((x) => x.author === recipient)?.text,
      laterOracle,
      'Later private visual assertion failed',
    );
    assert.equal(initial.room.session.agents[recipient]?.sessionId, sameSession);
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
      attachmentId: metadata.id,
      roomSessionId: initial.room.session.id,
      attachmentOperationId: laterOperation,
      messageId: initial.room.session.messages.find(
        (x) => x.attachmentOperation?.id === laterOperation,
      )?.id,
      sha256: laterHash,
      byteSize: laterPixels.length,
      tuple: driver.tuple(adapters[0]),
    };
  }
  await initial.close();
  // A separate saved room has the same pixels but no previous visual answer.
  // Stage/send through C2. Address it to human so there is no initial-image replay.
  phase = 'preparation';
  retrieval = controller();
  await retrieval.room.start();
  const meta = await retrieval.stageAttachment({
    sessionId: retrieval.room.session.id,
    operationId: randomUUID(),
    filename: 'fixture.png',
    mediaType: 'image/png',
    bytes: pixels,
  });
  historicalId = meta.id;
  await retrieval.submit('@human Saved visual reference.', retrieval.room.session.id, {
    attachmentIds: [meta.id],
    operationId: randomUUID(),
  });
  const oldMessage = retrieval.room.session.messages.at(-1)!;
  for (let i = 0; i < (selection.freshRoute === 'saved-room' ? 220 : 24); i++)
    await retrieval.submit(
      '@human ' + `Background note ${i}. ` + 'No pending task. '.repeat(70),
      retrieval.room.session.id,
    );
  // Fixture a valid saved checkpoint with an intentionally lossy summary. The
  // product reconnect path must keep full history despite that omission.
  const last = retrieval.room.session.messages.at(-1)!;
  retrieval.room.session.checkpoints = [
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
  store.save(retrieval.room.session);
  assert.deepEqual(
    store.load(retrieval.room.session.id)?.checkpoints,
    retrieval.room.session.checkpoints,
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
  const previousProviderSessionId = retrieval.room.session.agents[recipient]?.sessionId;
  if (selection.freshRoute === 'saved-room') {
    const id = retrieval.room.session.id;
    await retrieval.close();
    const saved = store.load(id)!;
    delete saved.agents[recipient]!.sessionId;
    saved.agents[recipient]!.contextThrough = 0;
    store.save(saved);
    retrieval = controller(store.load(id));
    phase = 'fresh-seed';
    await retrieval.room.start();
    await retrieval.submit(`@${recipient} Reply to human with ready. Do not inspect images yet.`);
    await idle(retrieval);
    assert.notEqual(retrieval.room.session.agents[recipient]?.sessionId, previousProviderSessionId);
    phase = 'retrieval';
  } else {
    phase = 'retrieval';
    await retrieval.submit(
      `/${selection.adapter === 'grok' ? 'reconnect' : 'compact'} @${recipient}`,
    );
    await idle(retrieval);
    assert.equal(retrieval.room.session.agents[recipient]?.contextThrough, last.sequence);
    assert.equal(retrieval.room.session.agents[recipient]?.checkpointVersion, 1);
    assert.notEqual(retrieval.room.session.agents[recipient]?.sessionId, previousProviderSessionId);
  }
  await retrieval.submit(
    `@${recipient} Inspect the older saved visual reference in this room and answer: ${ask}`,
  );
  await retrieval.submit(`/continue @${recipient}`);
  await idle(retrieval);
  const answer = retrieval.room.session.messages.findLast((x) => x.author === recipient);
  assert.ok(answer?.text === oracle, 'Fresh retrieval private visual assertion failed');
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
      x.discovered?.some((d: any) => d.attachmentId === meta.id),
  );
  const request = trace.findIndex(
    (x) =>
      x.name === 'read_attachment' &&
      x.boundary === (selection.adapter === 'codex' ? 'dynamic-request' : 'mcp-request') &&
      (selection.adapter === 'codex' ? x.attachmentId : x.arguments.attachment_id) === meta.id,
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
          native?.sessionId === retrieval.room.session.agents[recipient]?.sessionId &&
          trace[request]?.roomSessionId === retrieval.room.session.id &&
          trace.indexOf(native) > request &&
          native.messageId === oldMessage.id &&
          native.attachmentId === oldMessage.attachments?.[0]?.id
        : native?.active === true && native?.roomSessionId === retrieval.room.session.id),
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
  if (selection.adapter === 'claude') {
    const replay = nativeEvents.filter(
      (e: any) =>
        e.phase === 'retrieval' &&
        e.boundary === 'native-user-replay' &&
        e.sessionId === retrieval!.room.session.agents[recipient]?.sessionId &&
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
    roomSessionId: retrieval.room.session.id,
    previousProviderSessionId,
    providerSessionId: retrieval.room.session.agents[recipient]?.sessionId,
    attachmentId: meta.id,
    messageId: oldMessage.id,
    contextThrough: selection.freshRoute === 'checkpoint' ? last.sequence : undefined,
    checkpointVersion: selection.freshRoute === 'checkpoint' ? 1 : undefined,
    freshRoute:
      selection.freshRoute === 'saved-room'
        ? 'saved-room fresh start'
        : selection.adapter !== 'grok'
          ? 'compact checkpoint replacement'
          : 'reconnect checkpoint replacement',
    checkpointFixture:
      'Schema-valid lossy saved checkpoint; SessionStore round-trip; selected fresh route and actual clean seed recorded separately',
    tuple: driver.tuple(adapters.at(-1)),
    trace,
  };
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
    sessionContainsBase64: JSON.stringify(retrieval.room.session).includes(
      pixels.toString('base64'),
    ),
    seedContainsAttachmentId: false,
    retrievalInlineContainsAttachmentId: false,
  };
  assert.equal(evidence.serialization.sessionContainsBase64, false);
  evidence.endedAt = new Date().toISOString();
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(
    `PASS initial and fresh-session aged-history visual acceptance. Evidence: ${root}/evidence.json`,
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
  await initial.close();
  await retrieval?.close();
  store.release();
  restoreObservers();
}
