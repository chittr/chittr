const authKey = 'chittr:token';
function acceptLaunchToken(): boolean {
  const fragment = location.hash.slice(1);
  if (!/^[a-f0-9]{64}$/.test(fragment)) return false;
  sessionStorage.setItem(authKey, fragment);
  history.replaceState(null, '', location.pathname);
  return true;
}
acceptLaunchToken();
addEventListener('hashchange', () => {
  if (acceptLaunchToken()) location.reload();
});
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
/** Room credentials stay in this origin's tab storage and explicit headers. */
export function authenticatedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = sessionStorage.getItem(authKey);
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch('/api/' + path, {
    ...options,
    credentials: 'omit',
    redirect: 'error',
    headers,
  });
}
export async function api<T>(path: string, body?: unknown, keepalive = false): Promise<T> {
  const response = await authenticatedFetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    keepalive,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(result.error ?? `Request failed (${response.status})`, response.status);
  return result as T;
}
export function nextDraftVersion(): { clientId: string; version: number } {
  let clientId = sessionStorage.getItem('chittr:client');
  if (!clientId) {
    clientId = crypto.randomUUID();
    sessionStorage.setItem('chittr:client', clientId);
  }
  const version = Number(sessionStorage.getItem('chittr:version') ?? 0) + 1;
  sessionStorage.setItem('chittr:version', String(version));
  return { clientId, version };
}

export async function uploadImage(file: File, sessionId: string, operationId: string) {
  const query = new URLSearchParams({ sessionId, operationId, filename: file.name });
  const response = await authenticatedFetch('attachments?' + query, {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file,
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Upload failed (${response.status})`);
  return (result as import('../src/web-types.js').StageAttachmentResult).attachment;
}

/** Read the host's SSE frames with bearer authentication and reconnect on EOF. */
export function subscribeEvents(callbacks: {
  open(): void;
  state(value: import('../src/web-types.js').WebState): void;
  closed(): void;
  error(): void;
}): () => void {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = async () => {
    try {
      const response = await authenticatedFetch('events', { signal: controller.signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Event stream unavailable');
      }
      callbacks.open();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = '';
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += value;
          let end: number;
          while ((end = pending.indexOf('\n\n')) !== -1) {
            const lines = pending.slice(0, end).split('\n');
            pending = pending.slice(end + 2);
            const event = lines
              .find((line) => line.startsWith('event:'))
              ?.slice(6)
              .trim();
            if (event === 'closed') {
              controller.abort();
              callbacks.closed();
              return;
            }
            if (event === 'state') {
              const data = lines
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              callbacks.state(JSON.parse(data));
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      // A lost stream uses the same full-snapshot reconnect as EventSource.
    }
    if (!controller.signal.aborted) {
      callbacks.error();
      retry = setTimeout(() => void connect(), 1000);
    }
  };
  void connect();
  return () => {
    controller.abort();
    clearTimeout(retry);
  };
}
