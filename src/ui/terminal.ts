import { completeAttachmentAction, attachmentLabel } from './attachment-input.js';
import type { TerminalAttachments } from './terminal-attachments.js';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { maintenanceLabel } from '../participant-status.js';
import type { Room } from '../room.js';
import { complete } from '../completion.js';
import { ComposerHistory } from '../composer-history.js';
import { questionDetails, unansweredQuestions } from '../questions.js';
import {
  completionInputs,
  historyInputs,
  projectRoom,
  questionSession,
  stagedAttachments,
  timeline,
  type RoomSnapshot,
} from '../snapshot.js';
import { formatImageDraftWarning, imageDraftWarning } from '../image-warning.js';
import type { DraftSubmissionResult } from '../web-types.js';
import {
  completionContext,
  fileReferenceActive,
  type FileCompletion,
} from '../completion-context.js';
import { systemClipboard, type Clipboard } from './clipboard.js';
import { TextSelection, type CopyRow } from './selection.js';
import {
  InputParser,
  previousBoundary,
  nextBoundary,
  cleanText,
  inputRows,
  type Key,
} from './input.js';

const reset = '\x1b[0m',
  dim = '\x1b[90m',
  cyan = '\x1b[96m',
  amber = '\x1b[38;5;215m',
  red = '\x1b[91m';
