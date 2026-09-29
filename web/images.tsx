import { useEffect, useState } from 'react';
import type { AttachmentMetadata, Message } from '../src/types.js';
import { Dialog } from './dialog';
import { authenticatedFetch } from './api';

export const imageSummary = (message: Message) =>
  message.text || message.attachments?.map((image) => `[Image: ${image.filename}]`).join(' ') || '';

export function HostImage({
  attachment,
  sessionId,
  large = false,
}: {
  attachment: AttachmentMetadata;
  sessionId: string;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [viewRequest] = useState(() => (large ? crypto.randomUUID() : undefined));
  const [source, setSource] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setSource(undefined);
    setFailed(false);
    const query = new URLSearchParams({
      sessionId,
      ...(viewRequest ? { view: viewRequest } : {}),
      ...(attempt ? { retry: String(attempt) } : {}),
    });
    void authenticatedFetch(`attachments/${attachment.id}?${query}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Image unavailable');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, sessionId, viewRequest, attempt]);
  const label = `${attachment.filename}, ${attachment.width} × ${attachment.height} pixels`;
  return (
    <div className={large ? 'image-large' : 'image-thumbnail'}>
      {failed ? (
        <div className="image-unavailable" role="status">
          <span>Image unavailable: {label}. Reconnect if needed, then retry.</span>
          <button
            onClick={() => {
              setFailed(false);
              setAttempt(attempt + 1);
            }}
            aria-label={`Retry image ${attachment.filename}`}
          >
            Retry image
          </button>
        </div>
      ) : source ? (
        <img
          key={attempt}
          src={source}
          alt={label}
          width={attachment.width}
          height={attachment.height}
          onError={() => setFailed(true)}
        />
      ) : (
        <span role="status">Loading image: {label}</span>
      )}
    </div>
  );
}
export function ImageViewer({
  attachment,
  sessionId,
  close,
}: {
  attachment: AttachmentMetadata;
  sessionId: string;
  close: () => void;
}) {
  return (
    <Dialog title={`Image: ${attachment.filename}`} close={close}>
      <HostImage attachment={attachment} sessionId={sessionId} large />
    </Dialog>
  );
}
export function MessageImages({
  attachments,
  sessionId,
  view,
}: {
  attachments: AttachmentMetadata[];
  sessionId: string;
  view: (image: AttachmentMetadata) => void;
}) {
  return (
    <div className="message-images" aria-label="Message images">
      {attachments.map((attachment) => (
        <div className="image-tile" key={attachment.id} data-attachment-id={attachment.id}>
          <HostImage attachment={attachment} sessionId={sessionId} />
          <button onClick={() => view(attachment)} aria-label={`View image ${attachment.filename}`}>
            View {attachment.filename}
          </button>
        </div>
      ))}
    </div>
  );
}
