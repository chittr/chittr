import { it, expect } from 'vitest';
import stringWidth from 'string-width';
import { Room } from '../src/room.js';
import { cleanText } from '../src/ui/input.js';
import { composerPrefix, transcript } from '../src/ui/terminal.js';
import { projectRoom } from '../src/snapshot.js';
import type { RoomConfig } from '../src/types.js';
const config: RoomConfig = {
  workspace: '/workspace',
  humanName: 'Bill',
  permissions: { edits: false, commands: false, network: false },
  agents: {},
  followUpTurns: 8,
  sources: [],
  provenance: {},
};
it('labels existing human messages and directed recipients using the current display name', async () => {
  const room = new Room(config, { save() {} });
  room.send('@human An existing note');
  const saved = structuredClone(room.session);
  await room.close();
  const restored = new Room({ ...config, humanName: 'Zoë' }, { save() {} }, saved);
  const text = transcript(projectRoom(restored), 80)
    .map((line) => cleanText(line.text))
    .join('\n');
  expect(text).toContain('Zoë  #m1 → Zoë');
  expect(restored.message('m1')!.author).toBe('human');
  expect(restored.message('m1')!.recipients).toEqual(['human']);
  await restored.close();
});
it.each([12, 40, 80])('leaves room for typing with long or wide names at %i columns', (width) => {
  for (const name of ['Bill McGlone', '界'.repeat(80), '👩‍💻'.repeat(20)]) {
    const prefix = composerPrefix(name, width);
    expect(prefix.endsWith(' › ')).toBe(true);
    expect(stringWidth(prefix)).toBeLessThanOrEqual(width - 4);
  }
});
