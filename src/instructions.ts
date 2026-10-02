import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import type { LaunchBrief } from './types.js';

export const instructionFileLimit = 1024 * 1024;
export const launchBriefSchema = z
  .object({
    text: z.string().refine((text) => Buffer.byteLength(text) <= instructionFileLimit, {
      message: 'Instruction text exceeds 1 MiB',
    }),
    source: z.string().refine((source) => source.trim().length > 0),
  })
  .strict();

/** Explicit host configuration input, independent of task-tool permissions. */
export function readInstructionFile(
  path: string,
  directory: string,
  home = homedir(),
): LaunchBrief {
  const source = resolve(directory, path.startsWith('~/') ? join(home, path.slice(2)) : path);
  const text = readFileSync(source, 'utf8');
  if (Buffer.byteLength(text) > instructionFileLimit)
    throw new Error(`Instruction file exceeds 1 MiB: ${source}`);
  return { source, text };
}
