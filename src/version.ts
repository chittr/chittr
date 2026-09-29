import { readFileSync } from 'node:fs';

// This relative path is the same from src/ and the installed dist/ directory.
export const version: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
