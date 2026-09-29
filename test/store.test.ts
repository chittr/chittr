import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/store.js';
import { newSession } from '../src/room.js';
it('locks a workspace, atomically saves history, and refuses corrupt data without replacement', () => {
  const base = mkdtempSync(join(tmpdir(), 'chittr-store-'));
  const a = new SessionStore('/workspace', base),
    b = new SessionStore('/workspace', base);
  try {
    a.acquire();
    expect(() => b.acquire()).toThrow('already owns');
    const session = newSession({
      workspace: '/workspace',
      permissions: { edits: false, commands: false, network: false },
      sources: [],
      provenance: {},
      agents: {},
      followUpTurns: 8,
    });
    a.save(session);
    expect(a.load()?.id).toBe(session.id);
    expect(a.list()).toHaveLength(1);
    expect(() => a.load('../escape')).toThrow('Invalid');
    const path = join(a.directory, session.id, 'session.json');
    writeFileSync(path, 'corrupt');
    expect(() => a.load()).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('corrupt');
    a.release();
    b.acquire();
    b.release();
  } finally {
    a.release();
    b.release();
    rmSync(base, { recursive: true, force: true });
  }
});
