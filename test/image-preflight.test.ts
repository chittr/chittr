import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Room } from '../src/room.js';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import { WebUI } from '../src/web.js';
import { transcript } from '../src/ui/terminal.js';
import { projectRoom } from '../src/snapshot.js';
import { participantStatus } from '../src/participant-status.js';
import { grokInitialImageGate, legacyRestrictedGrokBuild } from '../src/adapters/grok.js';
import { unavailableImageSupport } from '../src/image-support.js';
import type {
  AgentAdapter,
  AgentConfig,
  AdapterEvent,
  InitialImageSupport,
  Outcome,
  RoomConfig,
  TurnInput,
  TurnResult,
} from '../src/types.js';
import { tinyPng } from './image-fixture.js';

// Room scheduling, persistence, attachment staging and both status views are real.
// Only the provider transport is a deterministic fake.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
class Fake implements AgentAdapter {
  inputs: TurnInput[] = [];
  starts = 0;
  closes = 0;
  pending?: { resolve: (value: TurnResult) => void; reject: (error: Error) => void };
  async start(id?: string) {
    this.starts++;
    return { sessionId: id ?? 'native-session', restored: false };
  }
  run(input: TurnInput, _event: (e: AdapterEvent) => void, signal: AbortSignal) {
    this.inputs.push(input);
    return new Promise<TurnResult>((resolve, reject) => {
      this.pending = { resolve, reject };
      signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
    });
  }
  finish(outcomes?: Outcome[]) {
    const input = this.inputs.at(-1)!;
    this.pending!.resolve({
      outcomes:
        outcomes ??
        input.messages.map((m) => ({
          messageIds: [m.id],
          kind: 'pass',
          text: 'Nothing to add',
          recipients: [],
        })),
      sessionId: 'native-session',
    });
    this.pending = undefined;
  }
  async interrupt() {
    this.pending?.reject(new Error('Interrupted'));
  }
  async close() {
    this.closes++;
    await this.interrupt();
  }
}
/** Reports the real Grok gate for the live effective config it was started with. */
class GrokLike extends Fake {
  gate: InitialImageSupport;
  constructor(agent: AgentConfig, config: RoomConfig) {
    super();
    this.gate = grokInitialImageGate({
      cliVersion: legacyRestrictedGrokBuild,
      requestedModel: agent.model ?? 'provider default',
      observedModel: 'grok-4.6',
      permissions: config.permissions,
      skillsEnabled: config.skills?.enabled !== false,
      nativeInventoryVerified: true,
    });
  }
  get nativeInitialImages() {
    return this.gate.available;
  }
  imageSupport() {
    return { provider: 'grok' as const, initial: this.gate, retrieval: this.gate };
  }
}

let root: string, workspace: string, store: SessionStore;
const rooms: Room[] = [];
const agent = (id: string, provider: AgentConfig['provider'], model?: string): AgentConfig => ({
  id,
  provider,
  enabled: true,
  instructions: '',
  fingerprint: id,
  ...(model ? { model } : {}),
});
const config = (): RoomConfig => ({
  workspace,
  permissions: { edits: false, commands: false, network: false },
  skills: { enabled: false },
  followUpTurns: 8,
  sources: [],
  provenance: {},
  agents: {
    claude: agent('claude', 'claude'),
    codex: agent('codex', 'codex'),
    grok: agent('grok', 'grok'),
  },
});
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-image-preflight-')));
  workspace = join(root, 'workspace');
  mkdirSync(workspace);
  store = new SessionStore(workspace, join(root, 'state'));
  store.acquire();
});
afterEach(async () => {
  for (const room of rooms.splice(0)) await room.close();
  store.release();
  rmSync(root, { recursive: true, force: true });
});
function setup(cfg = config(), previous?: ReturnType<SessionStore['load']>) {
  const made: Record<string, Fake[]> = {};
  const room = new Room(cfg, store, previous, (definition, roomConfig) => {
    const adapter =
      definition.provider === 'grok' ? new GrokLike(definition, roomConfig) : new Fake();
    (made[definition.id] ??= []).push(adapter);
    return adapter;
  });
  rooms.push(room);
  return { room, made, adapter: (id: string) => made[id]!.at(-1)! };
}
const stage = (sessionId: string) =>
  store.stageAttachment({
    sessionId,
    operationId: randomUUID(),
    filename: 'fixture.png',
    mediaType: 'image/png',
    bytes: tinyPng(),
  });
