// Host-side observation only. No native transcript, image bytes or tool text is retained.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const uuid = (value) =>
  typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value) ? value : undefined;
const attachmentId = (value) =>
  typeof value === 'string' && /^att-[a-f0-9]{32}$/.test(value) ? value : undefined;
const messageId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value) ? value : undefined;
const requestId = (value) => (Number.isSafeInteger(value) ? value : uuid(value));
export function imageProjection(value) {
  if (!value || typeof value !== 'object') return [];
  const url =
    value.type === 'image' ? value.url : value.type === 'inputImage' ? value.imageUrl : undefined;
  if (typeof url === 'string' && url.startsWith('data:image/png;base64,')) {
    const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
    return [
      {
        mimeType: 'image/png',
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ];
  }
  return Object.values(value).flatMap(imageProjection);
}
export function observeCodex(Process, Tools, record, control) {
  const send = Process.prototype.send,
    emit = Process.prototype.emit,
    call = Tools.prototype.call;
  const pending = new WeakMap();
  const state = (proc) => {
    if (!pending.has(proc)) pending.set(proc, new Map());
    return pending.get(proc);
  };
  Process.prototype.emit = function (name, ...args) {
    const value = args[0];
    if (name === 'message' && value?.method === 'item/tool/call') {
      state(this).set(value.id, {
        name: value.params?.tool,
        sessionId: uuid(value.params?.threadId),
        turnId: messageId(value.params?.turnId),
      });
    }
    if (name === 'message' && value?.method && imageProjection(value).length) {
      record({
        boundary: 'native-image-replay',
        sessionId: uuid(value.params?.threadId),
        method: ['item/started', 'item/completed'].includes(value.method) ? value.method : 'other',
        frameBytes: Buffer.byteLength(JSON.stringify(value)),
        images: imageProjection(value),
      });
    }
    return emit.call(this, name, ...args);
  };
  Process.prototype.send = function (value, validate) {
    let event;
    const result = send.call(this, value, (serialized) => {
      validate?.(serialized);
      const wire = JSON.parse(serialized);
      if (wire.method === 'turn/start') {
        const fixture = control?.();
        event = {
          boundary: 'initial-native-request',
          sessionId: uuid(wire.params.threadId),
          requestId: requestId(wire.id),
          frameBytes: Buffer.byteLength(serialized),
          images: imageProjection(wire.params.input),
          ...(fixture?.hiddenId ? { hasHiddenId: serialized.includes(fixture.hiddenId) } : {}),
          ...(fixture?.oracles?.length
            ? { hasOracle: fixture.oracles.some((oracle) => serialized.includes(oracle)) }
            : {}),
          associations: (wire.params.input ?? [])
            .filter(
              (item) =>
                item.type === 'text' &&
                /^Chittr image for message #[a-zA-Z0-9-]+, attachment att-[a-f0-9]{32}\.$/.test(
                  item.text,
                ),
            )
            .map((item) => item.text),
        };
      } else if (state(this).has(wire.id)) {
        const request = state(this).get(wire.id);
        state(this).delete(wire.id);
        if (['read_conversation', 'read_attachment'].includes(request.name)) {
          let association;
          try {
            association = JSON.parse(
              wire.result?.contentItems?.find((item) => item.type === 'inputText')?.text,
            );
          } catch {
            /* no text association */
          }
          event = {
            boundary: 'dynamic-result',
            ...request,
            requestId: requestId(wire.id),
            success: wire.result?.success === true,
            frameBytes: Buffer.byteLength(serialized),
            images: imageProjection(wire.result),
            messageId: messageId(association?.messageId),
            attachmentId: attachmentId(association?.attachment?.id),
          };
        }
      }
    });
    if (event) record(event);
    return result;
  };
  Tools.prototype.call = async function (name, args, signal) {
    let roomSessionId;
    try {
      roomSessionId = uuid(JSON.parse(readFileSync(this.attachmentTurnFile, 'utf8')).sessionId);
    } catch {
      /* unavailable */
    }
    if (name === 'read_attachment')
      record({
        boundary: 'dynamic-request',
        name,
        roomSessionId,
        attachmentId: attachmentId(args?.attachment_id),
      });
    const result = await call.call(this, name, args, signal);
    if (name === 'read_conversation') {
      const messages = Array.isArray(result?.messages)
        ? result.messages
        : result?.id
          ? [result]
          : [];
      record({
        boundary: 'history-discovery',
        name,
        roomSessionId,
        discovered: messages.flatMap((message) =>
          (message.attachments ?? []).map((a) => ({
            messageId: messageId(message.id),
            attachmentId: attachmentId(a.id),
          })),
        ),
      });
    }
    return result;
  };
  return () => {
    Process.prototype.send = send;
    Process.prototype.emit = emit;
    Tools.prototype.call = call;
  };
}
