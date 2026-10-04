/** Conversation data only. None of these records grants task permissions. */
export type PlanCategory = 'approach' | 'objection' | 'question';
export interface PlanReference {
  entryId: string;
  revision: number;
  /** Public message containing this exact revision, including archived entries. */
  messageId: string;
}
export interface PlanEntry {
  id: string;
  revision: number;
  category: PlanCategory;
  markdown: string;
  author: string;
  sourceIds: string[];
  messageId: string;
  status: 'proposed' | 'agreed' | 'open' | 'resolved';
  agreementId?: string;
  roomQuestionId?: string;
}
export interface PlanProposal {
  id: string;
  target: PlanReference;
  markdown: string;
  author: string;
  sourceIds: string[];
  messageId: string;
}
export interface Plan {
  focus: boolean;
  revision: number;
  nextEntry: number;
  nextProposal: number;
  entries: PlanEntry[];
  proposals: PlanProposal[];
  agreement?: { messageId: string; revision: number };
}
/** Flat provider metadata. Every field is required and nullable on the strict wire. */
export interface PlanContribution {
  kind: 'add' | 'revise' | 'comment';
  category: PlanCategory | null;
  entryId: string | null;
  baseRevision: number | null;
  markdown: string | null;
  sourceIds: string[];
  roomQuestionId: string | null;
}
export interface PlanContributionRecord {
  input: PlanContribution;
  status: 'added' | 'pending' | 'stale' | 'not-applicable' | 'comment' | 'capacity';
  reference?: PlanReference;
  proposalId?: string;
}
export type PlanAction =
  | { kind: 'focus'; enabled: boolean }
  | {
      kind: 'add';
      category: PlanCategory;
      markdown: string;
      sourceIds: string[];
      roomQuestionId?: string;
    }
  | { kind: 'edit'; entryId: string; revision: number; markdown: string; sourceIds: string[] }
  | { kind: 'withdraw' | 'agree'; entryId: string; revision: number }
  | { kind: 'resolve' | 'reopen'; entryId: string; revision: number; explanation: string }
  | { kind: 'adopt' | 'adopt-agree'; proposalId: string; entryId: string; revision: number }
  | { kind: 'reject'; proposalId: string }
  | { kind: 'agree-all'; revision: number }
  | { kind: 'comment'; entryId: string; revision: number; text: string };
export interface PlanActionRecord {
  kind: Exclude<PlanAction['kind'], 'comment'>;
  humanName: string;
  planRevision: number;
  /** Frozen content required for attribution, agreements and withdrawal evidence. */
  entries: PlanEntry[];
  proposals: { id: string; messageId: string }[];
  outstanding: { objections: string[]; questions: string[]; proposals: string[] };
  focus?: boolean;
  explanation?: string;
}
export interface PlanView {
  label: string;
  focus: boolean;
  guidance?: string;
  revision: number;
  entries: (PlanEntry & { roomQuestionStatus?: 'answered' | 'unanswered' })[];
  proposals: (PlanProposal & { status: 'pending' | 'stale' | 'not-applicable' })[];
  agreement?: { messageId: string; revision: number; current: boolean };
  bytes: { used: number; available: number; live: number; limit: number; reserved: number };
}
