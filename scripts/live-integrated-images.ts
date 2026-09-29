import {
  liveImageDriver,
  liveImageRoster,
  liveSourceIdentity,
  observeRoster,
  type LiveImageDriver,
  type LiveImageSelection,
} from './live-image-selection.js';
import { regionFixture, regionQuestion, textHasAnyAnswer } from './integrated-image-oracle.js';
import { unsupportedRecipientPassed } from './integrated-outcomes.js';
import { postBrowserCommand } from './browser-command.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { createAdapter } from '../src/adapters/index.js';
import { RoomController } from '../src/controller.js';
import { Room } from '../src/room.js';
import { SessionStore } from '../src/store.js';
import { WebUI } from '../src/web.js';
import { turnPrompt } from '../src/protocol.js';
import type { AgentAdapter, RoomConfig, Session } from '../src/types.js';

// Issue #57 mixed-recipient acceptance through the real browser entry point. One
// pasted PNG is sent to Codex, Claude, Grok and Antigravity in a single message.
// Each supported recipient's outcome is proved on its own: its private region
// assertion, and a native initial request in its own provider session carrying
// that send's content hash and message/attachment association. A passing
// recipient never stands in for another. Antigravity is the unsupported
// recipient: visible before send, failed closed, never dispatched, still chatting.
// The host, storage, web server, adapters and MCP processes are all real. Only the
// fixture and the region answers live in this process; none of them is retained.
const roster = liveImageRoster();
const source = liveSourceIdentity();
assert.equal(
  source.untracked,
  false,
  'Stage new source files before running to pin the full patch',
);
for (const key of Object.keys(process.env))
  if (/PROBE|ORACLE|FIXTURE/i.test(key)) delete process.env[key];
const root = realpathSync(mkdtempSync(join(roster.scratchParent, 'chittr-integrated-live-')));
const workspace = join(root, 'workspace');
mkdirSync(workspace);

const supported = roster.supported.map((entry) => entry.id);
const unsupported = roster.unsupported.id;
const everyone = [...supported, unsupported];
const fixture = regionFixture(supported);
const base64 = fixture.png.toString('base64');
const question = regionQuestion(fixture.regions, fixture.panelCount);
assert.ok(!textHasAnyAnswer(question, fixture.regions), 'The public question leaks an answer');

const drivers = new Map<string, LiveImageDriver>(
  supported.map((id) => [id, liveImageDriver({ adapter: id } as LiveImageSelection)]),
);
const nativeEvents: any[] = [];
let phase = 'startup';
let step = 'startup';
const restoreObservers = observeRoster(root, supported, () => phase, nativeEvents);