const colors: Record<string, string> = { human: '\x1b[97m', codex: cyan, claude: amber };
export interface DisplayLine extends CopyRow {
  key: string;
  text: string;
}
function wrapped(text: string, width: number): string[] {
  return wrapAnsi(cleanText(text), Math.max(1, width), {
    hard: true,
    wordWrap: false,
    trim: false,
  }).split('\n');
}
function copyWrapped(text: string, width: number): CopyRow[] {
  return cleanText(text)
    .split('\n')
    .flatMap((line) =>
      wrapped(line, width).map((text, i) => ({ text, continuation: i > 0, contentStart: 2 })),
    );
}
function fit(text: string, width: number): string {
  return wrapped(text, width)[0] ?? '';
}
export function composerPrefix(name: string, width: number): string {
  return `${fit(name, Math.min(20, Math.max(1, width - 8)))} › `;
}
/** Render the conversation body from the public display projection. */
export function transcript(snapshot: RoomSnapshot, width: number): DisplayLine[] {
  const lines: DisplayLine[] = [];
  const { humanName } = snapshot;
  const questions = questionSession(snapshot);
  for (const entry of timeline(snapshot.session)) {
    if (entry.kind === 'notice') {
      for (const [i, row] of copyWrapped(entry.item.text, width - 2).entries())
        lines.push({
          ...row,
          key: `${entry.item.id}:notice:${i}`,
          text: `${dim}· ${row.text}${reset}`,
        });
      continue;
    }
    const m = entry.item;
    const color = colors[m.author] ?? cyan;
    lines.push({
      key: `${m.id}:header`,
      text: `${color}${fit(`${m.author === 'human' ? humanName : m.author}  #${m.id}${entry.pinned ? '  [pinned]' : ''}${m.recipients.length ? ' → ' + m.recipients.map((n) => (n === 'human' ? humanName : '@' + n)).join(' ') : ''}${m.replyTo.length ? '  ↳ ' + m.replyTo.map((id) => '#' + id).join(', ') : ''}`, width)}${reset}`,
    });
    for (const [i, row] of copyWrapped(m.text, width - 2).entries())
      lines.push({ ...row, key: `${m.id}:text:${i}`, text: `  ${row.text}` });
    for (const attachment of m.attachments ?? [])
      for (const [i, row] of copyWrapped(
        'Image ' + attachmentLabel(attachment),
        width - 2,
      ).entries())
        lines.push({ ...row, key: `${m.id}:${attachment.id}:${i}`, text: `  ${row.text}` });
    if (m.question) {
      const questionText = questionDetails(questions, m);
      for (const [i, row] of copyWrapped(questionText, width - 2).entries())
        lines.push({ ...row, key: `${m.id}:question:${i}`, text: `${amber}  ${row.text}${reset}` });
    }
    const delivery = Object.entries(m.deliveries)
      .map(([name, d]) => `${name}: ${d.status}${d.rationale ? ' · ' + d.rationale : ''}`)
      .join('   ');
    for (const [i, row] of copyWrapped(delivery, width - 2).entries())
      if (row.text)
        lines.push({ ...row, key: `${m.id}:delivery:${i}`, text: `${dim}  ${row.text}${reset}` });
    lines.push({ key: `${m.id}:space`, text: '' });
  }
  const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  for (const id of snapshot.sessionAgentIds) {
    const state = agents.get(id);
    if (state?.draft) {
      lines.push({
        key: `${state.id}:draft-header`,
        text: `${colors[state.id] ?? cyan}${state.id}  ${state.active ? 'replying…' : 'incomplete response'}${reset}`,
      });
      for (const [i, row] of copyWrapped(state.draft, width - 2).entries())
        lines.push({ ...row, key: `${state.id}:draft:${i}`, text: `  ${row.text}` });
    }
  }
  return lines;
}
export class TerminalUI {
  private value = '';
  private cursor = 0;
  private history = new ComposerHistory();
  private parser: InputParser;
  private room: Room;
  private timer?: NodeJS.Timeout;
  private escapeTimer?: NodeJS.Timeout;
  private mounted = false;
  private enhanced = false;
  private submitting = false;
  private anchor?: string;
  private top = 0;
  private visibleHeight = 10;
  private cachedLines: DisplayLine[] = [];
  private suggestions: string[] = [];
  private selected = 0;
  private completionStart = 0;
  private fileBrowser?: FileCompletion;
  private completionHits = new Map<number, number>();
  private lastInterrupt = 0;
  private selection?: TextSelection;
  private screen?: { rows: CopyRow[]; width: number; height: number; x: number; y: number };
  private feedback?: string;
  private clipboardWrites = Promise.resolve();
  private action?: { cursor: number; abort: AbortController; dispatched?: boolean };
  private pendingAction?: NonNullable<TerminalUI['action']>;
  private actionBusy = false;
  private changed = () => {
    if (!this.action && this.value !== (this.room.session.composerDraft ?? '')) {
      this.value = this.room.session.composerDraft ?? '';
      this.cursor = Math.min(this.cursor, this.value.length);
      this.suggestions = [];
      this.fileBrowser = undefined;
      this.history.reset();
    }
    this.draw();
  };
  private saveDraft(): void {
    if (!this.action) this.room.saveDraft(this.value);
  }
  private closeAction(): void {
    const action = this.action;
    if (!action) return;
    if (!action.dispatched) action.abort.abort();
    else if (this.pendingAction === action)
      this.feedback =
        'Attachment update pending; input dismissed. The dispatched update may still commit.';
    this.action = undefined;
    this.actionBusy = false;
    this.value = this.room.session.composerDraft ?? '';
    this.cursor = Math.min(action.cursor, this.value.length);
    this.suggestions = [];
    this.fileBrowser = undefined;
    this.draw();
  }
  private async runAction(): Promise<void> {
    const action = this.action,
      room = this.room;
    if (!action || !this.attachments || this.actionBusy) return;
    this.actionBusy = true;
    this.pendingAction = action;
    this.feedback = 'Attachment action pending; Esc cancels.';
    this.draw();
    let feedback: string;
    try {
      feedback = await this.attachments.action(this.value, room, action.abort.signal, () => {
        action.dispatched = true;
        if (this.action === action) {
          this.feedback =
            'Attachment draft update pending; Esc dismisses input, not the dispatched update.';
          this.draw();
        }
      });
    } catch (error) {
      feedback = `Attachment error: ${(error as Error).message}`;
    }
    if (this.pendingAction === action) this.pendingAction = undefined;
    if (this.room !== room || (this.action !== action && !action.dispatched)) return;
    if (this.action === action) this.closeAction();
    // Lists/help are transient screen content, never persisted source input.
    this.feedback = feedback;
    this.draw();
  }
  private resized = () => {
    this.selection = undefined;
    this.draw();
  };
  private data = (data: Buffer) => {
    this.parser.feed(data);
    clearTimeout(this.escapeTimer);
    this.escapeTimer = setTimeout(() => this.parser.flushEscape(), 35);
  };
  constructor(
    room: Room,
    private submit: (line: string, sessionId: string) => Promise<DraftSubmissionResult>,
    private quit: () => Promise<void>,
    private clipboard: Clipboard = systemClipboard,
    private attachments?: TerminalAttachments,
  ) {
    this.room = room;
    this.value = room.session.composerDraft ?? '';
    this.cursor = this.value.length;
    this.parser = new InputParser((key) => this.key(key));
  }
  mount(): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        'Chittr needs an interactive terminal. Use chittr --help or chittr doctor for plain output.',
      );
    this.mounted = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this.data);
    process.stdout.on('resize', this.resized);
    this.room.on('change', this.changed);
    process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?u');
    this.timer = setInterval(() => {
      if (Object.values(this.room.session.agents).some((s) => s.active)) this.draw();
    }, 160);
    this.draw();
  }
  setRoom(room: Room): void {
    this.closeAction();
    this.pendingAction = undefined;
    this.history.reset();
    this.room.off('change', this.changed);
    this.room = room;
    room.on('change', this.changed);
    this.value = room.session.composerDraft ?? '';
    this.cursor = this.value.length;
    this.anchor = undefined;
    this.selection = undefined;
    this.feedback = undefined;
    this.suggestions = [];
    this.fileBrowser = undefined;
    this.draw();
  }
  unmount(): void {
    if (!this.mounted) return;
    this.closeAction();
    this.mounted = false;
    clearInterval(this.timer);
    clearTimeout(this.escapeTimer);
    this.room.off('change', this.changed);
    process.stdin.off('data', this.data);
    process.stdout.off('resize', this.resized);
    try {
      process.stdin.setRawMode(false);
    } catch {}
    process.stdin.pause();
    process.stdout.write(
      `${this.enhanced ? '\x1b[<u' : ''}\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l`,
    );
  }
  private edit(insert: string): void {
    const browsing = Boolean(this.fileBrowser);
    const text = cleanText(insert);
    if (Buffer.byteLength(this.value) + Buffer.byteLength(text) > 65536) {
      this.room.notice('Draft exceeds 64 KiB; paste a smaller excerpt or reference the file.');
      return;
    }
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.history.reset();
    this.cursor += text.length;
    this.suggestions = [];
    this.fileBrowser = undefined;
    this.saveDraft();
    if (
      !this.action &&
      (fileReferenceActive(this.value, this.cursor) ||
        (browsing && completionContext(this.value, this.cursor).token))
    )
      this.complete(true);
    else this.draw();
  }
  private key(key: Key): void {
    if (key.name === 'keyboard-supported') {
      if (!this.enhanced) {
        this.enhanced = true;
        process.stdout.write('\x1b[>1u');
      }
      return;
    }
    if (key.name.startsWith('mouse-')) {
      this.mouse(key);
      return;
    }
    if (key.name === 'ctrl-d') {
      void this.quit();
      return;
    }
    if (key.name === 'copy' || (key.name === 'ctrl-c' && this.selection?.text())) {
      this.copySelection();
      return;
    }
    if (
      [
        'text',
        'paste',
        'newline',
        'enter',
        'attachments',
        'backspace',
        'delete',
        'clear-line',
      ].includes(key.name)
    )
      this.feedback = this.pendingAction?.dispatched
        ? 'Attachment update pending; its result will be shown.'
        : undefined;
    if (this.selection) {
      this.selection = undefined;
      if (key.name === 'escape') {
        this.draw();
        return;
      }
    }
    if (key.name === 'attachments' && this.attachments && !this.action) {
      if (this.pendingAction) {
        this.feedback = 'Attachment update pending; wait for its result before another action.';
        this.draw();
        return;
      }
      this.action = { cursor: this.cursor, abort: new AbortController() };
      this.value = '/attach ';
      this.cursor = this.value.length;
      this.suggestions = [];
      this.fileBrowser = undefined;
      this.draw();
      return;
    }
    if (this.action && key.name === 'escape') {
      this.closeAction();
      return;
    }
    if (key.name === 'clipboard-paste' && !this.actionBusy) {
      void this.pasteClipboard();
      return;
    }
    if (key.name === 'ctrl-c') {
      if (Date.now() - this.lastInterrupt < 1200) void this.quit();
      else {
        this.lastInterrupt = Date.now();
        void this.room.stop().catch((e) => this.room.notice(String(e)));
      }
      return;
    }
    if (this.actionBusy) return;
    if (key.name === 'text' || key.name === 'paste') {
      this.edit(key.text ?? '');
      return;
    }
    if (key.name === 'newline') {
      this.edit('\n');
      return;
    }
    if (key.name === 'enter') {
      if (this.suggestions.length) {
        this.acceptCompletion();
        return;
      }
      if (this.fileBrowser) return;
      if (this.action) void this.runAction();
      else void this.send();
      return;
    }
    if (key.name === 'tab') {
      if (this.suggestions.length) {
        if (this.fileBrowser || this.action) {
          this.acceptCompletion();
          return;
        }
        this.selected = (this.selected + 1) % this.suggestions.length;
        this.draw();
      } else this.complete();
      return;
    }
    if (this.suggestions.length && (key.name === 'up' || key.name === 'down')) {
      this.selected =
        (this.selected + (key.name === 'up' ? -1 : 1) + this.suggestions.length) %
        this.suggestions.length;
      this.draw();
      return;
    }
    if (this.fileBrowser && (key.name === 'up' || key.name === 'down')) return;
    if (this.fileBrowser?.parent && key.name === 'left') {
      this.acceptCompletion(this.fileBrowser.parent, true);
      return;
    }
    if (key.name === 'backtab' && this.suggestions.length) {
      this.selected = (this.selected + this.suggestions.length - 1) % this.suggestions.length;
      this.draw();
      return;
    }
    if (key.name === 'escape') {
      if (this.suggestions.length || this.fileBrowser) {
        this.suggestions = [];
        this.fileBrowser = undefined;
      } else this.anchor = undefined;
      this.draw();
      return;
    }
    if (key.name === 'scroll-up' || key.name === 'scroll-down') {
      this.scroll(key.name === 'scroll-up' ? -3 : 3);
      return;
    }
    if (key.name === 'page-up' || key.name === 'page-down') {
      const page = Math.max(1, this.visibleHeight - 2);
      this.scroll(key.name === 'page-up' ? -page : page);
      return;
    }
    const browsing = Boolean(this.fileBrowser);
    this.suggestions = [];
    this.fileBrowser = undefined;
    if (key.name === 'left') this.cursor = previousBoundary(this.value, this.cursor);
    if (key.name === 'right') this.cursor = nextBoundary(this.value, this.cursor);
    if (key.name === 'home')
      this.cursor = this.cursor === 0 ? 0 : this.value.lastIndexOf('\n', this.cursor - 1) + 1;
    if (key.name === 'end') {
      const end = this.value.indexOf('\n', this.cursor);
      this.cursor = end < 0 ? this.value.length : end;
    }
    if (key.name === 'up' || key.name === 'down') this.vertical(key.name === 'up' ? -1 : 1);
    if (key.name === 'backspace') {
      this.history.reset();
      const before = previousBoundary(this.value, this.cursor);
      this.value = this.value.slice(0, before) + this.value.slice(this.cursor);
      this.cursor = before;
    }
    if (key.name === 'delete') {
      this.history.reset();
      this.value =
        this.value.slice(0, this.cursor) + this.value.slice(nextBoundary(this.value, this.cursor));
    }
    if (key.name === 'clear-line') {
      this.history.reset();
      const start = this.cursor === 0 ? 0 : this.value.lastIndexOf('\n', this.cursor - 1) + 1;
      this.value = this.value.slice(0, start) + this.value.slice(this.cursor);
      this.cursor = start;
    }
    this.saveDraft();
    if (
      !this.action &&
      ['backspace', 'delete'].includes(key.name) &&
      (fileReferenceActive(this.value, this.cursor) ||
        (browsing && completionContext(this.value, this.cursor).token))
    )
      this.complete(true);
    else this.draw();
  }
  private mouse(key: Key): void {
    const screen = this.screen;
    if (!screen || key.x === undefined || key.y === undefined) return;
    const cell = {
      x: Math.max(0, Math.min(screen.width - 1, key.x)),
      y: Math.max(0, Math.min(screen.height - 2, key.y)),
    };
    if (key.name === 'mouse-down') {
      const entry = this.fileBrowser ? this.completionHits.get(cell.y) : undefined;
      if (entry !== undefined) {
        this.selected = entry;
        this.acceptCompletion();
        return;
      }
      if (key.y >= screen.height - 1) return;
      this.feedback = undefined;
      this.selection = new TextSelection(screen.rows.slice(0, -1), cell);
    } else if (this.selection?.dragging) {
      this.selection.end = cell;
      if (key.name === 'mouse-up') {
        this.selection.dragging = false;
        if (this.selection.text()) this.copySelection();
        else this.selection = undefined;
      }
    }
    this.draw();
  }
  private copySelection(): void {
    const selection = this.selection;
    const text = selection?.text();
    if (!selection || !text) return;
    selection.status = 'Copying…';
    // Keep rapid successive selections in order, even if a pasteboard process is slow.
    this.clipboardWrites = this.clipboardWrites.then(async () => {
      try {
        await this.clipboard.write(text);
        selection.status = 'Copied to clipboard';
      } catch (error) {
        selection.status = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (this.selection === selection) this.draw();
    });
    this.draw();
  }
  private async pasteClipboard(): Promise<void> {
    const room = this.room,
      value = this.value,
      cursor = this.cursor,
      action = this.action;
    try {
      await this.clipboardWrites;
      const text = await this.clipboard.read();
      if (!this.mounted || this.room !== room || this.action !== action) return;
      if (this.value !== value || this.cursor !== cursor) {
        this.feedback = 'Draft changed while reading clipboard; paste again.';
        this.draw();
        return;
      }
      this.edit(text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
    } catch (error) {
      if (!this.mounted || this.room !== room || this.action !== action) return;
      this.feedback = `Paste failed: ${error instanceof Error ? error.message : String(error)}`;
      this.draw();
    }
  }
  private vertical(direction: -1 | 1): void {
    const width = Math.max(12, process.stdout.columns ?? 80);
    const inputs = historyInputs(this.room);
    const prefix = composerPrefix(this.action ? 'Attach' : inputs.humanName, width);
    const rows = inputRows(this.value, width - stringWidth(prefix));
    let index = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i]!.start <= this.cursor) index = i;
    const row = rows[index]!,
      target = rows[index + direction];
    if (!this.action && (this.history.browsing || !target)) {
      const value = this.history.move(direction, inputs.messages, this.value);
      if (value !== undefined) {
        this.value = cleanText(value);
        this.cursor = this.value.length;
      }
      return;
    }
    if (!target) return;
    const column = stringWidth(this.value.slice(row.start, this.cursor));
    let cursor = target.start;
    while (cursor < target.end) {
      const next = nextBoundary(this.value, cursor);
      if (stringWidth(this.value.slice(target.start, next)) > column) break;
      cursor = next;
    }
    this.cursor = cursor;
  }
  private async send(): Promise<void> {
    const room = this.room;
    const hasImages = Boolean(room.session.composerAttachments?.length);
    if (this.submitting || (!this.value.trim() && !hasImages)) return;
    const line = this.value;
    this.history.reset();
    this.submitting = true;
    // Text commands can close/switch the room. The controller clears the server draft before
    // dispatch, synchronously inside this call; only the local input is cleared here.
    if (!hasImages) {
      this.value = '';
      this.cursor = 0;
    }
    const outcome = hasImages
      ? this.attachments
        ? this.attachments.send(line, room)
        : Promise.reject(new Error('Terminal attachment support is unavailable.'))
      : this.submit(line, room.session.id);
    this.draw();
    try {
      const result = await outcome;
      if (this.room === room && result.recovery.status === 'restored') this.cursor = line.length;
      if (result.dispatch.status === 'failed' && result.commitment.status !== 'committed')
        throw new Error(result.dispatch.error);
    } catch (error) {
      if (this.room === room)
        this.feedback = `Send not confirmed: ${(error as Error).message}. Check the draft and retry.`;
    } finally {
      this.submitting = false;
      this.changed();
    }
  }
  private complete(automatic = false): void {
    if (this.action && this.attachments) {
      const action = this.action,
        value = this.value,
        room = this.room,
        cursor = this.cursor;
      void completeAttachmentAction(
        value.slice(0, cursor),
        this.attachments.launchDirectory,
        stagedAttachments(room),
        action.abort.signal,
      )
        .then((suggestions) => {
          if (
            this.action !== action ||
            this.room !== room ||
            this.value !== value ||
            this.cursor !== cursor
          )
            return;
          this.completionStart = 0;
          this.suggestions = suggestions;
          this.selected = 0;
          if (suggestions.length === 1) this.acceptCompletion();
          else this.draw();
        })
        .catch(() => {});
      return;
    }
    const inputs = completionInputs(this.room);
    const result = complete(inputs.workspace, inputs.enabledAgentIds, this.value, this.cursor);
    this.completionStart = result.start;
    this.suggestions = result.suggestions;
    this.fileBrowser = result.files;
    this.selected = 0;
    if (!automatic && this.suggestions.length === 1) this.acceptCompletion();
    else this.draw();
  }
  private acceptCompletion(value = this.suggestions[this.selected], directory = false): void {
    if (value === undefined) return;
    this.history.reset();
    if (this.action) {
      // Terminal suggestions are complete commands. Replace the whole input, including
      // any old suffix/closing quote; keep directory editing inside its JSON quotes.
      this.value = value;
      this.cursor = value.length - (value.endsWith('/\"') ? 1 : 0);
      this.suggestions = [];
      this.draw();
      return;
    }
    directory ||= Boolean(
      this.fileBrowser?.entries.some((entry) => entry.value === value && entry.directory),
    );
    this.value = this.value.slice(0, this.completionStart) + value + this.value.slice(this.cursor);
    this.cursor = this.completionStart + value.length;
    this.suggestions = [];
    this.fileBrowser = undefined;
    this.saveDraft();
    if (directory) this.complete(true);
    else this.draw();
  }
  private scroll(amount: number): void {
    const max = Math.max(0, this.cachedLines.length - this.visibleHeight);
    this.top = Math.max(0, Math.min(max, (this.anchor ? this.top : max) + amount));
    this.anchor = this.top >= max ? undefined : this.cachedLines[this.top]?.key;
    this.draw();
  }
  draw(): void {
    if (!this.mounted) return;
    if (this.selection && this.screen) {
      const { rows, width } = this.screen;
      const output = rows.map((row, y) => this.selection!.highlight(y, row.text));
      output[output.length - 1] =
        `${dim}${fit(`${this.selection.status} · Esc clear · display held; agents continue`, width)}${reset}`;
      this.paint(output);
      return;
    }
    const width = Math.max(12, process.stdout.columns ?? 80),
      height = Math.max(6, process.stdout.rows ?? 24);
    const snapshot = projectRoom(this.room);
    const { session, permissions: policy } = snapshot;
    const header = [
      `${cyan}CHITTR${reset}  ${dim}${fit(snapshot.workspace, Math.max(1, width - 11))}${reset}`,
      `${dim}${fit(`session ${session.id.slice(0, 8)} · ${session.paused ? 'PAUSED' : 'room open'} · commands ${snapshot.commandAccess.mode} · edits ${policy.edits ? 'on' : 'off'} · network ${policy.network ? 'on' : 'off'}`, width)}${reset}`,
    ];
    if (snapshot.commandAccess.source) {
      const summary = snapshot.commandAccessDescription;
      for (const line of wrapped(summary, width).slice(0, Math.max(1, Math.min(4, height - 12))))
        header.push(`${amber}${line}${reset}`);
    }
    const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    const participants = snapshot.sessionAgentIds
      .flatMap((id) => {
        const agent = agents.get(id);
        return agent?.provider !== undefined ? [agent] : [];
      })
      .map((s) => {
        const { pending } = s;
        const maintenance = s.maintenance
          ? ['requested', 'waiting', 'running'].includes(s.maintenance.status)
            ? ` · ${s.maintenance.detail ?? s.statusDetail}`
            : ` · ${maintenanceLabel(s.maintenance)} ${s.maintenance.status}`
          : '';
        const tool = s.activity === 'working' && s.detail ? ' ' + s.detail : '';
        return `${s.id} ${s.status}${tool}${maintenance}${s.paused ? ' · replies paused' : ''}${pending.queued ? ' · ' + pending.queued + ' queued' : ''}${pending.capped ? ' / ' + pending.capped + ' capped' : ''}${pending.unresolved ? ' · ' + pending.unresolved + ' unresolved' : ''}`;
      })
      .join('   │   ');
    for (const line of wrapped(participants || 'Connecting participants…', width).slice(0, 3))
      header.push(`${dim}${line}${reset}`);
    const questions = unansweredQuestions(session.messages).length;
    if (questions)
      header.push(
        `${amber}${questions} unanswered question${questions === 1 ? '' : 's'} · /questions${reset}`,
      );
    const prefix = composerPrefix(this.action ? 'Attach' : snapshot.humanName, width);
    const inputWidth = width - stringWidth(prefix);
    const layout = inputRows(this.value, inputWidth);
    const inputLines = layout.map((row) => row.text);
    let caretRow = 0;
    for (let i = 0; i < layout.length; i++) if (layout[i]!.start <= this.cursor) caretRow = i;
    const caretCol = stringWidth(this.value.slice(layout[caretRow]!.start, this.cursor));
    const composerHeight = Math.min(
      Math.max(1, inputLines.length),
      Math.max(1, Math.min(7, height - header.length - 5)),
    );
    const inputTop = Math.max(0, caretRow - composerHeight + 1);
    const footer =
      (this.action
        ? this.action.dispatched
          ? 'Attachment update dispatched · Esc dismisses input; update continues'
          : 'Attachment input · Enter run · Tab complete · Esc cancel · /help'
        : undefined) ??
      this.feedback ??
      (this.fileBrowser
        ? `↑/↓ browse · Enter/Tab select · ← parent · Esc close${this.fileBrowser.truncated ? ' · First 200; type to filter' : ''}`
        : this.suggestions.length
          ? this.suggestions
              .slice(Math.max(0, this.selected - 2), this.selected + 4)
              .map((v, i) => {
                const selected = i + Math.max(0, this.selected - 2) === this.selected;
                const label = v.trim() === '@human' ? `${snapshot.humanName} (@human)` : v.trim();
                return `${selected ? '[' : ''}${label}${selected ? ']' : ''}`;
              })
              .join('  ')
          : this.submitting
            ? 'Applying command…'
            : `Ctrl+O images · Drag to copy · Cmd+V paste · Enter send · Ctrl+J newline · ./ files · Tab complete · /help`);
    const completionRows: CopyRow[] = [];
    const available = Math.max(0, Math.min(7, height - header.length - composerHeight - 4));
    const offset = Math.max(
      0,
      Math.min(this.selected - 2, this.suggestions.length - Math.max(1, available - 1)),
    );
    if (this.fileBrowser && available) {
      completionRows.push({
        text: `${cyan}${fit(`File explorer · ${this.fileBrowser.directory || './'}`, width)}${reset}`,
      });
      for (const [i, entry] of this.fileBrowser.entries
        .slice(offset, offset + available - 1)
        .entries())
        completionRows.push({
          text: `${offset + i === this.selected ? '\x1b[7m' : ''}${fit(`${entry.directory ? '▸' : '·'} ${entry.label}`, width)}${reset}`,
        });
      if (!this.suggestions.length && available > 1)
        completionRows.push({
          text: `${dim}${fit(this.fileBrowser.error ?? 'No matching files or folders.', width)}${reset}`,
        });
    }
    this.visibleHeight = Math.max(
      1,
      height - header.length - composerHeight - completionRows.length - 2,
    );
    this.cachedLines = transcript(snapshot, width);
    for (const attachment of session.composerAttachments)
      for (const [i, text] of wrapped('Staged ' + attachmentLabel(attachment), width).entries())
        this.cachedLines.push({ key: `staged:${attachment.id}:${i}`, text });
    const imageWarning = imageDraftWarning({
      line: this.action ? session.composerDraft : this.value,
      hasImages: Boolean(session.composerAttachments.length),
      participants: snapshot.agents,
      messages: session.messages,
      invalidRoom: Boolean(snapshot.fatal),
    });
    if (imageWarning)
      for (const [line, warning] of formatImageDraftWarning(imageWarning).entries())
        for (const [i, text] of wrapped(warning, width).entries())
          this.cachedLines.push({
            key: `image-warning:${line}:${i}`,
            text: `${amber}${text}${reset}`,
          });
    if (this.feedback)
      for (const [i, text] of wrapped(this.feedback, width).entries())
        this.cachedLines.push({ key: `feedback:${i}`, text });
    if (this.action)
      this.cachedLines.push({
        key: 'action-help',
        text: fit(
          'Attachment actions · /help · --list · --remove <id> · --clipboard · --status · Esc cancel',
          width,
        ),
      });
    if (snapshot.fatal)
      this.cachedLines.push({ key: 'fatal', text: `${red}${fit(snapshot.fatal, width)}${reset}` });
    if (!this.cachedLines.length) {
      const enabled = snapshot.agents
        .filter((agent) => agent.enabled)
        .map((agent) => '@' + agent.id);
      this.cachedLines.push({
        key: 'welcome',
        text: `${dim}Start a discussion${enabled.length ? ', or address ' + enabled.join(' / ') : ''}. /help lists controls.${reset}`,
      });
    }
    if (this.anchor) {
      const index = this.cachedLines.findIndex((l) => l.key === this.anchor);
      if (index >= 0) this.top = index;
      this.top = Math.min(this.top, Math.max(0, this.cachedLines.length - this.visibleHeight));
    } else this.top = Math.max(0, this.cachedLines.length - this.visibleHeight);
    const body: CopyRow[] = this.cachedLines.slice(this.top, this.top + this.visibleHeight);
    while (body.length < this.visibleHeight) body.push({ text: '' });
    const below = Math.max(0, this.cachedLines.length - this.top - this.visibleHeight);
    const position = this.anchor ? `History · ${below} lines below · Esc latest` : 'Latest';
    const divider = fit(`─ ${position} `, width);
    const output: CopyRow[] = [
      ...header.map((text) => ({ text })),
      ...body,
      { text: `${dim}${divider}${'─'.repeat(Math.max(0, width - stringWidth(divider)))}${reset}` },
      ...completionRows,
      ...inputLines.slice(inputTop, inputTop + composerHeight).map((line, i) => ({
        text: `${cyan}${i === 0 ? prefix : ' '.repeat(stringWidth(prefix))}${reset}${line}`,
        continuation:
          inputTop + i > 0 && layout[inputTop + i - 1]!.end === layout[inputTop + i]!.start,
        contentStart: stringWidth(prefix),
      })),
      { text: `${dim}${fit(footer, width)}${reset}` },
    ];
    while (output.length < height) output.push({ text: '' });
    const y =
      Math.min(
        height - 1,
        header.length + this.visibleHeight + 1 + completionRows.length + caretRow - inputTop,
      ) + 1;
    this.completionHits.clear();
    if (this.fileBrowser)
      for (let i = 1; i < completionRows.length && this.suggestions.length; i++)
        this.completionHits.set(header.length + this.visibleHeight + 1 + i, offset + i - 1);
    const x = Math.min(width, stringWidth(prefix) + caretCol + 1);
    this.screen = { rows: output.slice(0, height), width, height, x, y };
    this.paint(this.screen.rows.map((row) => row.text));
  }
  private paint(output: string[]): void {
    const screen = this.screen;
    if (!screen) return;
    process.stdout.write(
      '\x1b[?25l\x1b[H' +
        output.map((line) => line + '\x1b[K').join('\r\n') +
        (this.selection ? '' : `\x1b[${screen.y};${screen.x}H\x1b[?25h`),
    );
  }
}
