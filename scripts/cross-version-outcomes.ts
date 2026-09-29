import { createHash } from 'node:crypto';

// #58 pass rules for the new-build/previous-build/new-build storage cycle. The
// driver in scripts/cross-version-cycle.ts only gathers observations; every
// judgement about them is made here, so test/cross-version-outcomes.test.ts can
// hold the rules to a case table without launching either build.
//
// A cycle is directly compatible only when every process was orderly and opened
// the session it was told to, every saved session differs from its comparison
// record by nothing except the edits the driver made on purpose and the named
// housekeeping keys, the draft concurrency state is still valid, and every
// expected attachment is a live index entry that resolves to its original bytes.

export interface AttachmentReference {
  id: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
}
export interface SessionObservation {
  sessionId: string;
  /** Digest of each whole saved message, in order, so nothing inside one can drift unseen. */
  messageDigests: string[];
  messages: { id: string; author: string; text: string; attachmentIds: string[] }[];
  draftText: string;
  draftAttachments: AttachmentReference[];
  draftRevision: unknown;
  draftWriters: unknown;
  pinnedMessageIds: string[];
  /** The follow-up budget of every exchange, by root message ID. */
  exchanges: Record<string, unknown>;
  /** Digest of every other top-level key, so an unexpected change anywhere is visible. */
  otherKeys: Record<string, string>;
}
export type IntendedEdit =
  | { kind: 'draft-text'; sessionId: string; build: 'previous' | 'new'; text: string }
  | { kind: 'pin'; sessionId: string; build: 'previous' | 'new'; messageId: string }
  // A previous-build send: one more human text message, and that build clears the draft text.
  | { kind: 'text-message'; sessionId: string; build: 'previous'; text: string };
export interface Difference {
  sessionId: string;
  path: string;
  expected: unknown;
  observed: unknown;
}
export interface StoredAttachment {
  sessionId: string;
  id: string;
  indexed: boolean;
  orphanedAt?: string;
  indexSha256?: string;
  /** What the candidate's own store returned for this ID, hashed by the driver. */
  resolvedSha256?: string;
  resolvedByteSize?: number;
  resolveError?: string;
}
export interface ExpectedAttachment {
  sessionId: string;
  id: string;
  sha256: string;
  byteSize: number;
  use: 'sent' | 'draft';
}
export interface ProcessObservation {
  step: string;
  pid?: number;
  build: 'previous' | 'new';
  entry: 'terminal' | 'browser';
  exitCode: number | null;
  /** True when the driver had to signal the process; an orderly close never needs it. */
  terminated: boolean;
  lockPresentAfterExit: boolean;
  expectedSessionId?: string;
  openedSessionId?: string;
  createdSessionIds: string[];
}

