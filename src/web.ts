import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RoomController } from './controller.js';
import { complete } from './completion.js';
import type { CommandResult, StageAttachmentResult, WebState } from './web-types.js';
import { AttachmentError, attachmentLimits, attachmentLimitText } from './attachments.js';
import { runProcess } from './process.js';

const identity = z.string().uuid();
const draftIdentity = z.object({
  clientId: identity,
  version: z.number().int().nonnegative().safe(),
  baseRevision: z.number().int().nonnegative().safe().optional(),
});
const attachmentId = z.string().regex(/^att-[\da-f]{32}$/);
const commandSchema = z
  .object({
    id: identity,
    sessionId: identity,
    line: z.string().max(65536),
    attachmentIds: z.array(attachmentId).min(1).max(attachmentLimits.imagesPerMessage).optional(),
    draft: draftIdentity.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.attachmentIds?.length || !value.draft || value.draft.baseRevision !== undefined,
    { message: 'Attachment draft sends require baseRevision' },
  );
const draftSchema = draftIdentity
  .extend({
    sessionId: identity,
    text: z.string().max(65536),
    attachmentIds: z.array(attachmentId).max(attachmentLimits.imagesPerMessage).optional(),
  })
  .strict()
  .refine((value) => value.attachmentIds === undefined || value.baseRevision !== undefined, {
    message: 'Attachment draft updates require baseRevision',
  });
const planOpenSchema = z.object({ sessionId: identity }).strict();
/** Open a file with the macOS default application. */
export async function openWithSystem(path: string): Promise<void> {
  const result = await runProcess('/usr/bin/open', [path], { timeout: 10000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not open ${path}`);
}
const completionSchema = z
  .object({
    sessionId: identity,
    value: z.string().max(65536),
    cursor: z.number().int().min(0).max(65536),
  })
  .strict();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new HttpError(415, 'Use application/json');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 512 * 1024) throw new HttpError(413, 'Request is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** One local browser server, attached to the same controller used by the terminal. */
export class WebUI {
  readonly instanceId = randomUUID();
  private token = randomBytes(32).toString('hex');
  private origin = '';
  private revision = 0;
  private closed = false;
  private clients = new Set<ServerResponse>();
  private broadcastTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private assets = new Map<string, { data: Buffer; type: string }>();
  private requests = new Map<string, { input: string; result: Promise<CommandResult> }>();
  private server = createServer((request, response) => {
    void this.handle(request, response).catch((error) => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.end();
        return;
      }
      json(response, error instanceof HttpError ? error.status : 400, {
        error:
          error instanceof z.ZodError ? 'Invalid request fields' : String(error.message ?? error),
      });
    });
  });
  private changed = () => {
    this.revision++;
    if (!this.broadcastTimer)
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = undefined;
        const event = this.stateEvent();
        for (const client of this.clients) {
          // Reconnect with a fresh snapshot rather than buffering stale state indefinitely.
          if (client.writableLength > 1024 * 1024) client.destroy();
          else client.write(event);
        }
      }, 60);
  };
  constructor(
    readonly controller: RoomController,
    private options: {
      port?: number;
      assets?: string;
      /** Test seam for the plan Open button; defaults to `/usr/bin/open`. */
      openFile?: (path: string) => Promise<void>;
    } = {},
  ) {}
  async mount(): Promise<string> {
    const root = this.options.assets ?? fileURLToPath(new URL('../dist/web/', import.meta.url));
    const load = (directory: string, prefix: string) => {
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        if (file.isDirectory()) load(join(directory, file.name), prefix + file.name + '/');
        else if (file.isFile()) {
          const type = (
            {
              '.html': 'text/html',
              '.js': 'text/javascript',
              '.css': 'text/css',
              '.svg': 'image/svg+xml',
            } as Record<string, string>
          )[extname(file.name)];
          if (type)
            this.assets.set(prefix + file.name, {
              data: readFileSync(join(directory, file.name)),
              type,
            });
        }
      }
    };
    try {
      load(root, '/');
    } catch {
      throw new Error(
        'Chittr web assets are missing. Reinstall the same @chittr/cli package. In a source checkout, run npm run build.',
      );
    }
    if (!this.assets.has('/index.html'))
      throw new Error(
        'Chittr web index.html is missing. Reinstall the same @chittr/cli package. In a source checkout, run npm run build.',
      );
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Could not bind local web server');
    this.origin = `http://127.0.0.1:${address.port}`;
    this.controller.on('change', this.changed);
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(': keepalive\n\n');
    }, 15000);
    this.heartbeat.unref();
    return `${this.origin}/#${this.token}`;
  }
  snapshot(): WebState {
    return { instanceId: this.instanceId, revision: this.revision, ...this.controller.snapshot() };
  }
  private stateEvent(): string {
    return `id: ${this.revision}\nevent: state\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
  }
  private authorized(request: IncomingMessage): boolean {
    // Cookies cross localhost ports, so only an explicitly supplied token grants access.
    const bearer = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const provided = Buffer.from(bearer ?? '');
    const expected = Buffer.from(this.token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
  private async draft(input: z.infer<typeof draftSchema>) {
    if (Buffer.byteLength(input.text) > 65536) throw new HttpError(413, 'Draft exceeds 64 KiB');
    try {
      return await this.controller.updateDraft(
        {
          text: input.text,
          clientId: input.clientId,
          version: input.version,
          attachmentIds: input.attachmentIds,
          baseRevision: input.baseRevision,
        },
        input.sessionId,
      );
    } catch (error) {
      if (String((error as Error).message).startsWith('Draft changed'))
        throw new HttpError(409, String((error as Error).message));
      throw error;
    }
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (
      request.headers.host !== this.origin.slice(7) ||
      (request.headers.origin && request.headers.origin !== this.origin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      throw new HttpError(403, 'This room accepts same-origin local requests only');
    const url = new URL(request.url ?? '/', this.origin);
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const asset = this.assets.get(path === '/' ? '/index.html' : path);
      if (!asset) throw new HttpError(404, 'Not found');
      response.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8` });
      response.end(asset.data);
      return;
    }
    if (!this.authorized(request))
      throw new HttpError(401, 'Open the browser link printed by chittr to connect.');
    if (this.closed) throw new HttpError(410, 'Room closed');
    if (path === '/api/connect' && request.method === 'POST') {
      json(response, 200, this.snapshot());
      return;
    }
    if (path === '/api/state' && request.method === 'GET') {
      json(response, 200, this.snapshot());
      return;
    }
    if (path === '/api/events' && request.method === 'GET') {
      if (this.clients.size >= 16) throw new HttpError(429, 'Too many browser connections');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      this.clients.add(response);
      response.on('close', () => this.clients.delete(response));
      response.write(this.stateEvent());
      return;
    }
    if (path === '/api/sessions' && request.method === 'GET') {
      json(response, 200, this.controller.store.list());
      return;
    }
    if (path === '/api/config' && request.method === 'GET') {
      json(response, 200, this.controller.configSummary());
      return;
    }
    const imageRead = /^\/api\/attachments\/(att-[\da-f]{32})$/.exec(path);
    if (imageRead && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      let resolved;
      try {
        resolved = this.controller.store.attachmentAccess(sessionId).resolve(imageRead[1]!);
      } catch (error) {
        if (error instanceof z.ZodError) throw new HttpError(400, 'Invalid session identity');
        if (error instanceof AttachmentError)
          throw new HttpError(error.code === 'attachment-not-found' ? 404 : 409, error.message);
        throw error;
      }
      response.writeHead(200, {
        'Content-Type': resolved.metadata.mediaType,
        'Content-Length': resolved.bytes.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ETag: `"sha256-${resolved.sha256}"`,
      });
      response.end(resolved.bytes);
      return;
    }
    if (path === '/api/attachments' && request.method === 'POST') {
      const mediaType = request.headers['content-type']?.split(';')[0] ?? '';
      if (!(attachmentLimits.acceptedMediaTypes as readonly string[]).includes(mediaType))
        throw new HttpError(415, 'Use image/png');
      const filename = url.searchParams.get('filename') ?? '';
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const operationId = url.searchParams.get('operationId') ?? '';
      const declaredLength = Number(request.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > attachmentLimits.perImageBytes)
        throw new HttpError(413, attachmentLimitText.perImage);
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > attachmentLimits.perImageBytes)
          throw new HttpError(413, attachmentLimitText.perImage);
        chunks.push(Buffer.from(chunk));
      }
      let attachment;
      try {
        attachment = await this.controller.stageAttachment({
          sessionId,
          operationId,
          filename,
          mediaType,
          bytes: Buffer.concat(chunks),
        });
      } catch (error) {
        if (error instanceof z.ZodError) throw new HttpError(400, 'Invalid upload identity');
        if (error instanceof AttachmentError) {
          const status =
            error.code === 'attachment-conflict'
              ? 409
              : error.code === 'attachment-limit'
                ? 413
                : error.code === 'attachment-unsupported'
                  ? 415
                  : 400;
          throw new HttpError(status, error.message);
        }
        throw error;
      }
      json(response, 201, { attachment } satisfies StageAttachmentResult);
      return;
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const data = await body(request);
    if (path === '/api/draft') {
      const result = await this.draft(draftSchema.parse(data));
      json(response, 200, { ok: true, ...result });
      return;
    }
    if (path === '/api/complete') {
      const input = completionSchema.parse(data);
      if (/^\/attach(?:\s|$)/.test(input.value))
        throw new HttpError(400, 'Attachment path actions are terminal-only');
      const room = this.controller.room;
      if (input.sessionId !== room.session.id) throw new HttpError(409, 'Conversation changed');
      json(
        response,
        200,
        complete(room.config.workspace, room.enabledNames(), input.value, input.cursor),
      );
      return;
    }
    if (path === '/api/plan/open') {
      const input = planOpenSchema.parse(data);
      const room = this.controller.room;
      if (input.sessionId !== room.session.id) throw new HttpError(409, 'Conversation changed');
      // Only the attached plan is ever opened; the request carries no path.
      const plan = room.planStatus();
      if (!plan) throw new HttpError(409, 'Plan mode is off');
      if (plan.missing) throw new HttpError(404, `The plan file is missing: ${plan.path}`);
      await (this.options.openFile ?? openWithSystem)(plan.path);
      json(response, 200, { ok: true });
      return;
    }
    if (path === '/api/command') {
      const input = commandSchema.parse(data);
      if (Buffer.byteLength(input.line) > 65536) throw new HttpError(413, 'Message exceeds 64 KiB');
      const serialized = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      let entry = this.requests.get(input.id);
      if (entry && entry.input !== serialized)
        throw new HttpError(409, 'Request ID was already used for different input');
      if (!entry) {
        if (this.requests.size >= 10000)
          throw new HttpError(429, 'This launch has reached 10,000 commands; restart to continue.');
        const result = (async (): Promise<CommandResult> => {
          let submission;
          try {
            submission = await this.controller.submitDraft({
              source: 'http',
              line: input.line,
              sessionId: input.sessionId,
              attachmentIds: input.attachmentIds,
              operationId: input.id,
              draft: input.draft,
            });
          } catch (error) {
            // No typed result was produced, so nothing is retained: the same identity may be evaluated again.
            this.requests.delete(input.id);
            throw error;
          }
          if (submission.dispatch.status === 'sent')
            return { ok: true, sessionId: submission.sessionId, submission };
          if (submission.dispatch.failure === 'operation-conflict')
            throw new HttpError(409, submission.dispatch.error);
          // Only an uncommitted attachment failure may be retried as a fresh delivery.
          if (submission.commitment.status === 'uncommitted') this.requests.delete(input.id);
          return {
            ok: false,
            error: submission.dispatch.error,
            sessionId: submission.sessionId,
            submission,
          };
        })();
        entry = { input: serialized, result };
        this.requests.set(input.id, entry);
      }
      json(response, 200, await entry.result);
      return;
    }
    throw new HttpError(404, 'Not found');
  }
  unmount(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.off('change', this.changed);
    clearTimeout(this.broadcastTimer);
    clearInterval(this.heartbeat);
    for (const client of this.clients)
      client.end(this.stateEvent() + 'event: closed\ndata: {}\n\n');
    this.clients.clear();
    this.server.close();
    this.server.closeIdleConnections();
  }
}
