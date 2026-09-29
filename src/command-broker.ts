import { createServer, createConnection, type Socket } from 'node:net';
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

// Every room denies this directory and connections to its sockets, including
// rooms with network access and rooms whose workspace contains /private/tmp.
export const commandBrokerRoot = `/private/tmp/chittr-command-brokers-${process.getuid?.() ?? 'user'}`;
export const commandInput = z
  .object({
    command: z.string().min(1).max(16000),
    timeout_ms: z.number().int().min(100).max(120000).optional(),
  })
  .strict();
export const commandEndpointSchema = z
  .object({ socket: z.string(), credentialFile: z.string() })
  .strict();
export type CommandEndpoint = z.infer<typeof commandEndpointSchema>;
type Input = z.infer<typeof commandInput>;
const requestSchema = z
  .object({ token: z.string().regex(/^[a-f0-9]{64}$/), input: commandInput })
  .strict();
const maxRequest = 128 * 1024;
const maxResponse = 16 * 1024 * 1024;

/** One participant and immutable policy per broker. No caller-supplied env, cwd or grants. */
export class CommandBroker {
  private directory: string;
  private token = randomBytes(32).toString('hex');
  private sockets = new Set<Socket>();
  private server = createServer((socket) => this.accept(socket));
  private closed = false;
  readonly endpoint: CommandEndpoint;
  constructor(
    readonly participant: string,
    private execute: (input: Input, signal: AbortSignal) => Promise<unknown>,
  ) {
    mkdirSync(commandBrokerRoot, { recursive: true, mode: 0o700 });
    const root = lstatSync(commandBrokerRoot);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0)
      throw new Error(
        'Command runtime directory must be a private directory owned by the current user',
      );
    this.directory = mkdtempSync(join(commandBrokerRoot, 'p-'));
    this.endpoint = {
      socket: join(this.directory, 'command.sock'),
      credentialFile: join(this.directory, 'credential'),
    };
    writeFileSync(this.endpoint.credentialFile, this.token, { mode: 0o600, flag: 'wx' });
  }
  async start(): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.endpoint.socket, () => {
          this.server.off('error', reject);
          resolve();
        });
      });
      chmodSync(this.endpoint.socket, 0o600);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private accept(socket: Socket): void {
    if (this.closed || this.sockets.size >= 16) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const controller = new AbortController();
    socket.on('error', () => {});
    socket.once('close', () => {
      controller.abort();
      this.sockets.delete(socket);
    });
    socket.setTimeout(5000, () => socket.destroy());
    let buffer = '';
    socket.setEncoding('utf8');
    const receive = (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxRequest) {
        socket.destroy();
        return;
      }
      if (!buffer.includes('\n')) return;
      socket.off('data', receive);
      void (async () => {
        try {
          const request = requestSchema.parse(JSON.parse(buffer));
          if (!timingSafeEqual(Buffer.from(request.token), Buffer.from(this.token)))
            throw new Error('Command connection is not authorized');
          socket.setTimeout((request.input.timeout_ms ?? 30000) + 5000);
          const result = await this.execute(request.input, controller.signal);
          socket.end(JSON.stringify({ result }) + '\n');
        } catch (error) {
          // Schema errors may include caller data; do not echo authentication material.
          const message =
            error instanceof z.ZodError || error instanceof SyntaxError
              ? 'Invalid command request'
              : error instanceof Error
                ? error.message
                : 'Command failed';
          socket.end(JSON.stringify({ error: message }) + '\n');
        }
      })();
    };
    socket.on('data', receive);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

export async function forwardCommand(
  endpoint: CommandEndpoint,
  input: Input,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new Error('Interrupted');
  // Read once per invocation so revoked endpoints cannot retain authorization.
  const token = readFileSync(endpoint.credentialFile, 'utf8');
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socket);
    let buffer = '';
    let finished = false;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error('Interrupted'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    socket.setTimeout((input.timeout_ms ?? 30000) + 10000, () =>
      finish(new Error('Room command executor timed out')),
    );
    socket.on('error', () =>
      finish(new Error('Room command executor unavailable; reconnect the participant')),
    );
    socket.once('close', () => finish(new Error('Room command connection closed')));
    socket.once('connect', () => socket.write(JSON.stringify({ token, input }) + '\n'));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxResponse) {
        finish(new Error('Command response exceeded its limit'));
        return;
      }
      if (!buffer.includes('\n')) return;
      try {
        const response = JSON.parse(buffer);
        if (response.error) finish(new Error(String(response.error)));
        else finish(undefined, response.result);
      } catch {
        finish(new Error('Invalid room command response'));
      }
    });
  });
}
