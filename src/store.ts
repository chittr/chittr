import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fingerprint } from './config.js';
import type { Session } from './types.js';
import { z } from 'zod';
import { parseCheckpoint, parseHandoff, maintenanceStateSchema } from './checkpoint.js';
import { questionSchema, legacyQuestionSchema, recommendationSchema } from './protocol.js';
import { freezeLegacyQuestions } from './questions.js';
import { validateQuestionHistory } from './question-history.js';
import {
  AttachmentStore,
  attachmentMetadataSchema,
  validateAttachmentSet,
  type AttachmentAccess,
  type StageAttachmentInput,
} from './attachments.js';
import { validatePlanHistory } from './plan.js';
import { launchBriefSchema } from './instructions.js';
const strings = z.array(z.string());
const activity = z.enum(['available', 'considering', 'replying', 'working', 'waiting']);
const attempt = z.object({
  id: z.string(),
  messageIds: strings,
  chargedRoots: strings,
  startedAt: z.string(),
});
const savedSession = z.object({
  version: z.literal(1),
  id: z.string(),
  workspace: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  paused: z.boolean(),
  composerDraft: z.string().optional(),
  composerAttachments: z.array(attachmentMetadataSchema).max(4).optional(),
  composerDraftRevision: z.number().int().nonnegative().safe().optional(),
  composerDraftVersions: z
    .record(z.string().uuid(), z.number().int().nonnegative().safe())
    .optional(),
  pinnedMessageIds: strings.optional(),
  configSources: strings,
  launchBrief: launchBriefSchema.optional(),
  permissions: z.object({ edits: z.boolean(), commands: z.boolean(), network: z.boolean() }),
  commandMode: z.enum(['off', 'sandboxed', 'trusted']).optional(),
  notices: z.array(z.object({ id: z.string(), text: z.string(), createdAt: z.string() })),
  exchanges: z.record(
    z.string(),
    z.object({ used: z.number().int().nonnegative(), allowance: z.number().int().positive() }),
  ),
  agents: z.record(
    z.string(),
    z.object({
      id: z.string(),
      connection: z.enum(['connecting', 'ready', 'unavailable']),
      activity,
      paused: z.boolean(),
      fingerprint: z.string(),
      contextThrough: z.number().int().nonnegative(),
      contextUsage: z
        .object({
          usedTokens: z.number().int().nonnegative(),
          maxTokens: z.number().int().positive().optional(),
          updatedAt: z.iso.datetime(),
        })
        .optional(),
      draft: z.string(),
      sessionId: z.string().optional(),
      active: attempt.optional(),
      stopped: z.boolean().optional(),
      awaitingHuman: z.boolean().optional(),
      detail: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  messages: z.array(
    z.object({
      id: z.string(),
      sequence: z.number().int().positive(),
      author: z.string(),
      text: z.string(),
      createdAt: z.string(),
      recipients: strings,
      replyTo: strings,
      question: z.union([questionSchema, legacyQuestionSchema]).optional(),
      finalAnswer: z.object({ questionId: z.string() }).strict().optional(),
      consultation: z.object({ questionId: z.string() }).strict().optional(),
      recommendation: recommendationSchema.optional(),
      attachments: z.array(attachmentMetadataSchema).max(4).optional(),
      attachmentOperation: z
        .object({ id: z.string().uuid(), inputHash: z.string().regex(/^[\da-f]{64}$/) })
        .strict()
        .optional(),
      roots: strings,
      deliveries: z.record(
        z.string(),
        z.object({
          status: z.enum([
            'queued',
            'sent',
            'received',
            'contributed',
            'passed',
            'interrupted',
            'failed',
          ]),
          attemptId: z.string().optional(),
          rationale: z.string().optional(),
          responseIds: strings.optional(),
        }),
      ),
    }),
  ),
});
export interface Persistence {
  save(session: Session): void;
  attachmentAccess?(sessionId: string): AttachmentAccess;
}
export interface SessionSummary {
  id: string;
  updatedAt: string;
  preview: string;
  count: number;
}
function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
/** Saved records, on-disk layout and load classification: see docs/saved-format-contract.md. */
export class SessionStore implements Persistence {
  readonly directory: string;
  readonly attachments: AttachmentStore;
  private lockToken?: string;
  private preserveOriginal = new Set<string>();
  constructor(
    readonly workspace: string,
    base = join(homedir(), '.agents', 'chittr', 'sessions'),
  ) {
    this.directory = join(base, fingerprint(workspace).slice(0, 24));
    this.attachments = new AttachmentStore(this.directory);
  }
  acquire(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'room.lock');
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, token, workspace: this.workspace }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        this.lockToken = token;
        this.attachments.cleanup();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let stale = false;
        try {
          const old = JSON.parse(readFileSync(path, 'utf8'));
          try {
            process.kill(old.pid, 0);
          } catch (e) {
            stale = (e as NodeJS.ErrnoException).code === 'ESRCH';
          }
        } catch {
          stale = Date.now() - statSync(path).mtimeMs > 10000;
        }
        if (!stale)
          throw new Error(
            'A Chittr instance already owns this workspace. Close it before opening another.',
          );
        unlinkSync(path);
      }
    }
    throw new Error('Could not acquire the workspace session lock');
  }
  release(): void {
    const path = join(this.directory, 'room.lock');
    try {
      if (this.lockToken && JSON.parse(readFileSync(path, 'utf8')).token === this.lockToken)
        unlinkSync(path);
    } catch {}
    this.lockToken = undefined;
  }
  save(session: Session): void {
    if (!this.lockToken) throw new Error('Session storage requires the workspace lock');
    if (session.workspace !== this.workspace || !/^[\da-f-]{36}$/.test(session.id))
      throw new Error('Invalid session identity');
    launchBriefSchema.optional().parse(session.launchBrief);
    validatePlanHistory(session);
    validateQuestionHistory(session.messages);
    freezeLegacyQuestions(session.messages);
    const folder = join(this.directory, session.id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (this.preserveOriginal.has(session.id)) {
      copyFileSync(
        join(folder, 'session.json'),
        join(folder, `invalid-auxiliary-${randomUUID()}.json`),
      );
      this.preserveOriginal.delete(session.id);
    }
    session.updatedAt = new Date().toISOString();
    // The provider-reference commit is the last fallible write. A latest-index
    // failure must not report a failed swap after session.json already changed.
    if (existsSync(join(folder, 'session.json'))) {
      atomicJson(join(this.directory, 'latest.json'), { id: session.id });
      atomicJson(join(folder, 'session.json'), session);
    } else {
      atomicJson(join(folder, 'session.json'), session);
      atomicJson(join(this.directory, 'latest.json'), { id: session.id });
    }
    // Saved references are authoritative. Reconciliation is derivable and may
    // safely retry on the next save/start, so it must not turn a committed
    // message into an indeterminate failed acknowledgement.
    try {
      this.attachments.reconcile(session.id, session.messages, session.composerAttachments ?? []);
    } catch {}
  }
  load(id?: string): Session | undefined {
    if (!id) {
      const latest = join(this.directory, 'latest.json');
      if (!existsSync(latest)) return undefined;
      id = JSON.parse(readFileSync(latest, 'utf8')).id;
    }
    if (!id || !/^[\da-f-]{36}$/.test(id)) throw new Error('Invalid saved session ID');
    const session = JSON.parse(
      readFileSync(join(this.directory, id, 'session.json'), 'utf8'),
    ) as Session;
    if (
      !savedSession.safeParse(session).success ||
      session.id !== id ||
      session.workspace !== this.workspace ||
      !Array.isArray(session.messages) ||
      !session.agents ||
      !session.exchanges ||
      !Array.isArray(session.notices)
    )
      throw new Error('Saved session is invalid or unsupported; it has not been overwritten');
    if (
      session.messages.some(
        (m, i) =>
          typeof m.text !== 'string' ||
          typeof m.author !== 'string' ||
          !Array.isArray(m.roots) ||
          !Array.isArray(m.recipients) ||
          !m.deliveries ||
          m.sequence !== i + 1 ||
          m.id !== `m${i + 1}` ||
          (m.question !== undefined &&
            (m.author === 'human' ||
              m.recipients.length !== 1 ||
              m.recipients[0] !== 'human' ||
              new Set(m.question.choices).size !== m.question.choices.length ||
              m.question.choices.some((choice) => choice !== choice.trim()))) ||
          m.roots.some(
            (root) =>
              !session.exchanges[root] ||
              session.messages.find((parent) => parent.id === root)?.author !== 'human',
          ) ||
          m.replyTo.some(
            (parent) => !session.messages.slice(0, i).some((message) => message.id === parent),
          ) ||
          (() => {
            try {
              validateAttachmentSet(m.attachments ?? []);
              return false;
            } catch {
              return true;
            }
          })(),
      ) ||
      new Set(session.messages.map((m) => m.id)).size !== session.messages.length
    )
      throw new Error('Saved message history is invalid; it has not been overwritten');
    try {
      validateAttachmentSet(session.composerAttachments ?? []);
    } catch {
      throw new Error('Saved attachment draft is invalid; it has not been overwritten');
    }
    if (session.composerDraftVersions && Object.keys(session.composerDraftVersions).length > 1000)
      throw new Error('Saved attachment draft writers are invalid; it has not been overwritten');
    if (
      session.pinnedMessageIds &&
      (new Set(session.pinnedMessageIds).size !== session.pinnedMessageIds.length ||
        session.pinnedMessageIds.some(
          (id) => !session.messages.some((message) => message.id === id),
        ))
    )
      throw new Error('Saved message pins are invalid; the session has not been overwritten');
    validatePlanHistory(session);
    validateQuestionHistory(session.messages);
    // Migrate the original record before auxiliary recovery changes it in memory.
    // Loading/listing must not select a different latest session or change its timestamp.
    if (freezeLegacyQuestions(session.messages) && this.lockToken)
      atomicJson(join(this.directory, id, 'session.json'), session);
    const invalid = (detail: string) => {
      this.preserveOriginal.add(session.id);
      session.notices.push({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        text: `Invalid saved ${detail}. The original file will be retained for diagnosis; valid conversation history remains available.`,
      });
    };
    if (session.checkpoints !== undefined) {
      const candidates = session.checkpoints;
      session.checkpoints = [];
      if (!Array.isArray(candidates)) invalid('checkpoints');
      else
        for (const candidate of candidates) {
          try {
            const checkpoint = parseCheckpoint(candidate, session.messages);
            const previous = session.checkpoints.at(-1);
            if (
              previous &&
              (checkpoint.version <= previous.version || checkpoint.through < previous.through)
            )
              throw new Error('Checkpoint version or coverage moved backward');
            session.checkpoints.push(checkpoint);
          } catch {
            invalid('checkpoint record');
          }
        }
    }
    if (session.handoffs !== undefined) {
      const candidates = session.handoffs;
      session.handoffs = {};
      if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates))
        invalid('continuation notes');
      else
        for (const [agent, candidate] of Object.entries(candidates)) {
          try {
            session.handoffs[agent] = parseHandoff(candidate, agent, session.messages);
          } catch {
            invalid(`continuation note for @${agent}`);
          }
        }
    }
    for (const [id, state] of Object.entries(session.agents)) {
      if (
        state.checkpointVersion !== undefined &&
        !session.checkpoints?.some((checkpoint) => checkpoint.version === state.checkpointVersion)
      ) {
        delete state.checkpointVersion;
        invalid(`checkpoint reference for @${id}`);
      }
      if (state.maintenance !== undefined) {
        const parsed = maintenanceStateSchema.safeParse(state.maintenance);
        if (
          !parsed.success ||
          parsed.data.agent !== id ||
          (parsed.data.checkpointVersion !== undefined &&
            !session.checkpoints?.some(
              (checkpoint) => checkpoint.version === parsed.data.checkpointVersion,
            ))
        ) {
          if ((state.maintenance as unknown as { agent?: unknown })?.agent !== id)
            session.recoveryRequired = true;
          delete state.maintenance;
          state.recoveryRequired = true;
          invalid(`maintenance state for @${id}; explicit recovery is required`);
        } else state.maintenance = parsed.data;
      }
      if (state.recoveryRequired !== undefined && typeof state.recoveryRequired !== 'boolean') {
        state.recoveryRequired = true;
        invalid(`recovery hold for @${id}`);
      }
    }
    if (session.recoveryRequired !== undefined && typeof session.recoveryRequired !== 'boolean') {
      session.recoveryRequired = true;
      invalid('room recovery hold');
    }
    return session;
  }
  list(): SessionSummary[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((name) => /^[\da-f-]{36}$/.test(name))
      .map((id) => {
        const s = this.load(id)!;
        return {
          id,
          updatedAt: s.updatedAt,
          preview: (() => {
            const first = s.messages.find((m) => m.author === 'human' && !m.planAction);
            if (!first) return 'Empty conversation';
            return (
              first.text.slice(0, 80) ||
              `[Image: ${first.attachments?.[0]?.filename ?? 'attachment'}]`
            );
          })(),
          count: s.messages.length,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  stageAttachment(input: StageAttachmentInput) {
    if (!this.lockToken) throw new Error('Session storage requires the workspace lock');
    return this.attachments.stage(input);
  }
  attachmentAccess(sessionId: string): AttachmentAccess {
    return this.attachments.access(sessionId);
  }
  cleanupAttachments(now = Date.now()) {
    if (!this.lockToken) throw new Error('Session storage requires the workspace lock');
    return this.attachments.cleanup(now);
  }
}
