import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { Message, Session } from './types.js';
import type {
  Plan,
  PlanAction,
  PlanActionRecord,
  PlanContribution,
  PlanEntry,
  PlanReference,
} from './plan-types.js';
import { planBytes, planLimits, planReference, planReserve, planView } from './plan-view.js';
import { publicMessage } from './checkpoint.js';

const id = z.string().regex(/^m[1-9]\d{0,15}$/);
const entryId = z.string().regex(/^p[1-9]\d{0,15}$/);
const proposalId = z.string().regex(/^r[1-9]\d{0,15}$/);
const revision = z.number().int().positive().safe();
const category = z.enum(['approach', 'objection', 'question']);
// Byte budgets bound sources together with their content, including the host-added source.
const sourceIds = z.array(id);
const markdown = z
  .string()
  .min(1)
  .max(65536)
  .refine((s) => !!s.trim(), 'Plan text cannot be empty');
export const planContributionSchema = z
  .object({
    kind: z.enum(['add', 'revise', 'comment']),
    category: category.nullable(),
    entryId: entryId.nullable(),
    baseRevision: revision.nullable(),
    markdown: markdown.nullable(),
    sourceIds,
    roomQuestionId: z.union([id, z.literal('self')]).nullable(),
  })
  .strict();
const target = { entryId, revision };
export const planActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('focus'), enabled: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('add'),
      category,
      markdown,
      sourceIds,
      roomQuestionId: id.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('edit'), ...target, markdown, sourceIds }).strict(),
  z.object({ kind: z.literal('withdraw'), ...target }).strict(),
  z.object({ kind: z.literal('agree'), ...target }).strict(),
  z
    .object({
      kind: z.literal('resolve'),
      ...target,
      explanation: z.string().trim().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reopen'),
      ...target,
      explanation: z.string().trim().min(1).max(1024),
    })
    .strict(),
  z.object({ kind: z.literal('adopt'), proposalId, ...target }).strict(),
  z.object({ kind: z.literal('adopt-agree'), proposalId, ...target }).strict(),
  z.object({ kind: z.literal('reject'), proposalId }).strict(),
  z
    .object({ kind: z.literal('agree-all'), revision: z.number().int().nonnegative().safe() })
    .strict(),
  z
    .object({
      kind: z.literal('comment'),
      ...target,
      text: z
        .string()
        .trim()
        .min(1)
        .max(65536)
        .refine((text) => Buffer.byteLength(text) <= 65536, 'Message exceeds the limit of 64 KiB'),
    })
    .strict(),
]);
const referenceSchema = z.object({ entryId, revision, messageId: id }).strict();
const entrySchema = z
  .object({
    id: entryId,
    revision,
    category,
    markdown,
    author: z.string().min(1).max(128),
    sourceIds,
    messageId: id,
    status: z.enum(['proposed', 'agreed', 'open', 'resolved']),
    agreementId: id.optional(),
    roomQuestionId: id.optional(),
  })
  .strict();
const proposalSchema = z
  .object({
    id: proposalId,
    target: referenceSchema,
    markdown,
    author: z.string().min(1).max(128),
    sourceIds,
    messageId: id,
  })
  .strict();
const planSchema = z
  .object({
    focus: z.boolean(),
    revision: z.number().int().nonnegative().safe(),
    nextEntry: revision,
    nextProposal: revision,
    entries: z.array(entrySchema),
    proposals: z.array(proposalSchema),
    agreement: z.object({ messageId: id, revision: revision }).strict().optional(),
  })
  .strict();
const actionRecordSchema = z
  .object({
    kind: z.enum([
      'focus',
      'add',
      'edit',
      'withdraw',
      'agree',
      'resolve',
      'reopen',
      'adopt',
      'adopt-agree',
      'reject',
      'agree-all',
    ]),
    humanName: z.string().min(1).max(256),
    planRevision: z.number().int().nonnegative().safe(),
    entries: z.array(entrySchema),
    proposals: z.array(z.object({ id: proposalId, messageId: id }).strict()),
    outstanding: z
      .object({
        objections: z.array(entryId),
        questions: z.array(entryId),
        proposals: z.array(proposalId),
      })
      .strict(),
    focus: z.boolean().optional(),
    explanation: z.string().min(1).max(1024).optional(),
  })
  .strict();
