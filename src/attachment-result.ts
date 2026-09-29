import { assertClaudeFrame } from './claude-images.js';
import { assertCodexFrame } from './codex-images.js';
import { createHash } from 'node:crypto';
import {
  AttachmentError,
  attachmentLimits,
  validateImage,
  type ResolvedAttachment,
} from './attachments.js';

export const retrievalUnavailable = {
  error: 'attachment-unavailable',
  message: 'Native image retrieval is unavailable for this provider bridge.',
} as const;

// Bytes are deliberately private, and JSON serialization is an error. Only an
// explicit native boundary may unwrap the result, with a final authority check.
export class AttachmentResult {
  #image: ResolvedAttachment;
  #assertCurrent: () => void;
  constructor(
    readonly messageId: string,
    image: ResolvedAttachment,
    assertCurrent: () => void,
    readonly mapping = 'grok-mcp-image',
  ) {
    this.#image = image;
    this.#assertCurrent = assertCurrent;
  }
  toJSON(): never {
    throw new Error('Native image results cannot be serialized as text');
  }
  /** The in-process Codex response boundary. The transport must invoke validate
   * after serialization and immediately before its synchronous write.
   */
  dispatchCodex(
    id: string | number,
    send: (response: unknown, validate: (serialized: string) => void) => void,
  ): void {
    if (this.mapping !== 'codex-dynamic-image')
      throw new Error('Native image mapping is unavailable');
    const image = this.mcp();
    const association = image.content[0]!;
    const pixels = image.content[1]!;
    const response = {
      id,
      result: {
        success: true,
        contentItems: [
          { type: 'inputText', text: association.text },
          { type: 'inputImage', imageUrl: `data:image/png;base64,${pixels.data}` },
        ],
      },
    };
    this.#assertCurrent();
    send(response, (serialized) => {
      assertCodexFrame(serialized);
      this.#assertCurrent();
    });
  }
  /** Called by the MCP transport at its actual dispatch boundary. */
  response(envelope: { jsonrpc: '2.0'; id: string | number; result?: unknown }) {
    const response = { ...envelope, result: this.mcp() };
    if (this.mapping === 'claude-mcp-image') assertClaudeFrame(response, 2);
    else if (
      Buffer.byteLength(JSON.stringify(response)) + 256 * 1024 >
      attachmentLimits.nativeFrameCharacters
    )
      throw new AttachmentError(
        'attachment-limit',
        'Native image response exceeds the transport limit',
      );
    this.#assertCurrent();
    return response;
  }
  mcp() {
    this.#assertCurrent();
    const { metadata, bytes, sha256 } = this.#image;
    const dimensions = validateImage(bytes, metadata.mediaType);
    if (
      metadata.byteSize !== bytes.length ||
      dimensions.width !== metadata.width ||
      dimensions.height !== metadata.height ||
      createHash('sha256').update(bytes).digest('hex') !== sha256
    )
      throw new AttachmentError('attachment-corrupt', 'Attachment content failed validation');
    const result = {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ messageId: this.messageId, attachment: metadata, sha256 }),
        },
        { type: 'image' as const, mimeType: metadata.mediaType, data: bytes.toString('base64') },
      ],
    };
    // Include enclosing JSON-RPC/bridge headroom, using the foundation's bound.
    if (
      Buffer.byteLength(JSON.stringify(result)) >
      attachmentLimits.nativeFrameCharacters - 256 * 1024
    )
      throw new AttachmentError(
        'attachment-limit',
        'Native image result exceeds the transport limit',
      );
    this.#assertCurrent();
    return result;
  }
}

export function mcpToolResult(result: unknown) {
  return result instanceof AttachmentResult
    ? result.mcp()
    : { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

// The ordinary constructor is byte-free. Typed images reach the native wire
// only through dispatchCodex at the in-process response boundary.
export function codexToolResult(result: unknown) {
  return {
    success: !(result instanceof AttachmentResult),
    contentItems: [
      {
        type: 'inputText' as const,
        text: JSON.stringify(result instanceof AttachmentResult ? retrievalUnavailable : result),
      },
    ],
  };
}

export function attachmentFailure(error: unknown) {
  return {
    error: error instanceof AttachmentError ? error.code : 'attachment-unavailable',
    message:
      'Attachment could not be read in the current turn. Discover an available ID with read_conversation or retry in a new turn.',
  };
}
