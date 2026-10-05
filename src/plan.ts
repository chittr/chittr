import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isSkillPath } from './skill-access.js';
import type { PlanStateLocation, PlanTurn, SkillAccess } from './types.js';
import { planAdjectives, planNouns } from './plan-words.js';

/** A changed plan above this many bytes travels as its path and change flag only. */
export const planTextLimit = 32 * 1024;
export type { PlanStateLocation, PlanTurn } from './types.js';
export const planRules = [
  'Plan mode is on. The plan is the Markdown file at plan.path. The human reads and edits it with their own tools.',
  'Edit the plan only when the human names you and asks you to.',
  'Change only what was asked, and keep the rest of the plan as written.',
  'Say in your reply what you changed in the plan.',
  'Agreeing to the plan is not an instruction to build it.',
  'Keep decisions, open questions and objections distinct, and cite the #m messages behind them.',
  'In plan mode, read_file and write_file work on the plan path, every other write is refused, and run_command runs sandboxed without account access. This overrides the permission text you received at connection.',
  'write_file replaces the whole plan. A plan write is refused when the plan changed since you last received or read it; reread it with read_file, then retry.',
  `plan.status says whether the plan changed since your last turn. A changed plan over ${planTextLimit / 1024} KiB arrives without plan.text: read it with read_file before relying on it.`,
];

export function planHash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The per-workspace folder name: the resolved launch directory with each `/` replaced by `-`. */
export function derivedPlanFolder(workspace: string): string {
  return workspace.replaceAll('/', '-');
}
/** The folder a `plans.location` value selects. Throws for relative paths and unknown values. */
export function planFolder(location: string, workspace: string, home: string): string {
  if (location === 'user')
    return join(home, '.agents', 'chittr', 'plans', derivedPlanFolder(workspace));
  if (location === 'directory') return join(workspace, '.agents', 'chittr', 'plans');
  const expanded = location.startsWith('~/') ? join(home, location.slice(2)) : location;
  if (!isAbsolute(expanded))
    throw new Error(
      'Use user, directory, or an absolute or ~/ path; relative paths are not supported',
    );
  return join(resolve(expanded), derivedPlanFolder(workspace));
}

const pad = (value: number) => String(value).padStart(2, '0');
const pick = <T>(words: readonly T[]) => words[randomInt(words.length)]!;
/** `YYYY-MM-DD-HHMM-<word>-<word>-<word>.md` in local time. */
export function planFileName(date: Date, words: readonly [string, string, string]): string {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${stamp}-${words.join('-')}.md`;
}
export function randomPlanWords(): [string, string, string] {
  const first = pick(planAdjectives);
  let second = pick(planAdjectives);
  while (second === first) second = pick(planAdjectives);
  return [first, second, pick(planNouns)];
}
/** Create an empty plan file in `folder`, creating missing folders and picking new words on a clash. */
export function createPlanFile(
  folder: string,
  date = new Date(),
  words: () => readonly [string, string, string] = randomPlanWords,
): string {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt++) {
    const path = join(folder, planFileName(date, words()));
    try {
      writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
      return realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not choose an unused plan name in ${folder}`);
}
/** Plan file names in `folder`, sorted by name, newest first. A missing folder has none. */
export function listPlans(folder: string): string[] {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}
const threeWords = (name: string) => /^\d{4}-\d{2}-\d{2}-\d{4}-(.+)\.md$/.exec(name)?.[1];

/**
 * Admit the exact resolved plan path, only while it ends in `.md`, is a regular file that
 * is not a symlink, still resolves to itself and is not inside a skill bundle. Shared by
 * attachment, the tool permission gate and the sandboxed file worker.
 */
export function checkedPlanPath(path: string, skills: SkillAccess[] = []): string {
  if (!isAbsolute(path) || !path.endsWith('.md'))
    throw new Error('A plan must be an absolute path to a .md file');
  if (isSkillPath(path, skills)) throw new Error('A plan cannot be inside a skill bundle');
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`The plan file is missing: ${path}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`A plan cannot be a symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`A plan must be a regular .md file: ${path}`);
  if (realpathSync(path) !== path)
    throw new Error(`The plan path no longer resolves to itself: ${path}`);
  return path;
}
/** Resolve and check a path named by `/plan resume`. */
export function attachablePlan(path: string, skills: SkillAccess[] = []): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`No plan file at ${path}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`A plan cannot be a symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`A plan must be a regular .md file: ${path}`);
  if (!path.endsWith('.md')) throw new Error(`A plan must be a .md file: ${path}`);
  return checkedPlanPath(realpathSync(path), skills);
}
/**
 * The plan a `/plan resume` argument names. An argument containing `/` or starting with `~`
 * is a path; anything else is a name in `folder`, by full file name or three-word part.
 */