// Keys a build rewrites on every ordinary open and save. They carry no user content.
const housekeeping = new Set(['updatedAt', 'notices']);
const observedDirectly = new Set([
  'id',
  'messages',
  'composerDraft',
  'composerAttachments',
  'composerDraftRevision',
  'composerDraftVersions',
  'pinnedMessageIds',
  'exchanges',
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

/** The comparison record of one saved session.json, parsed but otherwise untouched. */
export function observeSession(saved: Record<string, unknown>): SessionObservation {
  const messages = Array.isArray(saved.messages) ? (saved.messages as any[]) : [];
  return {
    sessionId: String(saved.id),
    messageDigests: messages.map(digest),
    messages: messages.map((message) => ({
      id: String(message.id),
      author: String(message.author),
      text: String(message.text),
      attachmentIds: (message.attachments ?? []).map((item: AttachmentReference) => item.id),
    })),
    draftText: typeof saved.composerDraft === 'string' ? saved.composerDraft : '',
    draftAttachments: structuredClone((saved.composerAttachments ?? []) as AttachmentReference[]),
    draftRevision: saved.composerDraftRevision,
    draftWriters: saved.composerDraftVersions,
    pinnedMessageIds: [...((saved.pinnedMessageIds ?? []) as string[])],
    exchanges: structuredClone((saved.exchanges ?? {}) as Record<string, unknown>),
    otherKeys: Object.fromEntries(
      Object.entries(saved)
        .filter(([key]) => !observedDirectly.has(key) && !housekeeping.has(key))
        .map(([key, value]) => [key, digest(value)]),
    ),
  };
}

/**
 * Differences between the comparison record and a later observation that the
 * listed edits do not account for. An edit the observation does not show is a
 * difference too: an unsaved old-build edit is lost work, not preservation.
 */
export function unexpectedDifferences(
  baseline: SessionObservation,
  observed: SessionObservation,
  edits: IntendedEdit[],
): Difference[] {
  const sessionId = baseline.sessionId;
  const mine = edits.filter((edit) => edit.sessionId === sessionId);
  const found: Difference[] = [];
  const differ = (path: string, expected: unknown, actual: unknown) => {
    if (canonical(expected) !== canonical(actual))
      found.push({ sessionId, path, expected, observed: actual });
  };
  differ('id', sessionId, observed.sessionId);

  const sent = mine.filter((edit) => edit.kind === 'text-message');
  differ('messages.length', baseline.messages.length + sent.length, observed.messages.length);
  baseline.messageDigests.forEach((expected, index) =>
    differ(`messages[${index}]`, expected, observed.messageDigests[index]),
  );
  sent.forEach((edit, index) => {
    const message = observed.messages[baseline.messages.length + index];
    differ(
      `messages[${baseline.messages.length + index}]`,
      { author: 'human', text: edit.text, attachmentIds: [] },
      message && {
        author: message.author,
        text: message.text,
        attachmentIds: message.attachmentIds,
      },
    );
  });

  // The last edit that touches the draft text decides it; a send clears it.
  let draftText = baseline.draftText;
  for (const edit of mine) {
    if (edit.kind === 'draft-text') draftText = edit.text;
    if (edit.kind === 'text-message') draftText = '';
  }
  differ('composerDraft', draftText, observed.draftText);
  differ('composerAttachments', baseline.draftAttachments, observed.draftAttachments);
  // The previous build has no revision counter, so its edits must leave this state
  // exactly as found. A new-build draft edit moves it, and only forward: the revision
  // advances, and every writer the room already knew keeps a counter no lower than
  // before. A reset would let a stale or repeated draft operation through.
  if (!mine.some((edit) => edit.build === 'new' && edit.kind === 'draft-text')) {
    differ('composerDraftRevision', baseline.draftRevision, observed.draftRevision);
    differ('composerDraftVersions', baseline.draftWriters, observed.draftWriters);
  } else {
    const before = typeof baseline.draftRevision === 'number' ? baseline.draftRevision : -1;
    if (!(typeof observed.draftRevision === 'number' && observed.draftRevision > before))
      found.push({
        sessionId,
        path: 'composerDraftRevision',
        expected: `greater than ${before}`,
        observed: observed.draftRevision,
      });
    const writers = (value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const now = writers(observed.draftWriters);
    for (const [writer, version] of Object.entries(writers(baseline.draftWriters))) {
      const kept = now[writer];
      if (!(typeof kept === 'number' && typeof version === 'number' && kept >= version))
        found.push({
          sessionId,
          path: 'composerDraftVersions',
          expected: `writer kept at ${String(version)} or later`,
          observed: kept,
        });
    }
  }
  differ(
    'pinnedMessageIds',
    [
      ...baseline.pinnedMessageIds,
      ...mine.flatMap((edit) => (edit.kind === 'pin' ? [edit.messageId] : [])),
    ],
    observed.pinnedMessageIds,
  );
  // A send opens one unused exchange for its own root message. Every exchange that
  // already existed keeps its budget, and nothing else is added.
  const opened = Object.fromEntries(
    sent.map((_, index) => {
      const position = baseline.messages.length + index;
      const root = observed.messages[position]?.id ?? `m${position + 1}`;
      const budget = observed.exchanges[root] as { used?: unknown; allowance?: unknown };
      const unused =
        budget?.used === 0 &&
        typeof budget.allowance === 'number' &&
        Number.isInteger(budget.allowance) &&
        budget.allowance > 0;
      // A missing or already spent exchange can never equal this placeholder.
      return [root, unused ? budget : { used: 0, allowance: 'a positive integer' }];
    }),
  );
  differ('exchanges', { ...baseline.exchanges, ...opened }, observed.exchanges);
  const keys = new Set([...Object.keys(baseline.otherKeys), ...Object.keys(observed.otherKeys)]);
  for (const key of keys) differ(key, baseline.otherKeys[key], observed.otherKeys[key]);
  return found;
}

/** The saved draft concurrency state the candidate's store accepts on load. */
export function draftConcurrencyProblems(observed: SessionObservation): string[] {
  const problems: string[] = [];
  const counter = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (observed.draftRevision !== undefined && !counter(observed.draftRevision))
    problems.push(`${observed.sessionId}: draft revision is not a non-negative safe integer`);
  if (observed.draftWriters !== undefined) {
    const writers = observed.draftWriters;
    if (!writers || typeof writers !== 'object' || Array.isArray(writers))
      problems.push(`${observed.sessionId}: draft writers is not a record`);
    else {
      const entries = Object.entries(writers as Record<string, unknown>);
      if (entries.length > 1000)
        problems.push(`${observed.sessionId}: more than 1000 draft writers`);
      for (const [writer, version] of entries)
        if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(writer) || !counter(version))
          problems.push(`${observed.sessionId}: invalid draft writer entry`);
    }
  }
  return problems;
}

/**
 * Every expected attachment must be a live index entry — present, with no
 * orphanedAt — that the store resolves to the original hash and size. A blob
 * that merely still exists inside the 24-hour orphan grace proves nothing.
 */
export function survivalProblems(
  expected: ExpectedAttachment[],
  stored: StoredAttachment[],
): string[] {
  const problems: string[] = [];
  for (const want of expected) {
    const name = `${want.sessionId} ${want.use} ${want.id}`;
    const have = stored.find((item) => item.sessionId === want.sessionId && item.id === want.id);
    if (!have || !have.indexed) {
      problems.push(`${name}: missing from attachments/index.json`);
      continue;
    }
    if (have.orphanedAt !== undefined) problems.push(`${name}: marked orphaned in the index`);
    if (have.indexSha256 !== want.sha256) problems.push(`${name}: index hash changed`);
    if (have.resolveError !== undefined) problems.push(`${name}: store could not resolve it`);
    else if (have.resolvedSha256 !== want.sha256 || have.resolvedByteSize !== want.byteSize)
      problems.push(`${name}: resolved bytes differ from the original`);
  }
  return problems;
}

/** An orderly ownership transition that opened exactly the session it was asked to. */
export function processProblems(processes: ProcessObservation[]): string[] {
  const problems: string[] = [];
  for (const run of processes) {
    if (run.exitCode !== 0) problems.push(`${run.step}: exit code ${run.exitCode}`);
    if (run.terminated) problems.push(`${run.step}: had to be terminated`);
    if (run.lockPresentAfterExit) problems.push(`${run.step}: workspace lock left behind`);
    if (run.expectedSessionId !== undefined) {
      // A plain launch that starts a different session is no compatibility evidence.
      if (run.openedSessionId !== run.expectedSessionId)
        problems.push(`${run.step}: did not open the requested session`);
      if (run.createdSessionIds.length)
        problems.push(`${run.step}: created a session instead of reopening one`);
    }
  }
  return problems;
}

export interface CycleJudgement {
  verdict: 'direct-compatible' | 'direct-incompatible';
  problems: string[];
}
export function judgeCycle(input: {
  processes: ProcessObservation[];
  differences: Difference[];
  concurrency: string[];
  survival: string[];
  /** Same checks, after cleanupAttachments ran more than 24 hours ahead on a copy. */
  beyondGrace: string[];
  /**
   * The control: an image staged and then removed from its draft. It must still be
   * indexed, orphaned, after the cycle, and that same cleanup run must delete it.
   * Otherwise the time-controlled run never showed it can delete anything.
   */
  controlOrphan: { orphanedAfterCycle: boolean; removedBeyondGrace: boolean };
  sameSessionDirectory: boolean;
}): CycleJudgement {
  const problems = [
    ...processProblems(input.processes),
    ...input.differences.map(
      (difference) => `${difference.sessionId}: unexpected change at ${difference.path}`,
    ),
    ...input.concurrency,
    ...input.survival,
    ...input.beyondGrace.map((problem) => `beyond orphan grace: ${problem}`),
    ...(input.controlOrphan.orphanedAfterCycle
      ? []
      : ['control: the removed image was not an orphaned index entry after the cycle']),
    ...(input.controlOrphan.removedBeyondGrace
      ? []
      : ['control: cleanup beyond orphan grace did not delete the removed image']),
    ...(input.sameSessionDirectory ? [] : ['builds resolved different session directories']),
  ];
  return { verdict: problems.length ? 'direct-incompatible' : 'direct-compatible', problems };
}
