import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, skillInstructions } from '../src/skills.js';
import { fileOperation } from '../src/tool-worker.js';
import { loadConfig } from '../src/config.js';
import { instructions } from '../src/protocol.js';
import { Room } from '../src/room.js';
import type { AgentAdapter } from '../src/types.js';

const fixtures: string[] = [];
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-skills-')));
  fixtures.push(base);
  const home = join(base, 'home'),
    workspace = join(base, 'workspace');
  for (const path of [
    join(home, '.agents/skills'),
    join(home, '.claude/skills'),
    join(workspace, '.agents'),
  ])
    mkdirSync(path, { recursive: true });
  writeFileSync(
    join(workspace, '.agents/chittr.yaml'),
    'version: 1\nagents: {codex: {provider: codex}, claude: {provider: claude}}\n',
  );
  const bundle = (path: string, name = 'review') => {
    mkdirSync(join(path, 'references'), { recursive: true });
    writeFileSync(
      join(path, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Review a proposed change\n---\nRead references/checks.md.\n`,
    );
    writeFileSync(join(path, 'references/checks.md'), 'Look for missing cases.');
    writeFileSync(join(path, 'helper.sh'), 'echo sample');
    return path;
  };
  return { base, home, workspace, bundle };
}
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('skill discovery and file access', () => {
  it('discovers Grok and Antigravity bundles without exposing the other provider homes', () => {
    const { home, workspace, bundle } = fixture();
    bundle(join(home, '.grok/skills/user'), 'grok-user');
    bundle(join(workspace, '.grok/skills/project'), 'grok-project');
    bundle(join(home, '.gemini/config/skills/user'), 'agy-user');
    bundle(join(home, '.gemini/antigravity/skills/legacy'), 'agy-legacy');
    bundle(join(workspace, '.agents/skills/project'), 'agy-project');
    expect(
      discoverSkills('grok', workspace, home)
        .bundles.map((s) => s.name)
        .sort(),
    ).toEqual(['agy-project', 'grok-project', 'grok-user']);
    expect(
      discoverSkills('antigravity', workspace, home)
        .bundles.map((s) => s.name)
        .sort(),
    ).toEqual(['agy-legacy', 'agy-project', 'agy-user']);
  });
  it('finds provider-specific, project, legacy, and nested system skills through directory symlinks', () => {
    const { base, home, workspace, bundle } = fixture();
    const source = bundle(join(base, 'store/codex-version'), 'codex-review');
    symlinkSync(source, join(home, '.agents/skills/review'));
    symlinkSync(source, join(home, '.agents/skills/duplicate'));
    bundle(join(home, '.claude/skills/review'), 'claude-review');
    bundle(join(home, '.codex/skills/.system/helper'), 'system-helper');
    bundle(join(workspace, '.agents/skills/project'), 'project-helper');
    const codex = discoverSkills('codex', workspace, home);
    expect(codex.bundles.map((s) => s.name).sort()).toEqual([
      'codex-review',
      'project-helper',
      'system-helper',
    ]);
    expect(codex.bundles.find((s) => s.name === 'codex-review')?.root).toBe(source);
    expect(discoverSkills('claude', workspace, home).bundles.map((s) => s.name)).toEqual([
      'claude-review',
    ]);
    expect(codex.warnings).toEqual([]);
  });

  it('reads and lists linked bundles and internal links without granting siblings or arbitrary link destinations', () => {
    const { base, home, workspace, bundle } = fixture();
    const source = bundle(join(base, 'store/review'));
    const alias = join(home, '.agents/skills/review');
    symlinkSync(source, alias);
    symlinkSync('references', join(source, 'ref-link'));
    symlinkSync(source, join(source, 'cycle'));
    writeFileSync(join(base, 'store/private.txt'), 'private');
    symlinkSync('../private.txt', join(source, 'escape'));
    const skills = discoverSkills('codex', workspace, home).bundles;
    const read = (path: string) =>
      fileOperation(workspace, 'read_file', { path }, skills) as { text: string; path: string };
    expect(read(join(alias, 'SKILL.md')).text).toContain('Read references/checks.md');
    expect(read(join(alias, 'SKILL.md')).path).toBe(join(alias, 'SKILL.md'));
    expect(read(join(alias, 'ref-link/checks.md')).text).toBe('Look for missing cases.');
    expect(read(join(source, 'helper.sh')).text).toBe('echo sample');
    expect(() => read(join(alias, 'escape'))).toThrow(/outside.*bundles/);
    expect(() => read(join(alias, '../private.txt'))).toThrow(/launch directory/);
    expect(() => read(join(base, 'store/private.txt'))).toThrow(/launch directory/);
    const listing = fileOperation(
      workspace,
      'list_files',
      { path: alias, recursive: true },
      skills,
    ) as { entries: string[] };
    expect(listing.entries.some((e) => e.includes('checks.md'))).toBe(true);
    expect(listing.entries.every((e) => e.startsWith(alias + '/'))).toBe(true);
    expect(listing.entries.some((e) => e.endsWith('escape [symlink, not traversed]'))).toBe(true);
    expect(listing.entries.length).toBeLessThan(15);
    expect(() =>
      fileOperation(workspace, 'write_file', { path: join(alias, 'new.md'), text: 'bad' }, skills),
    ).toThrow(/read-only/);
    expect(() =>
      fileOperation(
        workspace,
        'write_file',
        { path: join(source, 'SKILL.md'), text: 'bad' },
        skills,
      ),
    ).toThrow(/read-only/);
  });

  it('rejects retargeted links until reload and revokes access to the previous destination', () => {
    const { base, home, workspace, bundle } = fixture();
    const first = bundle(join(base, 'store/v1')),
      second = bundle(join(base, 'store/v2'));
    const alias = join(home, '.agents/skills/review');
    symlinkSync(first, alias);
    const before = loadConfig(workspace, home)!;
    unlinkSync(alias);
    symlinkSync(second, alias);
    expect(() =>
      fileOperation(
        workspace,
        'read_file',
        { path: join(alias, 'SKILL.md') },
        before.agents.codex!.skills!.bundles,
      ),
    ).toThrow(/Reload/);
    const after = loadConfig(workspace, home)!;
    expect(after.agents.codex!.fingerprint).not.toBe(before.agents.codex!.fingerprint);
    expect(after.agents.claude!.fingerprint).toBe(before.agents.claude!.fingerprint);
    expect(() =>
      fileOperation(
        workspace,
        'read_file',
        { path: join(first, 'SKILL.md') },
        after.agents.codex!.skills!.bundles,
      ),
    ).toThrow(/launch directory/);
    expect(
      fileOperation(
        workspace,
        'read_file',
        { path: join(alias, 'SKILL.md') },
        after.agents.codex!.skills!.bundles,
      ),
    ).toMatchObject({ text: expect.stringContaining('Review') });
  });

  it('keeps installed project bundles read-only and unrelated workspace symlinks blocked', () => {
    const { workspace, home, bundle } = fixture();
    const source = bundle(join(workspace, '.agents/skills/review'));
    writeFileSync(join(workspace, 'ordinary.md'), 'ordinary');
    symlinkSync('ordinary.md', join(workspace, 'ordinary-link'));
    const skills = discoverSkills('codex', workspace, home).bundles;
    expect(() =>
      fileOperation(
        workspace,
        'write_file',
        { path: join(source, 'SKILL.md'), text: 'bad' },
        skills,
      ),
    ).toThrow(/read-only/);
    expect(() => fileOperation(workspace, 'read_file', { path: 'ordinary-link' }, skills)).toThrow(
      /Symlink/,
    );
    expect(fileOperation(workspace, 'read_file', { path: 'ordinary.md' }, skills)).toMatchObject({
      text: 'ordinary',
    });
  });

  it('reports broken links and invalid manifests, does not read escaping SKILL.md, and tolerates discovery cycles', () => {
    const { base, home, workspace, bundle } = fixture();
    const root = join(home, '.agents/skills');
    symlinkSync(join(base, 'missing'), join(root, 'broken'));
    symlinkSync(root, join(root, 'cycle'));
    const bad = bundle(join(root, 'bad'));
    writeFileSync(join(bad, 'SKILL.md'), '---\nname: [\n---\n');
    const escape = bundle(join(root, 'escape'));
    unlinkSync(join(escape, 'SKILL.md'));
    writeFileSync(join(base, 'secret.md'), 'SECRET');
    symlinkSync(join(base, 'secret.md'), join(escape, 'SKILL.md'));
    const catalog = discoverSkills('codex', workspace, home);
    expect(catalog.bundles).toEqual([]);
    expect(catalog.warnings).toHaveLength(3);
    expect(JSON.stringify(catalog)).not.toContain('SECRET');
  });
});

it('defaults skills on, merges the one boolean, exposes opt-out, and preserves command permissions', () => {
  const { home, workspace, bundle } = fixture();
  bundle(join(home, '.agents/skills/review'));
  const initial = loadConfig(workspace, home)!;
  expect(initial.skills).toEqual({ enabled: true });
  expect(initial.agents.codex!.skills!.bundles).toHaveLength(1);
  expect(initial.permissions).toEqual({ edits: false, commands: false, network: false });
  const prompt = instructions(initial.agents.codex!, initial);
  expect(prompt).toContain('review/SKILL.md');
  expect(prompt).toContain('Running a script still requires the room command permission');
  writeFileSync(join(home, '.agents/chittr.yaml'), 'version: 1\nskills: {enabled: false}\n');
  const disabled = loadConfig(workspace, home)!;
  expect(disabled.skills).toEqual({ enabled: false });
  expect(disabled.agents.codex!.skills).toBeUndefined();
  expect(instructions(disabled.agents.codex!, disabled)).toContain('Skills are disabled');
  expect(disabled.agents.codex!.fingerprint).not.toBe(initial.agents.codex!.fingerprint);
  writeFileSync(
    join(workspace, '.agents/chittr.yaml'),
    'version: 1\nskills: {enabled: true}\nagents: {codex: {provider: codex}}\n',
  );
  expect(loadConfig(workspace, home)!.skills?.enabled).toBe(true);
  writeFileSync(join(workspace, '.agents/chittr.yaml'), 'version: 1\nskills: {enabled: "false"}\n');
  expect(() => loadConfig(workspace, home)).toThrow();
});

it('keeps explicit-only skills discoverable without loading their bodies into the prompt', () => {
  const { home, workspace, bundle } = fixture();
  const path = bundle(join(home, '.claude/skills/review'));
  writeFileSync(
    join(path, 'SKILL.md'),
    '---\nname: review\ndescription: Review things\ndisable-model-invocation: true\n---\nBODY_SENTINEL\n',
  );
  const catalog = discoverSkills('claude', workspace, home);
  expect(catalog.bundles[0]?.explicitOnly).toBe(true);
  expect(skillInstructions(catalog)).toContain('explicitOnly require an explicit human request');
  expect(skillInstructions(catalog)).not.toContain('BODY_SENTINEL');
});

it('refreshes changed agents on idle reload and resets their saved native context', async () => {
  const { base, home, workspace, bundle } = fixture();
  const alias = join(home, '.agents/skills/review');
  symlinkSync(bundle(join(base, 'v1')), alias);
  const starts: [string, string | undefined][] = [];
  const make = (id: string): AgentAdapter => ({
    start: async (sessionId) => {
      starts.push([id, sessionId]);
      return { sessionId: 'native', restored: false };
    },
    run: async () => ({ outcomes: [] }),
    interrupt: async () => {},
    close: async () => {},
  });
  const room = new Room(loadConfig(workspace, home)!, { save() {} }, undefined, (agent) =>
    make(agent.id),
  );
  await room.start();
  unlinkSync(alias);
  symlinkSync(bundle(join(base, 'v2')), alias);
  await room.reload(loadConfig(workspace, home)!);
  expect(starts).toEqual([
    ['codex', undefined],
    ['claude', undefined],
    ['codex', undefined],
  ]);
  expect(room.session.notices.some((n) => n.text.includes('codex: fresh provider session'))).toBe(
    true,
  );
  await room.close();
});