const config: RoomConfig = {
  workspace,
  humanName: 'Bill',
  permissions: roster.permissions,
  skills: roster.skills,
  commandAccess: roster.commandAccess,
  followUpTurns: 1,
  agents: Object.fromEntries(
    [...roster.supported, roster.unsupported].map((entry) => [
      entry.id,
      {
        id: entry.id,
        provider: entry.id,
        model: 'model' in entry ? entry.model : undefined,
        effort: 'effort' in entry ? entry.effort : undefined,
        enabled: true,
        instructions:
          'Address every reply to human only and never to another agent. For a visual assertion, put only the comma-separated lowercase color names of your own assigned panels in the outcome text, no spaces or explanation.',
        fingerprint: 'integrated-live',
      },
    ]),
  ),
  sources: [],
  provenance: {},
};
const store = new SessionStore(workspace, join(root, 'state'));
store.acquire();
const adapters = new Map<string, AgentAdapter>();
const providerSessions: object[] = [];
const dispatches: {
  agent: string;
  phase: string;
  messageIds: string[];
  carriedAttachments: boolean;
  promptHadOwnAnswer: boolean;
  promptHadPeerAnswer: boolean;
}[] = [];
function makeRoom(c: RoomConfig, s: SessionStore, session?: Session) {
  return new Room(c, s, session, (agent, cfg, env, access) => {
    const driver = drivers.get(agent.id);
    // Antigravity has no live driver by design: it is built by the ordinary
    // product factory and judged only by the product's own support gate.
    const adapter = driver
      ? driver.create(agent, cfg, env, access)
      : createAdapter(agent, cfg, env, access);
    adapters.set(agent.id, adapter);
    const start = adapter.start.bind(adapter);
    adapter.start = async (previousSession) => {
      const result = await start(previousSession);
      providerSessions.push({
        agent: agent.id,
        phase,
        sessionId: result.sessionId,
        restored: result.restored,
        support: adapter.imageSupport?.(),
        tuple: driver?.tuple(adapter),
        policy: driver?.policy(adapter, cfg),
      });
      return result;
    };
    const run = adapter.run.bind(adapter);
    adapter.run = async (input, event, signal) => {
      const prompt = turnPrompt(input);
      const own = fixture.regions[agent.id]?.answer;
      dispatches.push({
        agent: agent.id,
        phase,
        messageIds: input.messages.map((message) => message.id),
        carriedAttachments: input.messages.some((message) => message.attachments?.length),
        promptHadOwnAnswer: own ? prompt.includes(own) : false,
        promptHadPeerAnswer: Object.entries(fixture.regions).some(
          ([peer, region]) => peer !== agent.id && prompt.includes(region.answer),
        ),
      });
      // Observation only: throwing here would surface in the room as an adapter failure.
      // The isolation rule is asserted after the run, on the turn that carried the image.
      return run(input, event, signal);
    };
    return adapter;
  });
}
const controller: RoomController = new RoomController(config, store, undefined, {
  help: '',
  quit: async () => {},
  createRoom: makeRoom,
});
const agentState = (id: string) => controller.room.session.agents[id];
// Settles one human message. Agent replies go to the whole room, and once a message's
// follow-up allowance is spent the remaining agent-to-agent deliveries stay queued by
// design, so an empty queue is the wrong test. The message is settled when no scheduled
// recipient still owes it a turn and the room has stayed idle long enough that no
// follow-up dispatch is about to start and bleed into the next phase.
async function idle(messageId: string) {
  step = 'providers idle';
  const end = Date.now() + 480000;
  let quietSince = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    // Only a supported recipient going away aborts the run. Antigravity's state
    // is recorded as observed rather than assumed.
    const bad = supported.map(agentState).find((x) => x?.connection === 'unavailable' || x?.error);
    if (bad) throw new Error(`${bad.id}: ${bad.error}`);
    // A recipient that never connected is never scheduled, so it owes nothing.
    const scheduled = everyone.filter(
      (id) => id !== unsupported || agentState(id)?.connection === 'ready',
    );
    const message = controller.room.session.messages.find((x) => x.id === messageId);
    const owed = scheduled.some((id) =>
      ['queued', 'sent', 'received'].includes(message?.deliveries[id]?.status ?? ''),
    );
    if (!controller.room.isIdle() || owed) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince >= 2000) return;
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
const browserEvents: object[] = [];
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
  await waitFor(() => controller.room.session.messages.length > before, 'message accepted');
  return controller.room.session.messages[before]!;
}
// The first reply after the mark answers the question; a later follow-up does not.
const firstReply = (id: string, after: number) =>
  controller.room.session.messages.slice(after).find((message) => message.author === id);
const addressed = everyone.map((id) => `@${id}`).join(' ');

