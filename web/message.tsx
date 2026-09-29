import { QuestionActions } from './question-card';
export { QuestionActions } from './question-card';
import { memo, useMemo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageImages } from './images';
import type { AttachmentMetadata, Message } from '../src/types.js';

export function CopyButton({ text, label = 'Copy message' }: { text: string; label?: string }) {
  const [status, setStatus] = useState('');
  return (
    <button
      className="copy-button"
      title={status || label}
      aria-label={status || label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus('Copied');
        } catch {
          setStatus('Copy failed; select the text and use Cmd+C');
        }
        setTimeout(() => setStatus(''), 2500);
      }}
    >
      {status || (
        <>
          <span aria-hidden="true">⧉</span> Copy
        </>
      )}
    </button>
  );
}
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return textOf((node.props as { children?: ReactNode }).children);
  return '';
}
export function MessageBody({ text }: { text: string }) {
  return useMemo(
    () => (
      <div className="markdown">
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={{
            a: ({ href, children }) =>
              href && /^(https?:|mailto:)/i.test(href) ? (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              ),
            img: ({ alt }) => (
              <span className="image-reference">[Image: {alt || 'reference'}]</span>
            ),
            pre: ({ children }) => (
              <div className="code-block">
                <div className="code-toolbar">
                  <span>Code</span>
                  <CopyButton text={textOf(children).replace(/\n$/, '')} label="Copy code" />
                </div>
                <pre>{children}</pre>
              </div>
            ),
          }}
        >
          {text}
        </Markdown>
      </div>
    ),
    [text],
  );
}
export function Avatar({
  name,
  provider,
  human,
}: {
  name: string;
  provider?: string;
  human?: boolean;
}) {
  return (
    <span
      className={`avatar ${human ? 'human' : provider === 'claude' ? 'claude' : 'codex'}`}
      aria-hidden="true"
    >
      {human ? Array.from(name)[0]?.toUpperCase() : provider === 'claude' ? '✳' : '⌘'}
    </span>
  );
}
export const MessageCard = memo(function MessageCard({
  message,
  sessionId,
  view,
  humanName,
  providers,
  command,
  reply,
  pinned,
  disabled,
}: {
  message: Message;
  sessionId: string;
  view: (attachment: AttachmentMetadata) => void;
  humanName: string;
  providers: Record<string, string | undefined>;
  command: (line: string) => void;
  reply: (id: string) => void;
  pinned: boolean;
  disabled: boolean;
}) {
  const human = message.author === 'human';
  return (
    <article
      className={`message ${human ? 'from-human' : ''}`}
      id={message.id}
      data-message-id={message.id}
    >
      <Avatar
        name={human ? humanName : message.author}
        provider={providers[message.author]}
        human={human}
      />
      <div className="message-content">
        <div className="message-heading">
          <strong>{human ? humanName : message.author}</strong>
          <span className="message-route">
            {message.recipients.length
              ? 'to ' +
                message.recipients
                  .map((name) => (name === 'human' ? humanName : '@' + name))
                  .join(', ')
              : 'to everyone'}
          </span>
          <time title={new Date(message.createdAt).toLocaleString()}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          <span className="message-id">#{message.id}</span>
          <button
            className="pin-button"
            aria-label={pinned ? 'Unpin message' : 'Pin message'}
            aria-pressed={pinned}
            disabled={disabled}
            onClick={() => command(`/${pinned ? 'unpin' : 'pin'} #${message.id}`)}
          >
            {pinned ? 'Pinned' : 'Pin'}
          </button>
          <button className="reply-button" disabled={disabled} onClick={() => reply(message.id)}>
            <span aria-hidden="true">↩</span> Reply
          </button>
          {message.text && <CopyButton text={message.text} />}
        </div>
        {message.replyTo.length > 0 && (
          <div className="reply-links">
            Replying to{' '}
            {message.replyTo.map((id) => (
              <a
                key={id}
                href={'#' + id}
                onClick={(event) => {
                  event.preventDefault();
                  document
                    .getElementById(id)
                    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }}
              >
                #{id}{' '}
              </a>
            ))}
          </div>
        )}
        <MessageBody text={message.text} />
        {Boolean(message.attachments?.length) && (
          <MessageImages attachments={message.attachments!} sessionId={sessionId} view={view} />
        )}
        <QuestionActions message={message} disabled={disabled} />
        {Object.keys(message.deliveries).length > 0 && (
          <div className="deliveries">
            {Object.entries(message.deliveries).map(([name, delivery]) => (
              <div key={name} className={`delivery ${delivery.status}`}>
                <span className="delivery-dot" />
                <span>
                  <strong>{name}</strong>{' '}
                  {delivery.status === 'passed' ? 'has nothing to add' : delivery.status}
                  {delivery.rationale ? ` · ${delivery.rationale}` : ''}
                </span>
                {['failed', 'interrupted'].includes(delivery.status) && (
                  <button
                    disabled={disabled}
                    onClick={() => command(`/retry #${message.id} @${name}`)}
                  >
                    Retry
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
});
