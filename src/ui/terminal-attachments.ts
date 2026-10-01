import { randomUUID } from 'node:crypto';
import type { RoomController } from '../controller.js';
import type { Room } from '../room.js';
import type { DraftSubmissionResult } from '../web-types.js';
import {
  attachmentLabel,
  parseAttachmentAction,
  readAttachmentPath,
  attachmentHelp,
} from './attachment-input.js';
import { readClipboardImage } from './clipboard.js';
import { formatImageRecipientStatus } from '../image-warning.js';
import { projectRoom } from '../snapshot.js';

/** In-process terminal capability; never installed on the shared controller or web routes. */
export class TerminalAttachments {
  private clientId = randomUUID();
  private version = 0;
  private pending?: { room: Room; line: string; ids: string[]; operationId: string };
  constructor(
    private controller: Pick<
      RoomController,
      'room' | 'stageAttachment' | 'updateDraft' | 'submitDraft'
    >,
    readonly launchDirectory = process.cwd(),
    private sources = { file: readAttachmentPath, clipboard: readClipboardImage },
  ) {}
  async action(
    line: string,
    room: Room,
    signal?: AbortSignal,
    dispatched?: () => void,
  ): Promise<string> {
    const action = parseAttachmentAction(line);
    const current = () => {
      signal?.throwIfAborted();
      if (this.controller.room !== room)
        throw new Error('Conversation changed; retry in the original room.');
    };
    current(); // Establish terminal/session authority before any filesystem operation.
    if (action.kind === 'help') return attachmentHelp;
    if (action.kind === 'status') {
      // Read-only: the saved caption decides the recipients; nothing is staged or sent.
      const snapshot = projectRoom(room);
      return formatImageRecipientStatus({
        line: room.session.composerDraft ?? '',
        participants: snapshot.agents,
        messages: room.session.messages,
        invalidRoom: Boolean(snapshot.fatal),
      });
    }
    const attachments = room.session.composerAttachments ?? [];
    if (action.kind === 'list')
      return attachments.length
        ? attachments.map((a) => 'Staged ' + attachmentLabel(a)).join('\n')
        : 'No staged images.';
    const revision = room.session.composerDraftRevision ?? 0;
    const text = room.session.composerDraft ?? '';
    let ids = attachments.map((a) => a.id);
    let result = 'Image removed from draft.';
    if (action.kind === 'remove') {
      if (!ids.includes(action.id)) throw new Error('That attachment is not in the current draft.');
      ids = ids.filter((id) => id !== action.id);
    } else {
      const operationId = randomUUID();
      const source =
        action.kind === 'clipboard'
          ? await this.sources.clipboard(signal)
          : await this.sources.file(action.path, this.launchDirectory, signal);
      current();
      const attachment = await this.controller.stageAttachment({
        ...source,
        mediaType: 'image/png',
        sessionId: room.session.id,
        operationId,
      });
      current();
      ids.push(attachment.id);
      result = 'Staged ' + attachmentLabel(attachment);
    }
    current();
    dispatched?.();
    const saved = await this.controller.updateDraft(
      {
        text,
        attachmentIds: ids,
        baseRevision: revision,
        clientId: this.clientId,
        version: ++this.version,
      },
      room.session.id,
    );
    if (!saved.accepted)
      throw new Error('Draft update was stale; check the current draft and retry.');
    return result;
  }
  async send(line: string, room: Room): Promise<DraftSubmissionResult> {
    if (this.controller.room !== room)
      throw new Error('Conversation changed; message was not sent.');
    const ids = (room.session.composerAttachments ?? []).map((a) => a.id);
    if (!ids.length) throw new Error('No staged images.');
    if (
      !this.pending ||
      this.pending.room !== room ||
      this.pending.line !== line ||
      JSON.stringify(this.pending.ids) !== JSON.stringify(ids)
    )
      this.pending = { room, line, ids, operationId: randomUUID() };
    const pending = this.pending;
    const result = await this.controller.submitDraft({
      source: 'terminal-attachments',
      line,
      sessionId: room.session.id,
      attachmentIds: ids,
      operationId: pending.operationId,
      draft: {
        clientId: this.clientId,
        version: ++this.version,
        baseRevision: room.session.composerDraftRevision ?? 0,
      },
    });
    // A lost acknowledgement is resolved from C2's committed operation, never resent as a new send.
    if (result.commitment.status === 'committed' && this.pending === pending)
      this.pending = undefined;
    if (result.dispatch.status === 'failed' && result.commitment.status !== 'committed')
      throw new Error(result.dispatch.error);
    return result;
  }
}