const evidence: any = {
  issue: 57,
  scenario: 'mixed-recipient first image',
  entryPoint: 'browser',
  startedAt: new Date().toISOString(),
  source,
  room: roster.room,
  requestedPolicy: {
    permissions: roster.permissions,
    skillsEnabled: roster.skills.enabled,
    commandMode: roster.commandAccess.mode,
    commandModeSource: roster.commandAccess.source,
  },
  requested: Object.fromEntries(
    roster.supported.map((entry) => [
      entry.id,
      { model: entry.model ?? 'provider default', effort: entry.effort ?? 'provider default' },
    ]),
  ),
  fixture: {
    sha256: fixture.sha256,
    byteSize: fixture.byteSize,
    width: fixture.width,
    height: fixture.height,
    panelCount: fixture.panelCount,
  },
  recipients: {},
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
    if (new URL(request.url()).pathname !== '/api/command') return;
    const body = request.postDataJSON?.() ?? {};
    browserEvents.push({
      phase,
      boundary: 'browser-command-request',
      // Recipients and command words only; the question text is not retained.
      line:
        typeof body.line === 'string'
          ? body.line
              .split(' ')
              .filter((word: string) => /^[@/#]/.test(word))
              .join(' ')
          : undefined,
      attachmentIds: body.attachmentIds,
      commandId: typeof body.id === 'string' ? body.id : undefined,
    });
  });
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname !== '/api/attachments') return;
    if (response.request().method() !== 'POST') return;
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
      attachmentId: attachment?.id,
      byteSize: attachment?.byteSize,
      width: attachment?.width,
      height: attachment?.height,
      responseContainsBase64: text.includes(base64),
    });
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'New conversation', exact: false }).waitFor();
  await waitFor(
    () => supported.every((id) => agentState(id)?.connection === 'ready'),
    'supported recipients ready',
    180000,
  );
  await waitFor(
    () => ['ready', 'unavailable'].includes(agentState(unsupported)?.connection ?? ''),
    'unsupported recipient settled',
    180000,
  );
  evidence.unsupportedConnectionAtStart = agentState(unsupported)?.connection;

  // Text warm-up for everyone. Claude only reports image support after a real
  // text turn has established its model, and this is Antigravity's text baseline.
  phase = 'warmup';
  let mark = controller.room.session.messages.length;
  const warmup = await send(
    page,
    `${addressed} Reply to human with ready. This is a text-only check.`,
  );
  await idle(warmup.id);
  for (const id of supported) assert.ok(firstReply(id, mark), `@${id} did not answer the warm-up`);
  const unsupportedTextBefore = Boolean(firstReply(unsupported, mark));

  phase = 'initial';
  for (const id of supported) {
    const support = adapters.get(id)?.imageSupport?.();
    assert.ok(support?.initial.available, `@${id}: ${(support?.initial as any)?.reason}`);
  }
  const refusal = controller.room.initialImageSupport(unsupported);
  assert.ok(refusal && !refusal.available, 'Antigravity unexpectedly reports image support');

  // Stage through the real paste path, type the draft, and read the #68 status
  // the page shows before anything is sent.
  await page.evaluate(
    ({ bytes }) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(bytes)], 'panels.png', { type: 'image/png' }));
      document
        .querySelector('textarea[aria-label="Message"]')!
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
    },
    { bytes: [...fixture.png] },
  );
  await page.locator('.draft-images img').first().waitFor({ timeout: 30000 });
  const line = `${addressed} ${question}`;
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(line);
  const warning = page.locator('.image-status-warning');
  await warning.waitFor({ timeout: 15000 });
  const warned = await warning.locator('li').allInnerTexts();
  // 'Unsupported' when the connected adapter refuses images; 'Not observed' when the
  // recipient never connected, so the product could not reach that refusal at all.
  const shownStatus = (await warning.locator('span').allInnerTexts()).join(',');
  const messagesBeforeSend = controller.room.session.messages.length;
  assert.deepEqual(
    warned.map((item) => item.split(':')[0]),
    [`@${unsupported}`],
    'Only the unsupported recipient may be flagged before send',
  );
  assert.ok(warned[0]!.includes(refusal.reason), 'The shown status is not the live gate reason');

  mark = controller.room.session.messages.length;
  assert.equal(mark, messagesBeforeSend, 'The status must be shown before the send');
  const activitiesBeforeSend = (controller.room.session.activities ?? []).filter(
    (x) => x.agent === unsupported,
  ).length;
  const sent = await send(page, line);
  // The room may replace its session object; always re-resolve by identity.
  const current = () => controller.room.session.messages.find((x) => x.id === sent.id)!;
  const message = current();
  assert.equal(message.attachments?.length, 1);
  assert.ok(message.attachmentOperation, 'Browser send carried no attachment operation');
  await idle(sent.id);
  const attachment = message.attachments![0]!;
  const association = `Chittr image for message #${message.id}, attachment ${attachment.id}.`;

  for (const id of supported) {
    const sessionId = agentState(id)?.sessionId;
    const reply = firstReply(id, mark);
    const visualPassed = reply?.text === fixture.regions[id]!.answer;
    // Bound by provider session and content hash, not by the observer's tag.
    const requests = nativeEvents.filter(
      (event) =>
        event.phase === 'initial' &&
        event.boundary === 'initial-native-request' &&
        event.sessionId === sessionId &&
        event.images?.some((image: any) => image.sha256 === fixture.sha256),
    );
    const native = requests[0];
    const nativePassed =
      requests.length === 1 &&
      native.images.length === 1 &&
      JSON.stringify(native.associations) === JSON.stringify([association]);
    evidence.recipients[id] = {
      visualPassed,
      nativePassed,
      passed: visualPassed && nativePassed,
      roomSessionId: controller.room.session.id,
      providerSessionId: sessionId,
      messageId: message.id,
      attachmentId: attachment.id,
      attachmentOperationId: message.attachmentOperation.id,
      nativeRequestId: native?.requestId,
      nativeRequestCount: requests.length,
      delivery: current().deliveries[id]?.status,
      replyMessageId: reply?.id,
      support: adapters.get(id)?.imageSupport?.(),
      tuple: drivers.get(id)!.tuple(adapters.get(id)),
      policy: drivers.get(id)!.policy(adapters.get(id), config),
    };
  }

  // The unsupported recipient. dispatch() stamps an attemptId on every delivery it
  // sends and charges in that same step, so a refusal before dispatch or charge shows
  // as an image delivery that never carries one and no adapter run holding the image
  // message, after the send and again after the retry.
  const failed = current().deliveries[unsupported];
  const imageDispatches = () =>
    dispatches.filter(
      (entry) => entry.agent === unsupported && entry.messageIds.includes(message.id),
    ).length;
  const unsupportedActivities = () =>
    (controller.room.session.activities ?? []).filter((x) => x.agent === unsupported).length;
  const unsupportedReady = agentState(unsupported)?.connection === 'ready';
  const unsupportedEvidence: any = {
    agent: unsupported,
    statusShownBeforeSend: true,
    shownStatus,
    shownStatusMatchesGate: true,
    gate: refusal,
    // A recipient that cannot connect is a host blocker, recorded and never worked around.
    blocker: unsupportedReady ? null : (agentState(unsupported)?.error ?? 'recipient unavailable'),
    deliveryStatus: failed?.status,
    rationaleIsImageRefusal: Boolean(failed?.rationale?.startsWith('Image not delivered: ')),
    rationaleNamesGateReason: Boolean(failed?.rationale?.includes(refusal.reason)),
    noticeRecorded: controller.room.session.notices.some(
      (notice) => notice.text.includes(`#${message.id}`) && notice.text.includes(unsupported),
    ),
    attemptIdAfterSend: failed?.attemptId ?? null,
    // Context only. This counter is shared with the other recipients' follow-ups, so
    // it says nothing about this recipient and is not part of the pass rule.
    sharedRootExchangeUsedAfterSend: controller.room.session.exchanges[message.id]?.used,
    connectionAfterRefusal: agentState(unsupported)?.connection,
    textBeforeRefusal: unsupportedTextBefore,
  };

  // Explicit retry re-evaluates the live gate and is refused again the same way. Only a
  // refused delivery can be retried; a never-scheduled one stays queued and is left alone.
  phase = 'retry';
  if (failed?.status === 'failed') {
    await post(page, `/retry #${message.id} @${unsupported}`, 60000);
    await idle(sent.id);
  }
  const retried = current().deliveries[unsupported];
  unsupportedEvidence.attemptIdAfterRetry = retried?.attemptId ?? null;
  unsupportedEvidence.imageMessageDispatches = imageDispatches();
  // Context only: a connected recipient may handle peers' text follow-ups meanwhile.
  unsupportedEvidence.recipientActivitiesInWindow = unsupportedActivities() - activitiesBeforeSend;
  unsupportedEvidence.sharedRootExchangeUsedAfterRetry =
    controller.room.session.exchanges[message.id]?.used;
  unsupportedEvidence.retryRefusedAgain =
    failed?.status === 'failed' &&
    retried?.status === 'failed' &&
    Boolean(retried.rationale?.includes(refusal.reason));

  // Ordinary text to that recipient still works alongside the others.
  phase = 'text-continues';
  mark = controller.room.session.messages.length;
  if (unsupportedReady) {
    const text = await send(
      page,
      `@${unsupported} Reply to human with the single word continuing.`,
    );
    await idle(text.id);
  }
  unsupportedEvidence.textAfterRefusal = Boolean(firstReply(unsupported, mark));
  unsupportedEvidence.passed =
    unsupportedRecipientPassed(unsupportedEvidence) && unsupportedEvidence.rationaleNamesGateReason;
  evidence.unsupported = unsupportedEvidence;

  const state = await (await page.request.get(new URL('/api/state', url).toString())).text();
  evidence.oracleIsolation = {
    rule: 'disjoint panel regions with pairwise distinct answers; whole-field exact equality',
    answersPairwiseDistinct: true,
    // A recipient may never be handed its own expected answer on the turn that carries
    // the image. Once it has replied, that reply is public and may appear in follow-ups.
    ownAnswerInImageTurnPrompt: dispatches.some(
      (entry) => entry.carriedAttachments && entry.promptHadOwnAnswer,
    ),
    // Recorded, not asserted: a peer reply cannot satisfy this recipient's region.
    peerAnswerSeenByAnyPrompt: dispatches.some((entry) => entry.promptHadPeerAnswer),
    answersRetained: false,
    privateFixtureOutsideTaskFiles: true,
  };
  evidence.serialization = {
    sessionContainsBase64: JSON.stringify(controller.room.session).includes(base64),
    browserStateContainsBase64: state.includes(base64),
    uploadResponseEchoedBase64: browserEvents.some((x: any) => x.responseContainsBase64 === true),
  };
  evidence.dispatches = dispatches;
  evidence.providerSessions = providerSessions;
  evidence.nativeEvents = nativeEvents;
  evidence.browserEvents = browserEvents;
  evidence.endedAt = new Date().toISOString();
  // Supported recipients stand on their own; an unproved unsupported path is named as such.
  evidence.status = !supported.every((id) => evidence.recipients[id].passed)
    ? 'failed'
    : unsupportedEvidence.passed
      ? 'passed'
      : 'supported-recipients-passed-unsupported-path-unproved';
  // Computed scans over the record about to be retained, not declarations.
  const retained = JSON.stringify(evidence);
  assert.ok(!textHasAnyAnswer(retained, fixture.regions), 'Evidence would retain an answer');
  assert.ok(!retained.includes(base64.slice(0, 64)), 'Evidence would retain image bytes');
  assert.ok(!retained.includes(root), 'Evidence would retain a private path');
  assert.deepEqual(Object.values(evidence.serialization), [false, false, false]);
  assert.equal(evidence.oracleIsolation.ownAnswerInImageTurnPrompt, false);
  writeFileSync(
    join(root, evidence.status === 'passed' ? 'evidence.json' : 'partial-evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  if (evidence.status !== 'passed') {
    // Each recipient's outcome stands alone; the run is only as good as its worst.
    process.exitCode = 1;
    console.error(`BLOCKED: mixed-recipient acceptance did not pass for every recipient: ${root}`);
  } else console.log(`PASS mixed-recipient image acceptance. Evidence: ${root}/evidence.json`);
} catch (error) {
  console.error('BLOCKED: live image verification did not complete; inspect sanitized evidence');
  const partial = {
    ...evidence,
    status: 'failed',
    phase,
    step,
    failureType: error instanceof Error ? error.name : 'unknown',
    dispatches,
    providerSessions,
    nativeEvents,
    browserEvents,
  };
  const text = JSON.stringify(partial, null, 2);
  // A failed run is retained only if it is as clean as a passing one.
  if (!textHasAnyAnswer(text, fixture.regions) && !text.includes(base64.slice(0, 64)))
    writeFileSync(join(root, 'partial-evidence.json'), text.replaceAll(root, '<scratch>'));
  console.error(`Preserved sanitized boundary evidence: ${root}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await controller.close().catch(() => {});
  web.unmount();
  store.release();
  restoreObservers();
}
