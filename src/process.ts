import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function killTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already exited */
  }
}
export function providerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Chittr uses the CLI's subscription login. Do not silently switch to API billing.
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDECODE',
    'CODEX_THREAD_ID',
    'XAI_API_KEY',
    'GROK_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_ENTERPRISE',
    'AGY_ADC_AUTH',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
    'JETSKI_OAUTH_TOKEN',
  ])
    delete env[key];
  return env;
}
export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    signal?: AbortSignal;
    timeout?: number;
    maxOutput?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Interrupted'));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '',
      stderr = '',
      done = false,
      overflow = false;
    const max = options.maxOutput ?? 2 * 1024 * 1024;
    const abort = () => killTree(child, 'SIGKILL');
    const timeout = setTimeout(abort, options.timeout ?? 30000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (b) => {
      stdout += b;
      if (stdout.length + stderr.length > max) {
        overflow = true;
        abort();
      }
    });
    child.stderr.on('data', (b) => {
      stderr += b;
      if (stdout.length + stderr.length > max) {
        overflow = true;
        abort();
      }
    });
    const finish = (error?: Error, code?: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (options.signal?.aborted) reject(new Error('Interrupted'));
      else if (overflow) reject(new Error('Tool output exceeded its limit'));
      else if (code === null)
        reject(
          new Error(`Process interrupted or timed out${stderr ? ': ' + stderr.slice(-1500) : ''}`),
        );
      else resolve({ stdout, stderr, code: code ?? 1 });
    };
    child.on('error', (e) => finish(e));
    child.on('close', (code) => finish(undefined, code));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}

export class JsonLinesProcess extends EventEmitter {
  child: ChildProcessWithoutNullStreams;
  stderr = '';
  private nextId = 0;
  private pending = new Map<
    string | number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  closed = false;
  constructor(command: string, args: string[], cwd: string, env = providerEnv()) {
    super();
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    });
    this.child.stderr.on('data', (data) => {
      this.stderr = (this.stderr + data).slice(-8000);
    });
    this.child.stdin.on('error', () => {});
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.length > 8 * 1024 * 1024) {
        this.fail(new Error('Oversized provider event'));
        return;
      }
      try {
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (pending && !message.method) {
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          message.error
            ? pending.reject(new Error(message.error.message))
            : pending.resolve(message.result);
        } else this.emit('message', message);
      } catch {
        this.emit('notice', 'Ignored a malformed provider event');
      }
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('close', (code) =>
      this.fail(
        new Error(
          `CLI exited (${code ?? 'signal'})${this.stderr ? ': ' + this.stderr.slice(-1000).trim() : ''}`,
        ),
      ),
    );
  }
  send(message: unknown, validate?: (serialized: string) => void): void {
    if (this.closed) throw new Error('CLI disconnected');
    const serialized = JSON.stringify(message);
    validate?.(serialized);
    if (this.closed) throw new Error('CLI disconnected');
    this.child.stdin.write(serialized + '\n');
  }
  rpc(
    method: string,
    params: unknown,
    timeout = 30000,
    validate?: (serialized: string) => void,
  ): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params }, validate);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit('disconnect', error);
  }
  async close(): Promise<void> {
    if (!this.closed) this.fail(new Error('CLI closed'));
    killTree(this.child);
    await new Promise((r) => setTimeout(r, 80));
    killTree(this.child, 'SIGKILL');
  }
}