const contributionRecordSchema = z
  .object({
    input: planContributionSchema,
    status: z.enum(['added', 'pending', 'stale', 'not-applicable', 'comment', 'capacity']),
    reference: referenceSchema.optional(),
    proposalId: proposalId.optional(),
  })
  .strict();
export class PlanConflictError extends Error {}
export class PlanCapacityError extends Error {
  constructor() {
    super(
      'Plan capacity exceeded. Shorten an entry, reject a proposal or withdraw an entry; your text has been kept.',
    );
  }
}
export const emptyPlan = (): Plan => ({
  focus: false,
  revision: 0,
  nextEntry: 1,
  nextProposal: 1,
  entries: [],
  proposals: [],
});
function sources(ids: string[], history: readonly Message[], own?: string): string[] {
  if (new Set(ids).size !== ids.length || ids.some((value) => !history.some((m) => m.id === value)))
    throw new Error('Invalid plan public source IDs');
  return [...new Set([...ids, ...(own ? [own] : [])])];
}
function checkQuestion(
  questionId: string | undefined,
  category: string,
  history: readonly Message[],
): void {
  if (
    questionId &&
    (category !== 'question' || !history.some((m) => m.id === questionId && m.question))
  )
    throw new Error('A plan question must link to a public room question');
}
function changed(plan: Plan): void {
  if (!Number.isSafeInteger(++plan.revision)) throw new Error('Plan revision limit reached');
}
export function checkPlanCapacity(plan: Plan, history: readonly Message[], reserve = true): void {
  const view = planView(plan, history)!;
  const extra = reserve ? planReserve(plan) : 0;
  if (planBytes(plan) + extra > planLimits.live || planBytes(view) + extra > planLimits.view)
    throw new PlanCapacityError();
}
function current(plan: Plan, wanted: { entryId: string; revision: number }): PlanEntry {
  const entry = plan.entries.find((e) => e.id === wanted.entryId);
  if (!entry || entry.revision !== wanted.revision)
    throw new PlanConflictError(
      'Plan entry changed or was withdrawn. Refresh and review it before trying again.',
    );
  return entry;
}
/** Find the immutable locator for an issued revision, including withdrawn content. */
export function findPlanReference(
  history: readonly Message[],
  wanted: { entryId: string; revision: number },
): PlanReference {
  for (const message of history) {
    const entry = message.planAction?.entries.find(
      (e) => e.id === wanted.entryId && e.revision === wanted.revision,
    );
    if (entry) return planReference(entry);
    const record = message.planContribution;
    if (
      record?.status === 'added' &&
      record.reference?.entryId === wanted.entryId &&
      record.reference.revision === wanted.revision
    )
      return { ...record.reference };
  }
  throw new Error('Unknown plan entry or impossible revision');
}
function outstanding(plan: Plan): PlanActionRecord['outstanding'] {
  return {
    objections: plan.entries
      .filter((e) => e.category === 'objection' && e.status === 'open')
      .map((e) => e.id),
    questions: plan.entries
      .filter((e) => e.category === 'question' && e.status === 'open')
      .map((e) => e.id),
    proposals: plan.proposals.map((p) => p.id),
  };
}
function add(
  plan: Plan,
  kind: PlanEntry['category'],
  text: string,
  author: string,
  source: string[],
  messageId: string,
  roomQuestionId?: string,
): PlanEntry {
  if (!Number.isSafeInteger(plan.nextEntry + 1)) throw new Error('Plan entry ID limit reached');
  const entry: PlanEntry = {
    id: `p${plan.nextEntry++}`,
    revision: 1,
    category: kind,
    markdown: text,
    author,
    sourceIds: source,
    messageId,
    status: kind === 'approach' ? 'proposed' : 'open',
    ...(roomQuestionId ? { roomQuestionId } : {}),
  };
  plan.entries.push(entry);
  return entry;
}
function edit(
  entry: PlanEntry,
  text: string,
  author: string,
  source: string[],
  messageId: string,
): void {
  if (!Number.isSafeInteger(++entry.revision)) throw new Error('Plan entry revision limit reached');
  Object.assign(entry, { markdown: text, author, sourceIds: source, messageId });
  if (entry.category === 'approach') entry.status = 'proposed';
  delete entry.agreementId;
}
/** Mutates only the caller's unsaved candidate and its new human message. */
export function applyPlanAction(
  session: Session,
  input: PlanAction,
  message: Message,
  humanName: string,
): void {
  const action = planActionSchema.parse(input);
  if (action.kind === 'comment') {
    message.planReference = findPlanReference(session.messages.slice(0, -1), action);
    return;
  }
  const plan = (session.plan ??= emptyPlan());
  const before = structuredClone(plan);
  const history = session.messages.slice(0, -1);
  const record: PlanActionRecord = {
    kind: action.kind,
    humanName,
    planRevision: plan.revision,
    entries: [],
    proposals: [],
    outstanding: outstanding(plan),
  };
  if (action.kind === 'focus') {
    plan.focus = action.enabled;
    record.focus = action.enabled;
  } else if (action.kind === 'add') {
    checkQuestion(action.roomQuestionId, action.category, history);
    record.entries.push(
      add(
        plan,
        action.category,
        action.markdown,
        'human',
        sources(action.sourceIds, history, message.id),
        message.id,
        action.roomQuestionId,
      ),
    );
    changed(plan);
  } else if (action.kind === 'agree-all') {
    if (plan.revision !== action.revision)
      throw new PlanConflictError('Plan changed. Review the refreshed plan before agreeing to it.');
    for (const entry of plan.entries.filter((e) => e.category === 'approach')) {
      entry.status = 'agreed';
      entry.agreementId = message.id;
      record.entries.push(entry);
    }
    changed(plan);
    plan.agreement = { messageId: message.id, revision: plan.revision };
  } else if (action.kind === 'reject') {
    const proposal = plan.proposals.find((p) => p.id === action.proposalId);
    if (!proposal)
      throw new PlanConflictError('Proposal is no longer pending. Refresh before trying again.');
    record.proposals.push({ id: proposal.id, messageId: proposal.messageId });
    plan.proposals = plan.proposals.filter((p) => p !== proposal);
    changed(plan);
  } else {
    const entry = current(plan, action);
    if (action.kind === 'withdraw') {
      record.entries.push(entry);
      plan.entries = plan.entries.filter((e) => e !== entry);
    } else {
      if (action.kind === 'edit')
        edit(
          entry,
          action.markdown,
          'human',
          sources(action.sourceIds, history, message.id),
          message.id,
        );
      if (action.kind === 'adopt' || action.kind === 'adopt-agree') {
        const proposal = plan.proposals.find((p) => p.id === action.proposalId);
        if (
          !proposal ||
          proposal.target.entryId !== entry.id ||
          proposal.target.revision !== entry.revision
        )
          throw new PlanConflictError(
            'Proposal is stale or no longer pending. Re-propose against the current revision or edit it explicitly.',
          );
        if (action.kind === 'adopt-agree' && entry.category !== 'approach')
          throw new Error('Only approach entries can be agreed');
        edit(entry, proposal.markdown, proposal.author, proposal.sourceIds, message.id);
        record.proposals.push({ id: proposal.id, messageId: proposal.messageId });
        plan.proposals = plan.proposals.filter((p) => p !== proposal);
      }
      if (action.kind === 'agree' || action.kind === 'adopt-agree') {
        if (entry.category !== 'approach') throw new Error('Only approach entries can be agreed');
        entry.status = 'agreed';
        entry.agreementId = message.id;
      }
      if (action.kind === 'resolve' || action.kind === 'reopen') {
        if (entry.category === 'approach')
          throw new Error('Only objections and questions can be resolved or reopened');
        if (entry.status !== (action.kind === 'resolve' ? 'open' : 'resolved'))
          throw new PlanConflictError('Entry status changed. Refresh before trying again.');
        entry.status = action.kind === 'resolve' ? 'resolved' : 'open';
        record.explanation = action.explanation;
      }
      record.entries.push(entry);
    }
    changed(plan);
  }
  record.planRevision = plan.revision;
  record.outstanding = outstanding(plan);
  message.planAction = structuredClone(record);
  message.text = `Plan: ${action.kind}${record.entries.length ? ' ' + record.entries.map((e) => `${e.id}@${e.revision}`).join(', ') : ''}${record.proposals.length ? ' ' + record.proposals.map((p) => p.id).join(', ') : ''}${record.explanation ? ' — ' + record.explanation : ''}`;
  message.deliveries = {};
  // Reclamation and bookkeeping use the space reserved when content was admitted.
  const grows =
    action.kind === 'add' ||
    action.kind === 'adopt' ||
    action.kind === 'adopt-agree' ||
    (action.kind === 'edit' && planBytes(plan) > planBytes(before));
  checkPlanCapacity(plan, session.messages, grows);
  if (planBytes(publicMessage(message)) > planLimits.action) throw new PlanCapacityError();
}