const sendImage = (room: Room, line: string) =>
  room.send(line, undefined, {
    attachmentIds: [stage(room.session.id).id],
    operationId: randomUUID(),
  });
const base64 = tinyPng().toString('base64');

it('applies connection precedence and exposes the live structured initial-image status', async () => {
  const { room, adapter } = setup();
  expect(room.initialImageSupport('claude')).toMatchObject({
    available: false,
    status: 'not_observed',
  });
  await room.start();
  const claude = adapter('claude');
  expect(room.initialImageSupport('claude')).toMatchObject({
    available: false,
    status: 'unsupported',
  });
  Object.assign(claude, {
    imageSupport: () => ({
      provider: 'claude' as const,
      initial: { available: true as const, status: 'available' as const },
      retrieval: { available: true as const, status: 'available' as const },
    }),
  });
  expect(room.initialImageSupport('claude')).toEqual({
    available: true,
    status: 'available',
  });
  room.session.agents.claude!.connection = 'unavailable';
  expect(room.initialImageSupport('claude')).toMatchObject({
    available: false,
    status: 'not_observed',
  });
  room.config.agents.claude!.enabled = false;
  expect(room.initialImageSupport('claude')).toBeUndefined();
});

it('exposes connected Antigravity as unsupported through shared participant status', async () => {
  const cfg = {
    ...config(),
    agents: { antigravity: agent('antigravity', 'antigravity') },
  };
  const adapter = Object.assign(new Fake(), {
    imageSupport: () => unavailableImageSupport('antigravity', '1.1.27'),
  });
  const room = new Room(cfg, store, undefined, () => adapter);
  rooms.push(room);
  const controller = new RoomController(cfg, store, undefined, {
    help: '',
    quit: async () => {},
    createRoom: () => room,
  });
  try {
    await room.start();
    expect(controller.snapshot().agents).toEqual([
      expect.objectContaining({
        id: 'antigravity',
        connection: 'ready',
        initialImageSupport: expect.objectContaining({
          available: false,
          status: 'unsupported',
        }),
      }),
    ]);
    await controller.submit('/participants');
    expect(room.session.notices.at(-1)?.text).toContain('Initial images: unsupported');
  } finally {
    await controller.close();
  }
});

it('keeps image deliveries queued without a ready adapter and dispatches them after connect', async () => {
  const cfg = {
    ...config(),
    agents: { claude: agent('claude', 'claude') },
  };
  const adapter = Object.assign(new Fake(), {
    imageSupport: () => ({
      provider: 'claude' as const,
      initial: { available: true as const, status: 'available' as const },
      retrieval: { available: true as const, status: 'available' as const },
    }),
  });
  const room = new Room(cfg, store, undefined, () => adapter);
  rooms.push(room);
  const connecting = sendImage(room, '@claude first');
  await tick();
  expect(connecting.deliveries.claude).toEqual({ status: 'queued' });
  expect(room.session.notices).toEqual([]);

  room.session.agents.claude = {
    id: 'claude',
    connection: 'unavailable',
    activity: 'available',
    paused: false,
    fingerprint: 'claude',
    contextThrough: 0,
    draft: '',
  };
  const unavailable = sendImage(room, '@claude second');
  await tick();
  expect(unavailable.deliveries.claude).toEqual({ status: 'queued' });
  expect(room.session.notices).toEqual([]);

  await room.start();
  await tick();
  expect(adapter.inputs).toHaveLength(1);
  expect(adapter.inputs[0]!.messages.map((message) => message.id)).toEqual([
    connecting.id,
    unavailable.id,
  ]);
  expect(adapter.inputs[0]!.messages.every((message) => message.attachments?.length === 1)).toBe(
    true,
  );
  expect(connecting.deliveries.claude?.status).toBe('sent');
  expect(unavailable.deliveries.claude?.status).toBe('sent');
  adapter.finish();
});

