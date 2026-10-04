import type { AttachmentMetadata } from './types.js';
import type { RoomSnapshot } from './snapshot.js';
import type { PlanAction } from './plan-types.js';

export interface WebPlanAction {
  id: string;
  sessionId: string;
  action: PlanAction;
}
export interface PlanActionResult {
  ok: boolean;
  sessionId: string;
  messageId?: string;
  error?: string;
  conflict?: boolean;
}

/** The browser wire state: the public display projection plus transport metadata. */
export type WebState = RoomSnapshot & { instanceId: string; revision: number };
export interface WebCommand {
  id: string;
  sessionId: string;
  line: string;
  attachmentIds?: string[];
  draft?: { clientId: string; version: number; baseRevision?: number };
}
/**
 * Whether command execution returned. `sent` means the controller's command ran to
 * completion, not that any agent received or answered a message. `failed` carries the
 * original command error; `operation-conflict` is the reused-operation-id rejection that
 * the HTTP transport maps to 409, and it never clears or restores a draft.
 */
export type DraftSubmissionDispatch =
  | { status: 'sent' }
  | { status: 'failed'; failure: 'command-error' | 'operation-conflict'; error: string };
/**
 * Whether the attachment operation named by the submission is recorded in the target
 * session, classified from the session record and never from recovery eligibility, a
 * version match or an error string. `committed` also covers an operation committed by an
 * earlier attempt, and may coexist with a failed dispatch. Text sends carry no operation
 * record and report `not-applicable`.
 */
export type DraftSubmissionCommitment =
  | { status: 'not-applicable' }
  | { status: 'uncommitted'; operationId: string }
  | { status: 'committed'; operationId: string };
/**
 * What happened to the submitted draft after the dispatch outcome. Successful dispatch is
 * `not-needed`. `restored` is reported only after the qualifying recovery write completed;
 * for the guarded HTTP attachment path it describes the existing unversioned re-save of the
 * current text, not restoration of the submitted caption or attachments. `skipped` names why
 * no write ran: `newer-draft` (a superseding draft blocked the guard), `conversation-changed`
 * (the selected conversation differs, including a queued recovery refused after the initial
 * guard passed) or `ineligible` (no restoration policy applies, or another guard condition
 * was unmet). `failed` retains the recovery error separately from the command error.
 */
export type DraftSubmissionRecovery =
  | { status: 'not-needed' }
  | { status: 'restored' }
  | { status: 'skipped'; reason: 'newer-draft' | 'conversation-changed' | 'ineligible' }
  | { status: 'failed'; error: string };
/**
 * The typed outcome of one composer submission through `RoomController.submitDraft`. The
 * four facts are independent and JSON-safe; a consumer reads each directly instead of
 * inferring one from another or from message history, draft counters or persistence.
 * Valid combinations include, at minimum: `sent` / `not-needed`; `failed` / `restored`;
 * `failed` / `skipped` (`newer-draft` or `conversation-changed`); `failed` / `failed`
 * (recovery error kept apart from the command error); and `failed` with `committed`
 * attachment work. `sessionId` is the controller's selected session when the operation
 * completed, including after a switching command or its failure.
 */
export interface DraftSubmissionResult {
  dispatch: DraftSubmissionDispatch;
  commitment: DraftSubmissionCommitment;
  recovery: DraftSubmissionRecovery;
  sessionId: string;
}
export interface CommandResult {
  ok: boolean;
  error?: string;
  sessionId: string;
  /** The typed submission outcome; `ok`, `error` and `sessionId` keep their meanings. */
  submission: DraftSubmissionResult;
}
export interface StageAttachmentResult {
  attachment: AttachmentMetadata;
}
