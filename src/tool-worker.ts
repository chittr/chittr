// Runs inside a macOS sandbox. No provider credentials or user environment.
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
  realpathSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { skillPath, isSkillPath, type SkillAccess } from './skill-access.js';
import { checkedPlanPath } from './plan.js';

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}
export function checkedPath(root: string, path: string, write = false): string {
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error('Task-file access is limited to the launch directory');
  // Refuse symlinks, including parent components. The OS sandbox also fences races.
  let current = root;
  for (const part of relative(root, target).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error('Symlink task-file access is not supported');
    } catch (error) {
      if (write && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  const existing = write ? nearestExisting(dirname(target)) : target;
  if (!inside(root, realpathSync(existing)))
    throw new Error('Path resolves outside the launch directory');
  return target;
}
function nearestExisting(path: string): string {
  try {
    realpathSync(path);
    return path;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw e;
    return nearestExisting(dirname(path));
  }
}
export function fileOperation(
  root: string,
  tool: string,
  args: Record<string, any>,
  skills: SkillAccess[] = [],
  plan?: string,
): unknown {
  const readPath = (path: string) =>
    skillPath(resolve(root, path), skills) ?? checkedPath(root, path);
  const display = (path: string) => (inside(root, path) ? relative(root, path) : path);
  // In plan mode, the attached plan is the one path admitted outside these rules.
  const isPlan = (path: string) => plan !== undefined && resolve(root, path) === plan;
  if (tool === 'read_file') {
    const file = isPlan(args.path) ? checkedPlanPath(plan!, skills) : readPath(args.path);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('Path is not a regular file');
      const offset = args.offset ?? 0,
        limit = args.limit ?? 32768;
      const data = Buffer.alloc(Math.min(limit, Math.max(0, stat.size - offset)));
      const count = readSync(fd, data, 0, data.length, offset);
      if (data.subarray(0, count).includes(0))
        throw new Error('Binary file; file inspection supports text only');
      return {
        path: display(resolve(root, args.path)),
        offset,
        bytes: count,
        totalBytes: stat.size,
        text: data.subarray(0, count).toString('utf8'),
        nextOffset: offset + count < stat.size ? offset + count : null,
      };
    } finally {
      closeSync(fd);
    }
  }
  if (tool === 'list_files') {
    const requested = resolve(root, args.path ?? '.');
    const folder = readPath(requested);
    const entries: string[] = [];
    const visited = new Set<string>();
    const limit = args.limit ?? 500;
    const visit = (dir: string, shown: string, depth: number) => {
      if (visited.has(dir)) return;
      visited.add(dir);
      for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entries.length >= limit) return;
        const path = join(shown, item.name);
        const physical = join(dir, item.name);
        let destination = physical;
        let directory = item.isDirectory();
        if (item.isSymbolicLink()) {
          try {
            const allowed = skillPath(path, skills);
            if (!allowed) throw new Error('Not a skill link');
            destination = allowed;
            directory = statSync(allowed).isDirectory();
          } catch {
            entries.push(display(path) + ' [symlink, not traversed]');
            continue;
          }
        }
        entries.push(display(path) + (directory ? '/' : ''));
        if (
          args.recursive &&
          directory &&
          depth < 12 &&
          !['node_modules', '.git'].includes(item.name)
        )
          visit(readPath(destination), path, depth + 1);
      }
    };
    visit(folder, requested, 0);
    return {
      entries,
      truncated: entries.length >= limit,
      note: 'Recursive listing skips .git and node_modules contents; request either directory explicitly to inspect it.',
    };
  }
  if (tool === 'write_file' && plan !== undefined) {
    if (!isPlan(args.path)) throw new Error('Plan mode allows writing only the attached plan');
    // The plan must already exist: no folder creation and no O_CREAT.
    const file = checkedPlanPath(plan, skills);
    const fd = openSync(file, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Path is not a regular file');
      writeSync(fd, args.text);
    } finally {
      closeSync(fd);
    }
    return { path: display(file), writtenBytes: Buffer.byteLength(args.text) };
  }
  if (tool === 'write_file') {
    if (isSkillPath(resolve(root, args.path), skills))
      throw new Error('Skill bundles are read-only, even when workspace edits are enabled');
    const file = checkedPath(root, args.path, true);
    mkdirSync(dirname(file), { recursive: true });
    checkedPath(root, file, true);
    const fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Path is not a regular file');
      writeSync(fd, args.text);
    } finally {
      closeSync(fd);
    }
    return { path: relative(root, file), writtenBytes: Buffer.byteLength(args.text) };
  }
  throw new Error('Unknown file tool');
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv[2] === '--worker'
) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    input += c;
    if (input.length > 2 * 1024 * 1024) process.exit(1);
  });
  process.stdin.on('end', () => {
    try {
      const request = JSON.parse(input);
      process.stdout.write(
        JSON.stringify({
          result: fileOperation(
            realpathSync(request.root),
            request.tool,
            request.args,
            request.skillAccess ?? [],
            request.plan,
          ),
        }),
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      );
    }
  });
}