it('fails only the image delivery for a recipient without an image route and keeps its text flowing without reconnect', async () => {
  const { room, adapter } = setup();
  await room.start();
  const claude = adapter('claude');
  // A legacy capability declaration cannot authorize image dispatch.
  Object.assign(claude, { nativeInitialImages: true });
  room.send('@claude before');
  const image = sendImage(room, '@claude look at this');
  room.send('@claude after');
  await tick();
  // Text before and after the image left in one batch; the image never reached the provider.
  expect(claude.inputs.map((input) => input.messages.map((m) => m.id))).toEqual([['m1', 'm3']]);
  expect(claude.inputs[0]!.messages.some((m) => m.attachments?.length)).toBe(false);
  expect(image.deliveries.claude).toEqual({
    status: 'failed',
    rationale: expect.stringContaining(
      'no initial-image route is enabled for @claude (claude adapter)',
    ),
  });
  expect(image.deliveries.claude!.rationale).toContain('Text chat with @claude remains available');
  expect(image.deliveries.claude!.rationale).toContain(
    'Retry this image only after that support or room policy changes',
  );
  expect(image.attachments).toHaveLength(1);
  expect(room.session.agents.claude).toMatchObject({ connection: 'ready' });
  expect(room.session.agents.claude!.error).toBeUndefined();
  expect(claude.closes).toBe(0);
  const notice = room.session.notices.find((n) => n.text.includes('#m2'))!;
  expect(notice.text).toContain(
    'claude: image in #m2 was not delivered: no initial-image route is enabled for @claude',
  );
  expect(notice.text).toContain('@claude stays connected and text chat continues');
  expect(notice.text).toContain(
    '/retry #m2 @claude is useful only after that support or room policy changes',
  );
  expect(notice.text).not.toContain(base64);
  expect(room.pending('claude')).toEqual({ queued: 0, capped: 0, unresolved: 1 });
  claude.finish();
  await tick();
  expect(participantStatus(room.session.agents.claude!)).toEqual({
    status: 'Available',
    detail: 'Ready for your next message',
  });
  // Later text is delivered on the same connection.
  room.send('@claude later');
  await tick();
  expect(claude.inputs).toHaveLength(2);
  expect(claude.starts).toBe(1);
  expect(Object.values(room.session.exchanges).map((e) => e.used)).toEqual([0, 0, 0, 0]);
  claude.finish();
  await tick();
  // Retry against the unchanged gate fails again without a provider attempt or disconnect.
  const notices = room.session.notices.length;
  room.retry('m2', 'claude');
  await tick();
  expect(image.deliveries.claude).toEqual({
    status: 'failed',
    rationale: expect.stringContaining('no initial-image route'),
  });
  expect(claude.inputs).toHaveLength(2);
  expect(claude.closes).toBe(0);
  expect(room.session.agents.claude!.connection).toBe('ready');
  expect(room.session.notices.length).toBe(notices + 1);
});

it('reports the applicable Grok tuple conditions per recipient and re-checks the live gate on retry after a policy change', async () => {
  const cfg = config();
  cfg.permissions = { edits: true, commands: true, network: true };
  cfg.skills = { enabled: true };
  cfg.agents.grok = agent('grok', 'grok', 'grok-4.6');
  const { room, made } = setup(cfg);
  await room.start();
  const image = sendImage(room, '@grok describe');
  await tick();
  const rationale = image.deliveries.grok!.rationale!;
  expect(image.deliveries.grok!.status).toBe('failed');
  expect(image.deliveries.grok!.attemptId).toBeUndefined();
  expect(rationale).toContain("Grok's verified initial-image tuple does not match");
  // #105: the explicit model request is reported as evidence, never as a mismatch.
  expect(rationale).not.toContain('requested explicitly');
  expect(rationale).not.toContain('verified tuple requires the provider-default request');
  expect(rationale).toContain('observed model grok-4.6');
  expect(rationale).toContain('room permissions edits, commands and network are on');
  expect(rationale).toContain('skills are enabled; the verified tuple requires skills disabled');
  expect(rationale).not.toContain('CLI version');
  expect(rationale).toContain('Text chat with @grok remains available');
  expect(made.grok).toHaveLength(1);
  expect(made.grok![0]!.inputs).toHaveLength(0);
  expect(made.grok![0]!.closes).toBe(0);
  expect(room.session.agents.grok!.connection).toBe('ready');
  expect(room.config.permissions).toEqual({ edits: true, commands: true, network: true });
  // Text still flows to the same Grok connection.
  room.send('@grok text only');
  await tick();
  expect(made.grok![0]!.inputs.map((input) => input.messages.map((m) => m.id))).toEqual([['m2']]);
  made.grok![0]!.finish();
  await tick();
  room.retry('m1', 'grok');
  await tick();
  expect(image.deliveries.grok!.status).toBe('failed');
  expect(made.grok).toHaveLength(1);
  expect(made.grok![0]!.inputs).toHaveLength(1);
  // A genuine enablement change: the reloaded policy reconnects Grok with a passing tuple.
  const next = config();
  await room.reload(next);
  expect(made.grok).toHaveLength(2);
  room.retry('m1', 'grok');
  await tick();
  const delivered = made.grok![1]!.inputs[0]!.messages[0]!;
  expect(delivered.id).toBe('m1');
  expect(delivered.attachments![0]!.id).toBe(image.attachments![0]!.id);
  expect(image.deliveries.grok).toEqual({ status: 'sent', attemptId: expect.any(String) });
});

