import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

import type { SkillAccess } from './types.js';
export type { SkillAccess } from './types.js';

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

/** Return a canonical skill path, or undefined for an ordinary workspace path. */
export function skillPath(path: string, skills: SkillAccess[]): string | undefined {
  const skill = skills.find((s) => within(s.path, path) || within(s.root, path));
  if (!skill) return undefined;
  // Do not silently acquire a new version/target between explicit reloads.
  if (realpathSync(skill.path) !== skill.root || realpathSync(skill.root) !== skill.root)
    throw new Error('Skill location changed. Reload while idle to refresh skill access.');
  const target = realpathSync(path);
  if (!skills.some((s) => within(s.root, target) && realpathSync(s.root) === s.root))
    throw new Error('Skill symlink resolves outside the discovered skill bundles');
  return target;
}

export function isSkillPath(path: string, skills: SkillAccess[]): boolean {
  return skills.some((s) => within(s.path, resolve(path)) || within(s.root, resolve(path)));
}
