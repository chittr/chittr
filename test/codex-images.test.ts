import { expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AttachmentStore, attachmentLimits } from '../src/attachments.js';
import { AttachmentResult } from '../src/attachment-result.js';
import { assertCodexFrame, codexInitialContent, codexSessionPolicy } from '../src/codex-images.js';
import { tinyPng, paddedPng } from './image-fixture.js';
import type { Message } from '../src/types.js';
import { JsonLinesProcess } from '../src/process.js';
import { codexImageSupport, registeredImageMapping } from '../src/image-support.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(count = 1, bytes = tinyPng()) {
  const dir = mkdtempSync('/private/tmp/codex-images-test-');
  dirs.push(dir);
  const store = new AttachmentStore(dir),
    sessionId = randomUUID();
  const attachments = Array.from({ length: count }, () =>
    store.stage({
      sessionId,
      operationId: randomUUID(),
      filename: 'image.png',
      mediaType: 'image/png',
      bytes,
    }),
  );
  const message: Message = {
    id: 'm1',
    sequence: 1,
    author: 'human',
    recipients: ['codex'],
    replyTo: [],
    roots: [],
    text: 'Describe',
    createdAt: new Date().toISOString(),
    deliveries: {},
    attachments,
  };
  return { access: store.access(sessionId), message, attachments };
}
it('serializes only supplied delivery messages, in message and attachment order', () => {
  const { access, message, attachments } = fixture(3);
  const blocks = codexInitialContent(
    [
      { ...message, attachments: attachments.slice(0, 2) },
      { ...message, id: 'm2', attachments: attachments.slice(2) },
    ],
    access,
  );
  expect(blocks.filter((x) => x.type === 'text').map((x) => x.text)).toEqual([
    `Chittr image for message #m1, attachment ${attachments[0]!.id}.`,
    `Chittr image for message #m1, attachment ${attachments[1]!.id}.`,
    `Chittr image for message #m2, attachment ${attachments[2]!.id}.`,
  ]);
  expect(blocks.filter((x) => x.type === 'image')).toEqual(
    attachments.map(() => ({
      type: 'image',
      url: `data:image/png;base64,${tinyPng().toString('base64')}`,
    })),
  );
  expect(codexInitialContent([{ ...message, attachments: undefined }], access)).toEqual([]);
});
it('rejects absent resolvers, changed metadata, PNG bytes and hashes before encoding', () => {
  const { access, message } = fixture();
  expect(() => codexInitialContent([message])).toThrow('resolver');
  const image = access.resolve(message.attachments![0]!.id);
  for (const corrupted of [
    { ...image, sha256: '0'.repeat(64) },
    { ...image, bytes: Buffer.from('invalid') },
    { ...image, metadata: { ...image.metadata, width: 99 } },
  ])
    expect(() => codexInitialContent([message], { ...access, resolve: () => corrupted })).toThrow();
});
it('enforces message count and batch aggregate limits independently', () => {
  const f = fixture(5);
  expect(() => codexInitialContent([f.message], f.access)).toThrow('four images');
  const large = fixture(4, paddedPng(attachmentLimits.perImageBytes));
  expect(() =>
    codexInitialContent(
      large.attachments.map((a, i) => ({ ...large.message, id: `m${i}`, attachments: [a] })),
      large.access,
    ),
  ).toThrow('aggregate');
});

it('bounds full requests, responses and escaped multibyte replay envelopes', () => {
  const f = fixture(3, paddedPng(attachmentLimits.perImageBytes));
  const request = {
    id: 1,
    method: 'turn/start',
    params: {
      threadId: randomUUID(),
      input: [
        { type: 'text', text: '界'.repeat(20000) },
        ...codexInitialContent([f.message], f.access),
      ],
    },
  };
  expect(() => assertCodexFrame(JSON.stringify(request))).not.toThrow();
  expect(attachmentLimits.nativeFrameCharacters).toBe(8 * 1024 * 1024);
  for (const text of [
    'x'.repeat(8 * 1024 * 1024),
    '界'.repeat(3 * 1024 * 1024),
    '"'.repeat(3 * 1024 * 1024),
  ]) {
    expect(() => assertCodexFrame(JSON.stringify({ id: text, result: {} }))).toThrow(
      'transport limit',
    );
  }
});

it('dispatches native image results and byte-free association through final serialization', () => {
  const f = fixture();
  const result = new AttachmentResult(
    f.message.id,
    f.access.resolve(f.attachments[0]!.id),
    () => {},
    'codex-dynamic-image',
  );
  const writes: string[] = [];
  const wire = {
    closed: false,
    child: { stdin: { write: (value: string) => writes.push(value) } },
  };
  result.dispatchCodex(123, (response, validate) =>
    JsonLinesProcess.prototype.send.call(wire as any, response, validate),
  );
  const response = JSON.parse(writes[0]!);
  expect(response).toMatchObject({
    id: 123,
    result: {
      success: true,
      contentItems: [
        { type: 'inputText' },
        { type: 'inputImage', imageUrl: `data:image/png;base64,${tinyPng().toString('base64')}` },
      ],
    },
  });
  expect(JSON.parse(response.result.contentItems[0].text)).toMatchObject({
    messageId: 'm1',
    attachment: { id: f.attachments[0]!.id },
  });
  expect(response.result.contentItems[0].text).not.toContain(tinyPng().toString('base64'));
  expect(() => JSON.stringify(result)).toThrow('cannot be serialized');
});