async function mixedBatch(withImage: boolean) {
  const { room, adapter } = setup();
  await room.start();
  const codex = adapter('codex'),
    claude = adapter('claude');
  room.pause('claude');
  room.send('@codex A');
  room.send('@codex B');
  await tick();
  codex.finish([
    { messageIds: ['m1'], kind: 'reply', text: 'For claude, A', recipients: ['claude'] },
    { messageIds: ['m2'], kind: 'reply', text: 'For claude, B', recipients: ['claude'] },
  ]);
  await tick();
  if (withImage) sendImage(room, '@claude and this image');
  await room.continue('claude');
  await tick();
  return { room, claude };
}

it('charges a mixed batch exactly like the equivalent text-only batch and fails no runnable text', async () => {
  const plain = await mixedBatch(false);
  const mixed = await mixedBatch(true);
  for (const { claude } of [plain, mixed])
    expect(claude.inputs.map((input) => input.messages.map((m) => m.id))).toEqual([['m3', 'm4']]);
  const used = (room: Room) => ({
    m1: room.session.exchanges.m1!.used,
    m2: room.session.exchanges.m2!.used,
  });
  expect(used(mixed.room)).toEqual(used(plain.room));
  expect(used(mixed.room)).toEqual({ m1: 1, m2: 1 });
  expect(mixed.room.session.exchanges.m5!.used).toBe(0);
  const m5 = mixed.room.message('m5')!;
  expect(m5.deliveries.claude).toEqual({
    status: 'failed',
    rationale: expect.stringContaining('no initial-image route'),
  });
  for (const id of ['m3', 'm4'])
    expect(mixed.room.message(id)!.deliveries.claude).toEqual({
      status: 'sent',
      attemptId: mixed.room.session.agents.claude!.active!.id,
    });
  expect(mixed.room.session.agents.claude!.connection).toBe('ready');
});

it('lets an image-capable recipient receive its own delivery while the unsupported recipient fails', async () => {
  const { room, adapter } = setup();
  await room.start();
  const grok = adapter('grok'),
    claude = adapter('claude');
  expect(grok).toHaveProperty('nativeInitialImages', true);
  const image = sendImage(room, '@grok @claude compare');
  await tick();
  expect(grok.inputs[0]!.messages[0]!.attachments).toEqual(image.attachments);
  expect(image.deliveries.grok).toEqual({ status: 'sent', attemptId: expect.any(String) });
  expect(image.deliveries.claude).toEqual({
    status: 'failed',
    rationale: expect.stringContaining('no initial-image route is enabled for @claude'),
  });
  expect(claude.inputs).toHaveLength(0);
  expect(room.session.agents.claude!.connection).toBe('ready');
  grok.finish();
  await tick();
  expect(image.deliveries.grok!.status).toBe('passed');
});