export function resolvePlanArgument(
  argument: string,
  options: { folder: string; workspace: string; home: string; skills?: SkillAccess[] },
): string {
  if (argument.includes('/') || argument.startsWith('~')) {
    const expanded =
      argument === '~'
        ? options.home
        : argument.startsWith('~/')
          ? join(options.home, argument.slice(2))
          : argument;
    return attachablePlan(resolve(options.workspace, expanded), options.skills);
  }
  const matches = listPlans(options.folder).filter(
    (name) => name === argument || threeWords(name) === argument,
  );
  if (!matches.length)
    throw new Error(
      `No plan named ${argument} in ${options.folder}. Run /plan resume to list plans.`,
    );
  if (matches.length > 1)
    throw new Error(`${argument} matches more than one plan: ${matches.join(', ')}`);
  return attachablePlan(join(options.folder, matches[0]!), options.skills);
}
/** The plan's bytes, or undefined when it is missing or no longer a regular, unlinked file. */
export function readPlan(path: string): Buffer | undefined {
  let fd: number;
  try {
    if (realpathSync(path) !== path) return undefined;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd) : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
export function planFileMissing(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() || !stat.isFile();
  } catch {
    return true;
  }
}
/**
 * One agent's plan data for a turn, and the hash to record. A hash is recorded only when the
 * turn carries the plan text or the plan is unchanged; a flag-only turn leaves it alone.
 */
export function planTurn(
  path: string,
  recorded: string | undefined,
): { plan: PlanTurn; record?: string } {
  const bytes = readPlan(path);
  if (!bytes) return { plan: { path, status: 'missing', rules: planRules } };
  const hash = planHash(bytes);
  if (hash === recorded)
    return { plan: { path, status: 'unchanged', rules: planRules }, record: hash };
  if (bytes.length > planTextLimit) return { plan: { path, status: 'changed', rules: planRules } };
  return {
    plan: { path, status: 'changed', text: bytes.toString('utf8'), rules: planRules },
    record: hash,
  };
}

const agentIdentity = /^[a-z][a-z0-9_-]{0,31}$/;
function writeState(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
function agentFile({ directory, agent }: PlanStateLocation): string {
  if (!agentIdentity.test(agent)) throw new Error('Invalid plan state agent');
  return join(directory, 'agents', `${agent}.json`);
}
/** The attached plan path, or undefined when plan mode is off. Unreadable state fails closed. */
export function readPlanMode(directory: string): string | undefined {
  const value = JSON.parse(readFileSync(join(directory, 'mode.json'), 'utf8'));
  if (value?.path === null) return undefined;
  if (typeof value?.path !== 'string') throw new Error('Plan mode state is invalid');
  return value.path;
}
/** One agent's recorded plan hash and its count of successful plan writes. */
export function readAgentPlan(location: PlanStateLocation): { hash?: string; edits: number } {
  let value;
  try {
    value = JSON.parse(readFileSync(agentFile(location), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { edits: 0 };
    throw error;
  }
  return {
    ...(typeof value?.hash === 'string' ? { hash: value.hash } : {}),
    edits: Number.isSafeInteger(value?.edits) ? value.edits : 0,
  };
}
/** Record (or clear) one agent's plan hash; a successful plan write also counts an edit. */
export function recordAgentPlan(
  location: PlanStateLocation,
  hash: string | undefined,
  edited = false,
): void {
  const { edits } = readAgentPlan(location);
  writeState(agentFile(location), { hash: hash ?? null, edits: edits + (edited ? 1 : 0) });
}

/** Host-owned plan-mode state: the attached path and one hash file per agent. */
export class PlanState {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-plan-')));
  constructor() {
    mkdirSync(join(this.directory, 'agents'), { mode: 0o700 });
    writeState(join(this.directory, 'mode.json'), { path: null });
  }
  location(agent: string): PlanStateLocation {
    return { directory: this.directory, agent };
  }
  /** Turn plan mode on with `path`, or off. Every agent's recorded hash is cleared. */
  set(path: string | undefined, hashes: Record<string, string> = {}): void {
    writeState(join(this.directory, 'mode.json'), { path: path ?? null });
    const agents = new Set([...this.agents(), ...Object.keys(hashes)]);
    for (const agent of agents) this.record(agent, path ? hashes[agent] : undefined);
  }
  recorded(agent: string): string | undefined {
    return readAgentPlan(this.location(agent)).hash;
  }
  record(agent: string, hash: string | undefined): void {
    recordAgentPlan(this.location(agent), hash);
  }
  edits(agent: string): number {
    return readAgentPlan(this.location(agent)).edits;
  }
  /** Recorded hashes, read back from the files tool services also write. */
  hashes(): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const agent of this.agents()) {
      const { hash } = readAgentPlan(this.location(agent));
      if (hash) hashes[agent] = hash;
    }
    return hashes;
  }
  private agents(): string[] {
    return readdirSync(join(this.directory, 'agents'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => basename(name, '.json'))
      .filter((agent) => agentIdentity.test(agent));
  }
  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
