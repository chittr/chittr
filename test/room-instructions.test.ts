import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Room, newSession } from '../src/room.js';
import { RoomController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import { instructions } from '../src/protocol.js';
import { instructionFileLimit, readInstructionFile } from '../src/instructions.js';
import type {
  AgentAdapter,
  AgentConfig,
  MaintenanceRequest,
  RoomConfig,
  Session,
  TurnInput,
} from '../src/types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'chittr-instructions-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function config(): RoomConfig {
  return {
    workspace: '/workspace',
    permissions: { edits: false, commands: false, network: false },
    followUpTurns: 2,
    sources: [],
    provenance: {},
    instructions: 'Shared guidance',
    agents: Object.fromEntries(
      ['a', 'b'].map((id) => [
        id,
        {
          id,
          provider: 'codex',
          enabled: true,
          instructions: `Role ${id}`,
          fingerprint: `base-${id}`,
        },
      ]),
    ),
  };
}
class Peer implements AgentAdapter {
  starts: (string | undefined)[] = [];
  inputs: TurnInput[] = [];
  maintenance: MaintenanceRequest[] = [];
  nativeCompaction = false;
  restored = false;
  sessionId = randomUUID();
  async start(id?: string) {
    this.starts.push(id);
    return {
      sessionId: this.restored ? this.sessionId : (id ?? this.sessionId),
      restored: this.restored,
    };
  }
  async run(input: TurnInput) {
    this.inputs.push(input);
    return {
      outcomes: input.messages.map((m) => ({
        kind: 'pass' as const,
        messageIds: [m.id],
        text: 'Done',
        recipients: [],
      })),
    };
  }
  async maintain(request: MaintenanceRequest) {
    this.maintenance.push(request);
    if (request.kind === 'seed') return { text: 'seed accepted', sessionId: this.sessionId };
    const { previousEntries, messages } = JSON.parse(request.prompt);
    return {
      text: JSON.stringify({
        entries: [
          ...previousEntries,
          ...messages.map((m: { text: string; id: string; author: string }) => ({
            category: 'objective',
            text: m.text,
            sources: [{ messageId: m.id, author: m.author }],
          })),
        ],
      }),
    };
  }
  async interrupt() {}
  async close() {}
}
function factory() {
  const calls: { agent: AgentConfig; prompt: string; peer: Peer }[] = [];
  return {
    calls,
    create(agent: AgentConfig, roomConfig: RoomConfig) {
      const peer = new Peer();
      calls.push({ agent, prompt: instructions(agent, roomConfig), peer });
      return peer;
    },
  };
}
async function idle(room: Room) {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.waitFor(() => expect(room.isIdle()).toBe(true));
}

it('reads launch paths once and round-trips a full 1 MiB brief after its source disappears', () => {
  const root = directory();
  const home = join(root, 'home');
  mkdirSync(home);
  const text = 'é'.repeat(instructionFileLimit / 2);
  const file = join(home, ' brief.md ');
  writeFileSync(file, text);
  const brief = readInstructionFile('home/ brief.md ', root, home);
  expect(brief).toEqual({ source: file, text });
  expect(readInstructionFile(file, root, home)).toEqual(brief);
  expect(readInstructionFile('~/ brief.md ', root, home)).toEqual(brief);
  const store = new SessionStore('/workspace', join(root, 'state'));
  store.acquire();
  cleanup.push(() => store.release());
  const session = newSession(config());
  session.launchBrief = brief;
  store.save(session);
  writeFileSync(file, 'Changed file');
  expect(store.load(session.id)!.launchBrief).toEqual(brief);
  rmSync(file);
  expect(store.load(session.id)!.launchBrief).toEqual(brief);
  expect(() => readInstructionFile(file, root)).toThrow();
  expect(() => readInstructionFile(home, root)).toThrow();
  writeFileSync(file, text + 'x');
  expect(() => readInstructionFile(file, root)).toThrow('exceeds 1 MiB');
});

it.each([
  null,
  {},
  { text: 42, source: '/brief.md' },
  { text: 'text', source: '' },
  { text: 'text', source: 42 },
  { text: 'text', source: '/brief', extra: true },
  { text: 'x'.repeat(instructionFileLimit + 1), source: '/brief' },
])('refuses malformed saved briefs without rewriting core or latest data: case %#', (brief) => {
  const store = new SessionStore('/workspace', directory());
  store.acquire();
  cleanup.push(() => store.release());
  const session = newSession(config());
  store.save(session);
  const path = join(store.directory, session.id, 'session.json');
  const latest = join(store.directory, 'latest.json');
  const originalLatest = readFileSync(latest, 'utf8');
  const raw = JSON.stringify({ ...session, launchBrief: brief });
  writeFileSync(path, raw);
  expect(() => store.load(session.id)).toThrow('invalid or unsupported');
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(readFileSync(latest, 'utf8')).toBe(originalLatest);
});

it('saves the brief before any adapter is constructed, and a failed save prevents all provider work', async () => {
  for (const fail of [false, true]) {
    const order: string[] = [];
    const peers = factory();
    const room = new Room(
      config(),
      {
        save(session) {
          expect(session.launchBrief?.text).toBe('Saved brief');
          order.push('save');
          if (fail) throw new Error('disk full');
        },
      },
      undefined,
      (agent, conf) => {
        expect(order[0]).toBe('save');
        order.push('factory');
        return peers.create(agent, conf);
      },
    );
    cleanup.push(() => room.close());
    room.session.launchBrief = { text: 'Saved brief', source: '/brief.md' };
    await room.start();
    if (fail) {
      expect(peers.calls).toHaveLength(0);
      expect(room.fatal).toContain('disk full');
      expect(room.session.paused).toBe(true);
      expect(() => room.send('Work')).toThrow('disk full');
    } else {
      expect(peers.calls).toHaveLength(2);
      for (const call of peers.calls) {
        expect(call.peer.starts).toEqual([undefined]);
        expect(call.prompt).toContain('Saved conversation brief:\nSaved brief');
        expect(call.prompt).toContain('YAML room instructions:\nShared guidance');
        expect(call.prompt).toContain(`Agent instructions:\nRole ${call.agent.id}`);
        expect(call.prompt).toContain('takes precedence');
        expect(call.prompt).toContain('Room protocol, required');
        expect(call.prompt).toContain('"edits":false,"commands":false,"network":false');
      }
      expect(room.session.messages).toEqual([]);
    }
  }
});

it('resumes with saved guidance, resets changed shared identities, and isolates agent-only reloads', async () => {
  const base = config();
  const peers = factory();
  const room = new Room(base, { save() {} }, undefined, peers.create);
  cleanup.push(() => room.close());
  room.session.launchBrief = { text: 'Frozen brief', source: '/gone.md' };
  await room.start();
  const initial = structuredClone(room.session);
  await room.reload(structuredClone(base));
  expect(peers.calls).toHaveLength(2);
  const next = structuredClone(base);
  next.instructions = 'New shared guidance';
  await room.reload(next);
  expect(peers.calls).toHaveLength(4);
  for (const call of peers.calls.slice(2)) {
    expect(call.peer.starts).toEqual([undefined]);
    expect(call.prompt).toContain('New shared guidance');
    expect(call.prompt).toContain('Frozen brief');
  }
  const one = structuredClone(next);
  one.agents.a!.instructions = 'Different role';
  one.agents.a!.fingerprint = 'different-role';
  await room.reload(one);
  expect(peers.calls).toHaveLength(5);
  expect(peers.calls.at(-1)!.agent.id).toBe('a');
  await room.reconnect('a');
  expect(peers.calls.at(-1)!.peer.starts).toEqual([room.session.agents.a!.sessionId]);
  const more = structuredClone(one);
  more.agents.c = { ...more.agents.b!, id: 'c', enabled: false };
  await room.reload(more);
  expect(peers.calls).toHaveLength(6);
  const enabled = structuredClone(more);
  enabled.agents.c!.enabled = true;
  enabled.agents.d = { ...enabled.agents.b!, id: 'd' };
  await room.reload(enabled);
  expect(peers.calls.slice(-2).map((call) => call.agent.id)).toEqual(['c', 'd']);
  expect(peers.calls.slice(-2).every((call) => call.prompt.includes('Frozen brief'))).toBe(true);
  expect(base.agents.a!.conversationInstructions).toBeUndefined();

  for (const conf of [base, next]) {
    const resumedPeers = factory();
    const resumed = new Room(conf, { save() {} }, initial, resumedPeers.create);
    cleanup.push(() => resumed.close());
    await resumed.start();
    for (const call of resumedPeers.calls) {
      expect(call.prompt).toContain('Frozen brief');
      expect(call.peer.starts).toEqual([
        conf === base ? initial.agents[call.agent.id]!.sessionId : undefined,
      ]);
    }
  }
});

it.each([undefined, ''])(
  'retains baseline native identity when effective shared content is empty: %s',
  async (shared) => {
    const conf = config();
    conf.instructions = shared;
    conf.provenance.instructions = '/explicit-clear.yaml';
    const session = newSession(conf);
    session.launchBrief = { text: '', source: '/empty.md' };
    for (const agent of Object.values(conf.agents))
      session.agents[agent.id] = {
        id: agent.id,
        connection: 'ready',
        activity: 'available',
        paused: false,
        fingerprint: agent.fingerprint,
        sessionId: `legacy-${agent.id}`,
        contextThrough: 0,
        draft: '',
      };
    const peers = factory();
    const room = new Room(conf, { save() {} }, session, peers.create);
    cleanup.push(() => room.close());
    await room.start();
    for (const call of peers.calls) {
      expect(call.agent.fingerprint).toBe(conf.agents[call.agent.id]!.fingerprint);
      expect(call.peer.starts).toEqual([`legacy-${call.agent.id}`]);
      expect(call.prompt).not.toContain('Saved conversation brief:');
    }
  },
);

it('keeps the effective instructions and fingerprint through compaction and recovery adapters', async () => {
  const conf = config();
  conf.agents.b!.enabled = false;
  const peers = factory();
  const room = new Room(conf, { save() {} }, undefined, peers.create);
  cleanup.push(() => room.close());
  room.session.launchBrief = { text: 'Brief through maintenance', source: '/brief.md' };
  await room.start();
  room.send('Public objective');
  await idle(room);
  room.compact('a');
  await idle(room);
  expect(room.session.agents.a!.maintenance?.status).toBe('completed');
  expect(peers.calls).toHaveLength(3); // normal, isolated summarizer, replacement
  for (const call of peers.calls) {
    expect(call.prompt).toBe(peers.calls[0]!.prompt);
    expect(call.agent.fingerprint).toBe(room.session.agents.a!.fingerprint);
  }
  expect(peers.calls[1]!.peer.maintenance[0]!.kind).toBe('checkpoint');
  expect(peers.calls[2]!.peer.maintenance[0]!.kind).toBe('seed');
  const saved = structuredClone(room.session);
  const recoveredPeers = factory();
  const recovered = new Room(conf, { save() {} }, saved, (agent, cfg) => {
    const peer = recoveredPeers.create(agent, cfg);
    peer.restored = true;
    return peer;
  });
  cleanup.push(() => recovered.close());
  await recovered.start();
  expect(recovered.session.agents.a!.maintenance?.status).toBe('completed');
  expect(recoveredPeers.calls[0]!.peer.maintenance.some((input) => input.kind === 'seed')).toBe(
    true,
  );
  expect(recoveredPeers.calls[0]!.prompt).toBe(peers.calls[0]!.prompt);
  expect(recoveredPeers.calls[0]!.agent.fingerprint).toBe(saved.agents.a!.fingerprint);
});

it.each([false, true])(
  'isolates controller briefs across /new, /sessions and reload with config loader=%s',
  async (loader) => {
    const store = new SessionStore('/workspace', directory());
    store.acquire();
    cleanup.push(() => store.release());
    const conf = config();
    const saved = ['First brief', 'Second brief', undefined].map((text) => {
      const session = newSession(conf);
      if (text) session.launchBrief = { text, source: `/${text}.md` };
      store.save(session);
      return session;
    });
    const peers = factory();
    const controller = new RoomController(conf, store, saved[0], {
      help: '',
      quit: async () => {},
      ...(loader ? { loadConfig: () => structuredClone(conf) } : {}),
      createRoom: (cfg, persistence, session) => new Room(cfg, persistence, session, peers.create),
    });
    cleanup.push(() => controller.close());
    await controller.room.start();
    for (const destination of saved) {
      await controller.submit(`/sessions ${destination.id}`);
      expect(controller.room.session.launchBrief).toEqual(destination.launchBrief);
      const summary = controller.configSummary();
      expect(summary.instructions.launchBrief).toEqual(
        destination.launchBrief ? { source: destination.launchBrief.source, saved: true } : null,
      );
      for (const call of peers.calls.slice(-2)) {
        if (destination.launchBrief) expect(call.prompt).toContain(destination.launchBrief.text);
        for (const other of saved.filter((item) => item.id !== destination.id))
          if (other.launchBrief) expect(call.prompt).not.toContain(other.launchBrief.text);
      }
      await controller.submit('/reload');
      expect(controller.room.session.launchBrief).toEqual(destination.launchBrief);
      await controller.submit('/new');
      expect(controller.room.session.launchBrief).toBeUndefined();
      expect(controller.configSummary().instructions.launchBrief).toBeNull();
      expect(
        peers.calls
          .slice(-2)
          .every(
            (call) => !call.prompt.includes('First brief') && !call.prompt.includes('Second brief'),
          ),
      ).toBe(true);
    }
    conf.instructions = '';
    conf.provenance.instructions = '/project/.agents/chittr.yaml';
    await controller.submit('/reload');
    expect(controller.configSummary().instructions.room).toEqual({
      source: '/project/.agents/chittr.yaml',
      empty: true,
    });
  },
);