it('persists the byte-free reason across reload and shows it in the terminal transcript and browser snapshot without an unavailable connection', async () => {
  const assets = join(root, 'assets');
  mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<h1>App</h1>');
  const made: Fake[] = [];
  let controller!: RoomController;
  controller = new RoomController(config(), store, undefined, {
    help: '',
    quit: async () => controller.close(),
    createRoom: (cfg, persistence, session) =>
      new Room(cfg, persistence, session, (definition, roomConfig) => {
        const adapter =
          definition.provider === 'grok' ? new GrokLike(definition, roomConfig) : new Fake();
        made.push(adapter);
        return adapter;
      }),
  });
  const web = new WebUI(controller, { assets });
  await web.mount();
  try {
    await controller.room.start();
    const room = controller.room;
    const image = sendImage(room, '@claude what is this');
    await tick();
    const saved = store.load(room.session.id);
    if (!saved) throw new Error('expected the image-bearing session to be persisted');
    expect(saved.messages[0]!.deliveries.claude).toEqual({
      status: 'failed',
      rationale: expect.stringContaining('no initial-image route is enabled for @claude'),
    });
    expect(saved.messages[0]!.attachments).toEqual(image.attachments);
    expect(JSON.stringify(saved)).not.toContain(base64);
    const rows = transcript(projectRoom(room), 200).map((line) => line.text);
    expect(rows.some((text) => text.includes('claude: failed · Image not delivered:'))).toBe(true);
    expect(rows.some((text) => text.includes('claude: image in #m1 was not delivered'))).toBe(true);
    expect(rows.some((text) => /unavailable:/.test(text))).toBe(false);
    const snapshot = web.snapshot();
    expect(snapshot.session.messages[0]!.deliveries.claude!.rationale).toContain(
      'Text chat with @claude remains available',
    );
    expect(snapshot.agents.find((a) => a.id === 'claude')).toMatchObject({
      connection: 'ready',
      pending: { queued: 0, capped: 0, unresolved: 1 },
      initialImageSupport: { available: false, status: 'unsupported' },
    });
    expect(snapshot.agents.find((a) => a.id === 'claude')!.error).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(base64);
    await controller.submit('/participants');
    expect(room.session.notices.at(-1)!.text).toContain('Initial images: unsupported');
    expect(room.session.notices.at(-1)!.text).toContain(
      'no initial-image route is enabled for @claude',
    );
    // The reason survives reopening the saved conversation.
    await controller.close();
    const { room: restored } = setup(config(), saved);
    expect(restored.message('m1')!.deliveries.claude).toEqual(saved.messages[0]!.deliveries.claude);
    await restored.start();
    await tick();
    expect(restored.message('m1')!.deliveries.claude!.status).toBe('failed');
    expect(made.filter((a) => a.inputs.length)).toHaveLength(0);
  } finally {
    web.unmount();
    await controller.close();
  }
});

it('keeps the provider-failure path for a real adapter failure on an image batch', async () => {
  const { room, adapter } = setup();
  await room.start();
  const grok = adapter('grok');
  const image = sendImage(room, '@grok inspect');
  await tick();
  expect(grok.inputs).toHaveLength(1);
  grok.pending!.reject(new Error('Grok stopped: refusal'));
  await tick();
  expect(image.deliveries.grok).toEqual({ status: 'failed', attemptId: expect.any(String) });
  expect(room.session.agents.grok).toMatchObject({
    connection: 'unavailable',
    error: 'Grok stopped: refusal',
  });
  expect(grok.closes).toBe(1);
  expect(room.session.notices.at(-1)!.text).toContain('grok failed: Grok stopped: refusal');
  expect(() => room.retry('m1', 'grok')).toThrow('Reconnect @grok before retrying');
});