it('prevents writes after revocation during serialization or a full-envelope limit failure', () => {
  const f = fixture();
  let active = true;
  const result = new AttachmentResult(
    f.message.id,
    f.access.resolve(f.attachments[0]!.id),
    () => {
      if (!active) throw new Error('revoked');
    },
    'codex-dynamic-image',
  );
  const writes: string[] = [];
  const wire = {
    closed: false,
    child: { stdin: { write: (value: string) => writes.push(value) } },
  };
  expect(() =>
    result.dispatchCodex(1, (response, validate) => {
      JsonLinesProcess.prototype.send.call(
        wire as any,
        {
          toJSON() {
            active = false;
            return response;
          },
        },
        validate,
      );
    }),
  ).toThrow('revoked');
  active = true;
  expect(() =>
    result.dispatchCodex('界'.repeat(3 * 1024 * 1024), (response, validate) => {
      JsonLinesProcess.prototype.send.call(wire as any, response, validate);
    }),
  ).toThrow('transport limit');
  expect(writes).toEqual([]);
  const wrongBridge = new AttachmentResult(
    f.message.id,
    f.access.resolve(f.attachments[0]!.id),
    () => {},
    'claude-mcp-image',
  );
  expect(() =>
    wrongBridge.dispatchCodex(1, () => {
      throw new Error('should not send');
    }),
  ).toThrow('mapping is unavailable');
});

it('keeps unapproved Codex mappings unavailable without echoing private identities', () => {
  const tuple = {
    cliVersion: 'private/path?secret',
    requestedModel: 'gpt-6-astra',
    requestedEffort: 'xhigh',
    observedModel: 'gpt-6-astra',
    observedEffort: 'xhigh',
    permissions: { edits: false, commands: false, network: false },
    skillsEnabled: false,
    commandMode: 'off' as const,
    nativePolicyVerified: true,
    sessionOrigin: 'fresh' as const,
  };
  // An unreadable identity is a diagnostic, so an otherwise eligible report stays
  // available and carries no reason text at all.
  expect(codexImageSupport(tuple)).toEqual({
    provider: 'codex',
    initial: { available: true, status: 'available' },
    retrieval: { available: true, status: 'available' },
  });
  // A real unmet requirement closes both paths and still never echoes the identity.
  const report = codexImageSupport({ ...tuple, nativePolicyVerified: false });
  expect(report.initial).toMatchObject({ available: false, status: 'unsupported' });
  expect(report.retrieval).toMatchObject({ available: false, status: 'unsupported' });
  expect(JSON.stringify(report)).not.toContain('private/path');
  expect(JSON.stringify(report)).toContain('unknown or unavailable');
  // Version evidence authorizes no mapping: the key/provider pair still decides.
  expect(registeredImageMapping('codex-dynamic-image', 'grok')).toBe(false);
  expect(registeredImageMapping('codex-dynamic-image', 'codex')).toBe(true);
  expect(registeredImageMapping('future-native-image', 'codex')).toBe(false);
});

it('requires the revised native policy and rejects unknown or resumed environment projections', () => {
  const response = {
    cwd: '/workspace',
    activePermissionProfile: { id: 'profile', extends: null },
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    thread: { environments: [] },
    runtimeWorkspaceRoots: [],
  };
  const policy = codexSessionPolicy(response, '/workspace', 'profile');
  expect(policy.zeroEnvironments).toBe(true);
  expect(policy.zeroProjectedRoots).toBe(true);
  expect(policy.environmentCount).toBe(0);
  for (const changed of [
    { ...response, thread: { environments: [{}] }, runtimeWorkspaceRoots: ['/workspace'] },
    { ...response, thread: {}, runtimeWorkspaceRoots: undefined },
  ]) {
    const observed = codexSessionPolicy(changed, '/workspace', 'profile');
    expect(observed.zeroEnvironments).toBe(false);
    expect(observed.zeroProjectedRoots).toBe(false);
  }
  const tuple = {
    cliVersion: 'codex-cli 0.154.0',
    requestedModel: 'gpt-6-astra',
    requestedEffort: 'xhigh',
    observedModel: 'gpt-6-astra',
    observedEffort: 'xhigh',
    permissions: { edits: false, commands: false, network: false },
    skillsEnabled: false,
    commandMode: 'off' as const,
    nativePolicyVerified: true,
    sessionOrigin: 'fresh' as const,
  };
  expect(codexImageSupport(tuple).initial.available).toBe(true);
  // An unlisted build is decided by the same live observations, not by its
  // version, and since #105 not by its model or effort either.
  for (const changed of [
    { ...tuple, cliVersion: 'codex-cli 0.999.0' },
    { ...tuple, cliVersion: 'codex-cli 0.999.0', observedEffort: 'high' },
    { ...tuple, requestedEffort: 'high', observedEffort: 'high' },
    { ...tuple, requestedEffort: 'high' },
    { ...tuple, requestedModel: 'gpt-5.6-sol', observedModel: 'gpt-5.6-sol' },
  ])
    expect(codexImageSupport(changed)).toMatchObject({
      initial: { available: true },
      retrieval: { available: true },
    });
  for (const changed of [
    { ...tuple, sessionOrigin: 'resumed' as const },
    { ...tuple, nativePolicyVerified: false },
    { ...tuple, observedModel: undefined },
    { ...tuple, observedEffort: undefined },
    { ...tuple, skillsEnabled: true },
    { ...tuple, commandMode: 'sandboxed' as const },
  ]) {
    const report = codexImageSupport(changed);
    expect(report.initial.available).toBe(false);
    expect(report.retrieval.available).toBe(false);
  }
  expect(
    codexImageSupport({
      ...tuple,
      permissions: { edits: true, commands: true, network: true },
      skillsEnabled: true,
      commandMode: 'trusted',
    }).retrieval.available,
  ).toBe(true);
});