export function normalizePlanContribution(value: PlanContribution): PlanContribution {
  const input = planContributionSchema.parse(value);
  if (planBytes(input) > planLimits.contribution) throw new Error('Plan metadata exceeds 8 KiB');
  if (input.kind === 'add') {
    if (
      !input.category ||
      input.entryId !== null ||
      input.baseRevision !== null ||
      input.markdown === null ||
      (input.roomQuestionId && input.category !== 'question')
    )
      throw new Error('Invalid plan addition metadata');
  } else if (
    !input.entryId ||
    !input.baseRevision ||
    input.category !== null ||
    input.roomQuestionId !== null ||
    (input.kind === 'comment' ? input.markdown !== null : input.markdown === null)
  )
    throw new Error('Invalid plan revision or comment metadata');
  return input;
}

/** Called for every reply on an isolated, ordered result candidate before publication. */
export function applyPlanContribution(
  session: Session,
  raw: PlanContribution,
  message: Message,
  turnHistory: readonly Message[],
): void {
  const input = normalizePlanContribution(raw);
  const cited = sources(input.sourceIds, turnHistory, message.id);
  let reference: PlanReference | undefined;
  if (input.kind !== 'add')
    reference = findPlanReference(turnHistory, {
      entryId: input.entryId!,
      revision: input.baseRevision!,
    });
  const questionId =
    input.roomQuestionId === 'self' ? message.id : (input.roomQuestionId ?? undefined);
  checkQuestion(questionId, input.category ?? '', [...turnHistory, message]);
  const record: NonNullable<Message['planContribution']> = {
    input: structuredClone(input),
    status: 'comment',
    ...(reference ? { reference } : {}),
  };
  message.planContribution = record;
  if (input.kind === 'comment') {
    message.planReference = reference;
    return;
  }
  const candidate = structuredClone(session.plan ?? emptyPlan());
  if (input.kind === 'add') {
    const entry = add(
      candidate,
      input.category!,
      input.markdown!,
      message.author,
      cited,
      message.id,
      questionId,
    );
    record.reference = planReference(entry);
    record.status = 'added';
  } else {
    const entry = candidate.entries.find((e) => e.id === input.entryId);
    record.status = !entry
      ? 'not-applicable'
      : entry.revision !== input.baseRevision
        ? 'stale'
        : 'pending';
    if (!entry) return;
    if (!Number.isSafeInteger(candidate.nextProposal + 1))
      throw new Error('Plan proposal ID limit reached');
    record.proposalId = `r${candidate.nextProposal++}`;
    candidate.proposals.push({
      id: record.proposalId,
      target: reference!,
      markdown: input.markdown!,
      author: message.author,
      sourceIds: cited,
      messageId: message.id,
    });
  }
  changed(candidate);
  try {
    checkPlanCapacity(candidate, session.messages);
  } catch (error) {
    if (!(error instanceof PlanCapacityError)) throw error;
    record.status = 'capacity';
    delete record.proposalId;
    if (input.kind === 'add') delete record.reference;
    return;
  }
  session.plan = candidate;
}