// Room permissions, skills and command mode do not change image delivery: the
// adapters' image tuples carry no room policy, so every room configuration,
// including the defaults (skills on, everything else off), is eligible.
it('opens Claude and Codex images in every room configuration, whatever the model or effort', async () => {
  const { claudeImageSupport, codexImageSupport } = await import('../src/image-support.js');
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  const { CodexAdapter } = await import('../src/adapters/codex.js');
  const open = (provider: string) => ({
    provider,
    initial: { available: true, status: 'available' },
    retrieval: { available: true, status: 'available' },
  });
  for (const edits of [false, true])
    for (const commands of [false, true])
      for (const network of [false, true])
        for (const skills of [false, true])
          for (const mode of [undefined, 'trusted'] as const) {
            // Trusted commands exist only with every permission on.
            if (mode && !(edits && commands && network)) continue;
            const cfg: RoomConfig = {
              ...config(),
              permissions: { edits, commands, network },
              skills: { enabled: skills },
              ...(mode
                ? { commandAccess: { mode, source: '--trusted-commands', blockedBy: [] } }
                : {}),
            };
            const room = JSON.stringify({ edits, commands, network, skills, mode });
            const claude = new ClaudeAdapter(agent('claude', 'claude'), cfg).imageTuple;
            expect(
              claudeImageSupport({ ...claude, connected: true, nativeInventoryVerified: true }),
              room,
            ).toEqual(open('claude'));
            // Before the first turn: nothing about the inventory or turn model is known yet.
            expect(claudeImageSupport({ ...claude, connected: true }), room).toEqual(
              open('claude'),
            );
            const codex = new CodexAdapter(agent('codex', 'codex'), cfg).imageEvidence;
            expect(
              codexImageSupport({
                ...codex,
                observedModel: 'gpt-6-astra',
                observedEffort: 'high',
                nativePolicyVerified: true,
              }),
              room,
            ).toEqual(open('codex'));
          }
  const tuple = {
    cliVersion: '2.1.268 (Claude Code)',
    requestedModel: 'opus',
    requestedEffort: 'xhigh',
    observedModel: 'claude-opus-5',
    observedEffort: 'xhigh',
    connected: true,
    nativeInventoryVerified: true,
  };
  // The live build is evidence: an unlisted or unreadable identity decides nothing.
  for (const cliVersion of ['2.1.278 (Claude Code)', '2.1.269 (Claude Code)', ''])
    expect(claudeImageSupport({ ...tuple, cliVersion }), cliVersion).toEqual(open('claude'));
  // #105: so are the requested model and effort and the observed turn model.
  for (const patch of [
    { observedModel: undefined },
    { observedModel: 'claude-fable-5-1' },
    { requestedModel: 'claude-opus-5' },
    { requestedEffort: 'high' },
    { requestedModel: 'sonnet', requestedEffort: 'max', observedModel: 'claude-sonnet-5' },
  ])
    expect(claudeImageSupport({ ...tuple, ...patch }), JSON.stringify(patch)).toEqual(
      open('claude'),
    );
  for (const patch of [{ connected: false }, { nativeInventoryVerified: false }]) {
    const support = claudeImageSupport({ ...tuple, ...patch });
    expect(support.initial.available).toBe(false);
    expect(support.retrieval.available).toBe(false);
  }
});

