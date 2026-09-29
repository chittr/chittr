/** Shared composer parsing, with no filesystem or browser dependencies. */
export function completionContext(value: string, cursor: number) {
  let start = 0;
  let quoted = false;
  let backticks = '';
  for (let i = 0; i < cursor; i++) {
    const char = value[i];
    if (!quoted && char === '`' && (backticks || i === start)) {
      const run = /^`+/.exec(value.slice(i, cursor))![0];
      if (!backticks) backticks = run;
      else if (run === backticks) backticks = '';
      i += run.length - 1;
      continue;
    }
    if (backticks && char !== '\n') continue;
    if (quoted && char === '\\') {
      i++;
      continue;
    }
    if (char === '"' && (quoted || i === start)) quoted = !quoted;
    else if (char === '\n' || (!quoted && /\s/.test(char ?? ''))) {
      start = i + 1;
      quoted = false;
      backticks = '';
    }
  }
  const token = value.slice(start, cursor);
  let prefix = token;
  const opening = /^`+/.exec(token)?.[0];
  if (opening) {
    prefix = token.slice(opening.length);
    if (!backticks && prefix.endsWith(opening)) {
      prefix = prefix.slice(0, -opening.length);
      // Markdown code spans can pad a path whose name includes a backtick.
      if (prefix.startsWith(' ') && prefix.endsWith(' ') && prefix.trim())
        prefix = prefix.slice(1, -1);
    }
  } else if (token.startsWith('"')) {
    try {
      prefix = JSON.parse(quoted ? token + '"' : token);
    } catch {
      prefix = token.slice(1);
    }
  }
  return { start, token, prefix };
}
export function fileReferenceActive(value: string, cursor: number): boolean {
  return completionContext(value, cursor).prefix.startsWith('./');
}
export interface FileCompletion {
  directory: string;
  parent?: string;
  entries: { value: string; label: string; directory: boolean }[];
  truncated?: boolean;
  error?: string;
}
export interface CompletionResult {
  start: number;
  suggestions: string[];
  files?: FileCompletion;
}
