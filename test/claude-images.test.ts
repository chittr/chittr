import { expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AttachmentStore, attachmentLimits } from '../src/attachments.js';
import { providerEventBytes } from '../src/process.js';
import { AttachmentResult } from '../src/attachment-result.js';
import { assertClaudeFrame, claudeInitialContent } from '../src/claude-images.js';
import { tinyPng, paddedPng } from './image-fixture.js';
import type { Message } from '../src/types.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(count = 1, bytes = tinyPng()) {
  const dir = mkdtempSync('/private/tmp/claude-images-test-');
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
    recipients: ['claude'],
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
  const blocks = claudeInitialContent(
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
      source: { type: 'base64', media_type: 'image/png', data: tinyPng().toString('base64') },
    })),
  );
  expect(claudeInitialContent([{ ...message, attachments: undefined }], access)).toEqual([]);
});
it('rejects absent resolvers, changed metadata, PNG bytes and hashes before encoding', () => {
  const { access, message } = fixture();
  expect(() => claudeInitialContent([message])).toThrow('resolver');
  const image = access.resolve(message.attachments![0]!.id);
  for (const corrupted of [
    { ...image, sha256: '0'.repeat(64) },
    { ...image, bytes: Buffer.from('invalid') },
    { ...image, metadata: { ...image.metadata, width: 99 } },
  ])
    expect(() =>
      claudeInitialContent([message], { ...access, resolve: () => corrupted }),
    ).toThrow();
});
it('enforces message count and batch aggregate limits independently', () => {
  const f = fixture(21);
  expect(() => claudeInitialContent([f.message], f.access)).toThrow('at most 20 images');
  const large = fixture(3, paddedPng(attachmentLimits.perImageBytes));
  expect(() =>
    claudeInitialContent(
      large.attachments.map((a, i) => ({ ...large.message, id: `m${i}`, attachments: [a] })),
      large.access,
    ),
  ).toThrow('aggregate');
});
it('bounds full native requests and escaped multibyte replay text by the shared reader cap', () => {
  expect(providerEventBytes).toBe(64 * 1024 * 1024);
  const ascii = 'a'.repeat(60 * 1024 * 1024);
  expect(() => assertClaudeFrame({ message: { content: ascii } }, 1)).not.toThrow();
  expect(() => assertClaudeFrame({ message: { content: ascii } }, 2)).toThrow('replay');
  // Three UTF-8 bytes per character: 22 Mi characters are 66 MiB on the wire.
  expect(() =>
    assertClaudeFrame({ message: { content: '界'.repeat(22 * 1024 * 1024) } }, 1),
  ).toThrow('replay');
  // A JSON-escaped replay of a quote is four bytes per character.
  expect(() =>
    assertClaudeFrame({ message: { content: '"'.repeat(16 * 1024 * 1024) } }, 1),
  ).toThrow('replay');
});
it('rechecks authority and the complete MCP envelope immediately before dispatch', () => {
  const { access, message } = fixture();
  let active = true;
  const result = new AttachmentResult(
    message.id,
    access.resolve(message.attachments![0]!.id),
    () => {
      if (!active) throw new Error('revoked');
    },
    'claude-mcp-image',
  );
  expect(result.response({ jsonrpc: '2.0', id: 3 }).result.content[1]?.type).toBe('image');
  expect(() => result.response({ jsonrpc: '2.0', id: '界'.repeat(11 * 1024 * 1024) })).toThrow(
    'replay',
  );
  active = false;
  expect(() => result.response({ jsonrpc: '2.0', id: 4 })).toThrow('revoked');
  expect(() => JSON.stringify(result)).toThrow('cannot be serialized');
});

it('fits complete maximum 6 MiB and 20-image batches and a doubled 3 MiB retrieval replay', () => {
  const perImage = attachmentLimits.aggregateBytes / attachmentLimits.imagesPerMessage;
  for (const batch of [
    fixture(2, paddedPng(attachmentLimits.perImageBytes)),
    fixture(attachmentLimits.imagesPerMessage, paddedPng(Math.floor(perImage))),
  ]) {
    const content = [
      { type: 'text', text: '界'.repeat(20000) },
      ...claudeInitialContent([batch.message], batch.access),
    ];
    expect(() =>
      assertClaudeFrame(
        {
          type: 'user',
          uuid: randomUUID(),
          session_id: randomUUID(),
          parent_tool_use_id: null,
          message: { role: 'user', content },
        },
        1,
      ),
    ).not.toThrow();
  }
  const { access, message } = fixture(1, paddedPng(attachmentLimits.perImageBytes));
  const result = new AttachmentResult(
    message.id,
    access.resolve(message.attachments![0]!.id),
    () => {},
    'claude-mcp-image',
  );
  expect(result.response({ jsonrpc: '2.0', id: 123 }).result.content[1]?.type).toBe('image');
});