it('treats unlisted Codex and Claude builds as available through room dispatch and both status views', async () => {
  const { claudeImageSupport, codexImageSupport } = await import('../src/image-support.js');
  // The two CLI identities the managed upgrades produced; neither is catalogued.
  const claudeTuple = {
    cliVersion: '2.1.278 (Claude Code)',
    requestedModel: 'opus',
    requestedEffort: 'xhigh',
    observedModel: 'claude-opus-5' as string | undefined,
    connected: true,
    nativeInventoryVerified: true as boolean | undefined,
  };
  const codexTuple = {
    cliVersion: 'codex-cli 0.155.1',
    requestedModel: 'gpt-6-astra',
    requestedEffort: 'xhigh',
    observedModel: 'gpt-6-astra' as string | undefined,
    observedEffort: 'xhigh' as string | undefined,
    nativePolicyVerified: true as boolean | undefined,
  };
  const assets = join(root, 'assets');
  mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<h1>App</h1>');
  const cfg = {
    ...config(),
    agents: { claude: agent('claude', 'claude'), codex: agent('codex', 'codex') },
  };
  const made: Record<string, Fake> = {};
  let controller!: RoomController;
  controller = new RoomController(cfg, store, undefined, {
    help: '',
    quit: async () => controller.close(),
    createRoom: (roomCfg, persistence, session) =>
      new Room(roomCfg, persistence, session, (definition) => {
        const adapter = Object.assign(new Fake(), {
          imageSupport: () =>
            definition.id === 'claude'
              ? claudeImageSupport(claudeTuple)
              : codexImageSupport(codexTuple),
        });
        made[definition.id] = adapter;
        return adapter;
      }),
  });
  const web = new WebUI(controller, { assets });
  await web.mount();
  try {
    const room = controller.room;
    await room.start();
    // Browser and terminal status both read available, on a build with no entry.
    for (const agentView of web.snapshot().agents)
      expect(agentView, agentView.id).toMatchObject({
        initialImageSupport: { available: true, status: 'available' },
      });
    await controller.submit('/participants');
    const status = room.session.notices.at(-1)!.text;
    expect(status).toContain('Initial images: available');
    expect(status).not.toContain('unsupported');
    expect(status).not.toContain('not observed');

    // The image-bearing message reaches both providers with its caption intact.
    const image = sendImage(room, '@claude @codex look at this');
    await tick();
    for (const id of ['claude', 'codex']) {
      const dispatched = made[id]!.inputs.at(-1)!.messages.find((m) => m.id === image.id)!;
      expect(dispatched, id).toBeDefined();
      expect(dispatched.attachments, id).toHaveLength(1);
      expect(dispatched.text, id).toBe('look at this');
      expect(image.deliveries[id], id).toMatchObject({ status: 'sent' });
      made[id]!.finish();
    }
    await tick();

    // A real unmet requirement still fails the delivery before dispatch, and its
    // reason names the requirement and the live identity rather than a catalog.
    claudeTuple.nativeInventoryVerified = false;
    codexTuple.nativePolicyVerified = false;
    const before = { claude: made.claude!.inputs.length, codex: made.codex!.inputs.length };
    const refused = sendImage(room, '@claude @codex and this one');
    await tick();
    for (const id of ['claude', 'codex']) {
      expect(made[id]!.inputs, id).toHaveLength(before[id as 'claude' | 'codex']);
      const rationale = refused.deliveries[id]!.rationale!;
      expect(refused.deliveries[id], id).toMatchObject({ status: 'failed' });
      expect(rationale, id).toContain('Image not delivered:');
      expect(rationale, id).toContain(
        id === 'claude'
          ? 'the observed native tool inventory failed policy verification'
          : 'the observed native policy checks failed',
      );
      expect(rationale, id).toContain(
        id === 'claude' ? 'live CLI 2.1.278 (Claude Code)' : 'live CLI codex-cli 0.155.1',
      );
      expect(rationale, id).not.toContain('tested build');
    }
    const rows = transcript(projectRoom(room), 200).map((line) => line.text);
    expect(rows.some((text) => text.includes('claude: image in #m2 was not delivered'))).toBe(true);
    expect(JSON.stringify(web.snapshot())).not.toContain(base64);
    for (const agentView of web.snapshot().agents)
      expect(agentView, agentView.id).toMatchObject({
        connection: 'ready',
        initialImageSupport: { available: false, status: 'unsupported' },
      });
  } finally {
    await controller.close();
  }
});

it('adapter contract: legacy initial-image members have no caller authority when absent or present', async () => {
  const { room, adapter } = setup();
  await room.start();
  const claude = adapter('claude');
  const unavailable = {
    available: false,
    status: 'unsupported',
    reason: 'no initial-image route is enabled for @claude (claude adapter) on this baseline',
  };
  expect(room.initialImageSupport('claude')).toEqual(unavailable);
  Object.assign(claude, {
    nativeInitialImages: true,
    initialImageSupport: () => {
      throw new Error('Room must not read legacy capability');
    },
  });
  expect(room.initialImageSupport('claude')).toEqual(unavailable);
  const blocked = sendImage(room, '@claude inspect');
  await tick();
  expect(blocked.deliveries.claude!.status).toBe('failed');
  expect(claude.inputs).toHaveLength(0);
  Object.assign(claude, {
    imageSupport: () => ({
      provider: 'claude',
      initial: { available: true, status: 'available' },
      retrieval: { available: true, status: 'available' },
    }),
  });
  delete (claude as AgentAdapter).nativeInitialImages;
  delete (claude as AgentAdapter).initialImageSupport;
  const delivered = sendImage(room, '@claude inspect now');
  await tick();
  expect(delivered.deliveries.claude!.status).toBe('sent');
  expect(claude.inputs).toHaveLength(1);
  claude.finish();
  await tick();
});
