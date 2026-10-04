import type { PlanAction } from './plan-types.js';

export const planHelp = `
  /plan                          Create/show the plan and enable planning focus
  /plan off                      Stop planning focus, keeping the plan
  /plan show                     Open the transient plan view
  /plan add approach|objection|question [#source ...] [question:#mID] -- Markdown
  /plan edit pID@revision [#source ...] -- Markdown
  /plan withdraw pID@revision     Withdraw an entry, keeping public evidence
  /plan agree pID@revision        Agree to this approach revision
  /plan agree-all plan-revision   Agree to every displayed approach revision
  /plan adopt rID pID@revision    Adopt a pending proposal without agreement
  /plan adopt-agree rID pID@revision   Adopt and agree to an approach
  /plan reject rID                Reject a pending proposal, including stale ones
  /plan resolve pID@revision -- explanation
  /plan reopen pID@revision -- explanation
  /plan comment pID@revision -- [@agent ...] message
  /message #message-id            Open an exact public message, including plan evidence`;

export function parsePlanCommand(line: string): PlanAction | 'show' {
  const match = /^\/plan(?:\s+(.*))?$/s.exec(line.trim());
  if (!match) throw new Error('Use /plan. /help lists plan actions.');
  const rest = match[1]?.trim() ?? '';
  if (!rest) return { kind: 'focus', enabled: true };
  if (rest === 'off') return { kind: 'focus', enabled: false };
  if (rest === 'show') return 'show';
  const split = /^(.*?)(?:\s+--\s([\s\S]*))?$/.exec(rest)!;
  const [kind, ...args] = split[1]!.trim().split(/\s+/);
  const text = split[2];
  const target = (value?: string) => {
    const match = /^(p[1-9]\d*)@([1-9]\d*)$/.exec(value ?? '');
    if (!match) throw new Error('Specify the displayed entry and revision, for example p1@2.');
    return { entryId: match[1]!, revision: Number(match[2]) };
  };
  const sources = (values: string[]) => {
    if (values.some((v) => !/^#?m[1-9]\d*$/.test(v)))
      throw new Error('Sources must be public #message IDs. Put Markdown after --.');
    return values.map((v) => v.replace(/^#/, ''));
  };
  if (
    kind === 'add' &&
    ['approach', 'objection', 'question'].includes(args[0] ?? '') &&
    text !== undefined
  ) {
    const links = args.slice(1).filter((s) => s.startsWith('question:'));
    if (
      links.length > 1 ||
      (links.length && (args[0] !== 'question' || !/^question:#?m[1-9]\d*$/.test(links[0]!)))
    )
      throw new Error('Use one question:#message-id link on a question entry.');
    return {
      kind,
      category: args[0] as 'approach' | 'objection' | 'question',
      markdown: text,
      sourceIds: sources(args.slice(1).filter((s) => !s.startsWith('question:'))),
      ...(links[0] ? { roomQuestionId: links[0].replace(/^question:#?/, '') } : {}),
    };
  }
  if (kind === 'edit' && text !== undefined)
    return { kind, ...target(args[0]), markdown: text, sourceIds: sources(args.slice(1)) };
  if ((kind === 'withdraw' || kind === 'agree') && args.length === 1 && text === undefined)
    return { kind, ...target(args[0]) };
  if ((kind === 'resolve' || kind === 'reopen') && args.length === 1 && text !== undefined)
    return { kind, ...target(args[0]), explanation: text };
  if (kind === 'comment' && args.length === 1 && text !== undefined)
    return { kind, ...target(args[0]), text };
  if (
    (kind === 'adopt' || kind === 'adopt-agree') &&
    /^r[1-9]\d*$/.test(args[0] ?? '') &&
    args.length === 2 &&
    text === undefined
  )
    return { kind, proposalId: args[0]!, ...target(args[1]) };
  if (kind === 'reject' && args.length === 1 && /^r[1-9]\d*$/.test(args[0]!) && text === undefined)
    return { kind, proposalId: args[0]! };
  if (kind === 'agree-all' && args.length === 1 && /^\d+$/.test(args[0]!) && text === undefined)
    return { kind, revision: Number(args[0]) };
  throw new Error('Invalid /plan action. /help lists syntax; use -- before text.');
}