/** Reconstruct the small current record from typed public evidence and compare it exactly. */
export function validatePlanHistory(session: Session): void {
  try {
    if (
      session.plan === undefined &&
      !session.messages.some(
        (m) =>
          m.planAction !== undefined ||
          m.planContribution !== undefined ||
          m.planReference !== undefined,
      )
    )
      return;
    if (session.plan !== undefined) planSchema.parse(session.plan);
    const replay: Session = { ...session, plan: undefined, messages: [] };
    for (const original of session.messages) {
      const message = structuredClone(original);
      delete message.planAction;
      delete message.planContribution;
      delete message.planReference;
      const previous = [...replay.messages];
      replay.messages.push(message);
      if (original.planAction !== undefined) {
        if (planBytes(publicMessage(original)) > planLimits.action) throw new PlanCapacityError();
        const record = actionRecordSchema.parse(original.planAction);
        if (
          original.author !== 'human' ||
          Object.keys(original.deliveries).length ||
          original.question ||
          original.finalAnswer ||
          original.consultation ||
          original.recommendation ||
          original.planContribution ||
          original.planReference ||
          original.attachments?.length ||
          original.recipients.length ||
          original.replyTo.length ||
          !isDeepStrictEqual(original.roots, [original.id]) ||
          !session.exchanges[original.id] ||
          !z.iso.datetime().safeParse(original.createdAt).success
        )
          throw new Error('Invalid human plan action authority');
        const first = record.entries[0];
        const old = first && replay.plan?.entries.find((e) => e.id === first.id);
        let action: PlanAction;
        switch (record.kind) {
          case 'focus':
            action = { kind: record.kind, enabled: record.focus! };
            break;
          case 'add':
            action = {
              kind: 'add',
              category: first!.category,
              markdown: first!.markdown,
              sourceIds: first!.sourceIds.filter((s) => s !== message.id),
              ...(first!.roomQuestionId ? { roomQuestionId: first!.roomQuestionId } : {}),
            };
            break;
          case 'edit':
            action = {
              kind: 'edit',
              entryId: first!.id,
              revision: old!.revision,
              markdown: first!.markdown,
              sourceIds: first!.sourceIds.filter((s) => s !== message.id),
            };
            break;
          case 'agree-all':
            action = { kind: record.kind, revision: replay.plan?.revision ?? 0 };
            break;
          case 'reject':
            action = { kind: record.kind, proposalId: record.proposals[0]!.id };
            break;
          case 'adopt':
          case 'adopt-agree':
            action = {
              kind: record.kind,
              proposalId: record.proposals[0]!.id,
              entryId: first!.id,
              revision: old!.revision,
            };
            break;
          case 'resolve':
          case 'reopen':
            action = {
              kind: record.kind,
              entryId: first!.id,
              revision: first!.revision,
              explanation: record.explanation!,
            };
            break;
          default:
            action = { kind: record.kind, entryId: first!.id, revision: first!.revision };
        }
        applyPlanAction(replay, action, message, record.humanName);
        if (
          !isDeepStrictEqual(message.planAction, original.planAction) ||
          message.text !== original.text
        )
          throw new Error('Invalid frozen plan action evidence');
      }
      if (original.planContribution !== undefined) {
        contributionRecordSchema.parse(original.planContribution);
        if (
          original.author === 'human' ||
          original.consultation ||
          original.replyTo.some((id) => previous.find((m) => m.id === id)?.consultation)
        )
          throw new Error('Invalid agent plan contribution authority');
        applyPlanContribution(replay, original.planContribution.input, message, previous);
        if (!isDeepStrictEqual(message.planContribution, original.planContribution))
          throw new Error('Invalid plan contribution evidence');
      }
      if (original.planReference !== undefined) {
        const ref = referenceSchema.parse(original.planReference);
        if (!isDeepStrictEqual(ref, findPlanReference(previous, ref)))
          throw new Error('Invalid plan comment reference');
        message.planReference = ref;
      }
      if (!isDeepStrictEqual(message.planReference, original.planReference))
        throw new Error('Missing plan comment reference');
    }
    if (!isDeepStrictEqual(replay.plan, session.plan))
      throw new Error('Current plan disagrees with its public evidence');
    if (session.plan) checkPlanCapacity(session.plan, session.messages, false);
  } catch (error) {
    throw new Error(
      `Invalid saved plan: ${(error as Error).message}. The session has not been overwritten.`,
    );
  }
}
