import { readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { checkedPath } from './tool-worker.js';
import {
  completionContext,
  type CompletionResult,
  type FileCompletion,
} from './completion-context.js';

export const commands = [
  '/pause',
  '/stop',
  '/continue',
  '/retry',
  '/reply',
  '/questions',
  '/answer',
  '/ask-room',
  '/choose',
  '/pin',
  '/unpin',
  '/pins',
  '/reconnect',
  '/compact',
  '/checkpoint',
  '/reload',
  '/config',
  '/participants',
  '/new',
  '/sessions',
  '/quit',
  '/help',
];
export function complete(
  workspace: string,
  names: string[],
  value: string,
  cursor: number,
): CompletionResult {
  if (/^\/attach(?:\s|$)/.test(value)) return { start: cursor, suggestions: [] };
  const { token, start, prefix } = completionContext(value, cursor);
  let suggestions: string[] = [];
  let files: FileCompletion | undefined;
  if (token.startsWith('@'))
    suggestions = ['human', ...names]
      .filter((name) => name.startsWith(token.slice(1)))
      .map((name) => '@' + name + ' ');
  else if (token.startsWith('/') && start === 0)
    suggestions = commands
      .filter((command) => command.startsWith(token))
      .map((command) => command + ' ');
  else {
    files = { directory: '', entries: [] };
    try {
      const directory = prefix.endsWith('/') ? prefix : dirname(prefix || '.');
      const stem = prefix.endsWith('/') ? '' : basename(prefix);
      const absolute = checkedPath(workspace, directory);
      const relativeDirectory = relative(workspace, absolute);
      const format = (path: string, folder: boolean) => {
        // Use a longer Markdown delimiter when the filename itself contains backticks.
        const fence = '`'.repeat(
          Math.max(0, ...(path.match(/`+/g) ?? []).map((run) => run.length)) + 1,
        );
        if (!folder) {
          const padded =
            path.startsWith('`') ||
            path.endsWith('`') ||
            (path.startsWith(' ') && path.endsWith(' '));
          return fence + (padded ? ' ' + path + ' ' : path) + fence + ' ';
        }
        if (token.startsWith('`')) return fence + path;
        const quoted = /[\s"`\\]/.test(path) ? JSON.stringify(path) : path;
        return quoted.startsWith('"') ? quoted.slice(0, -1) : quoted;
      };
      const matches = readdirSync(absolute, { withFileTypes: true })
        .filter(
          (file) =>
            !file.isSymbolicLink() &&
            (file.isFile() || file.isDirectory()) &&
            !/[\u0000-\u001f\u007f]/.test(file.name) &&
            file.name.startsWith(stem),
        )
        .sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
        );
      files.directory = './' + (relativeDirectory ? relativeDirectory + '/' : '');
      if (relativeDirectory) {
        const parent = relative(workspace, dirname(absolute));
        files.parent = format('./' + (parent ? parent + '/' : ''), true);
      }
      files.truncated = matches.length > 200;
      files.entries = matches.slice(0, 200).map((file) => {
        const path =
          (prefix.startsWith('./') ? './' : '') +
          relative(workspace, join(absolute, file.name)) +
          (file.isDirectory() ? '/' : '');
        return {
          value: format(path, file.isDirectory()),
          label: file.name + (file.isDirectory() ? '/' : ''),
          directory: file.isDirectory(),
        };
      });
      suggestions = files.entries.map((file) => file.value);
    } catch {
      files.error = 'This directory cannot be browsed from the workspace.';
    }
  }
  return { start, suggestions, ...(files ? { files } : {}) };
}
