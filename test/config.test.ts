import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadConfig, writeStarter } from '../src/config.js';
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chittr-config-'));
  roots.push(root);
  const home = join(root, 'home'),
    project = join(root, 'project'),
    nested = join(project, 'nested');
  for (const dir of [home, project, nested]) mkdirSync(join(dir, '.agents'), { recursive: true });
  return { root, home, project, nested };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('selects shared instructions independently of the roster, replacing and clearing user sources', () => {
  const { home, project } = fixture();
  const user = join(home, '.agents/chittr.yaml');
  const local = join(project, '.agents/chittr.yaml');
  writeFileSync(
    user,
    `version: 1
skills: {enabled: false}
instructions: {sources: [{text: User room guidance}]}
defaultAgents:
  codex: {provider: codex, instructions: {sources: [{text: Agent guidance}]}}
  claude: {provider: claude}
`,
  );
  const inherited = loadConfig(project, home)!;
  expect(inherited.instructions).toBe('User room guidance');
  expect(inherited.provenance.instructions).toBe(user);
  writeFileSync(join(project, '.agents/local.md'), 'Project file');
  writeFileSync(join(home, 'home.md'), 'Home file');
  writeFileSync(
    local,
    `version: 1
instructions: {sources: [{text: First}, {file: local.md}, {file: ~/home.md}, {text: Last}]}
`,
  );
  const selected = loadConfig(project, home)!;
  expect(selected.instructions).toBe(
    `First\n\nInstructions from ${join(realpathSync(project), '.agents/local.md')}:\nProject file\n\nInstructions from ${join(home, 'home.md')}:\nHome file\n\nLast`,
  );
  expect(Object.keys(selected.agents)).toEqual(['codex', 'claude']);
  expect(selected.agents.codex!.instructions).toBe('Agent guidance');
  expect(selected.provenance.instructions).toBe(realpathSync(local));
  // Config fingerprints remain the base identities; Room adds session-aware shared identity.
  expect(selected.agents.codex!.fingerprint).toBe(inherited.agents.codex!.fingerprint);
  for (const clearing of ['{}', '{sources: []}']) {
    writeFileSync(local, `version: 1\ninstructions: ${clearing}\n`);
    const cleared = loadConfig(project, home)!;
    expect(cleared.instructions).toBe('');
    expect(cleared.provenance.instructions).toBe(realpathSync(local));
    expect(cleared.agents.codex!.fingerprint).toBe(inherited.agents.codex!.fingerprint);
  }
});

it('does not read unselected user room files and rejects selected failures with source context', () => {
  const { home, project } = fixture();
  writeStarter(['codex'], home);
  const user = join(home, '.agents/chittr.yaml');
  writeFileSync(
    user,
    readFileSync(user, 'utf8') + '\ninstructions: {sources: [{file: missing.md}]}\n',
  );
  expect(() => loadConfig(project, home)).toThrow(`${user}: instructions:`);
  const local = join(project, '.agents/chittr.yaml');
  writeFileSync(local, 'version: 1\ninstructions: {}\n');
  expect(loadConfig(project, home)!.instructions).toBe('');
  writeFileSync(local, 'version: 1\ninstructions: {sources: [{file: missing.md}]}\n');
  expect(() => loadConfig(project, home)).toThrow(`${local}: instructions:`);
  writeFileSync(join(project, '.agents/huge.md'), 'x'.repeat(1024 * 1024 + 1));
  writeFileSync(local, 'version: 1\ninstructions: {sources: [{file: huge.md}]}\n');
  expect(() => loadConfig(project, home)).toThrow('exceeds 1 MiB');
  for (const value of [
    '{mode: replace}',
    '{sources: [{text: ok, file: bad}]}',
    '{sources: [42]}',
    'null',
  ]) {
    writeFileSync(local, `version: 1\ninstructions: ${value}\n`);
    expect(() => loadConfig(project, home)).toThrow();
  }
});
describe('config contract', () => {
  it('ignores pilot config before and after Chittr setup without changing the old files', () => {
    const { home, project } = fixture();
    const oldUser = join(home, '.agents/ai-chat.yaml');
    const oldProject = join(project, '.agents/ai-chat.yaml');
    const userBytes = 'invalid old YAML: [\n';
    const projectBytes = 'version: 1\npermissions: {edits: true, commands: true, network: true}\n';
    writeFileSync(oldUser, userBytes);
    writeFileSync(oldProject, projectBytes);
    expect(loadConfig(project, home)).toBeUndefined();
    writeStarter(['codex'], home);
    const config = loadConfig(project, home)!;
    expect(config.permissions).toEqual({ edits: false, commands: false, network: false });
    expect(Object.keys(config.agents)).toEqual(['codex']);
    expect(config.sources).toEqual([join(home, '.agents/chittr.yaml')]);
    expect(readFileSync(oldUser, 'utf8')).toBe(userBytes);
    expect(readFileSync(oldProject, 'utf8')).toBe(projectBytes);
  });
  it('uses user defaults when the project omits agents, even with other project settings', () => {
    const { home, project } = fixture();
    writeStarter(['codex', 'claude', 'grok', 'antigravity'], home);
    writeFileSync(
      join(project, '.agents/chittr.yaml'),
      'version: 1\nhuman: {name: Alex}\npermissions: {network: true}\n',
    );
    const config = loadConfig(project, home)!;
    expect(Object.keys(config.agents)).toEqual(['codex', 'claude', 'grok', 'antigravity']);
    expect(config.humanName).toBe('Alex');
    expect(config.permissions.network).toBe(true);
    expect(config.provenance['defaultAgents.codex.provider']).toBe(
      join(home, '.agents/chittr.yaml'),
    );
  });
  it('merges room settings without walking to a parent project or merging agent definitions', () => {
    const { home, project, nested } = fixture();
    writeFileSync(
      join(home, '.agents/chittr.yaml'),
      'version: 1\npermissions: {edits: true, commands: true}\ndefaultAgents:\n  codex: {provider: codex, model: test-model, effort: high, enabled: false, instructions: {sources: [{text: User guidance}]}}\n  claude: {provider: claude}\n',
    );
    writeFileSync(
      join(project, '.agents/chittr.yaml'),
      'version: 1\npermissions: {network: true}\n',
    );
    writeFileSync(
      join(nested, '.agents/chittr.yaml'),
      'version: 1\npermissions: {edits: false}\nagents:\n  codex: {provider: codex}\n',
    );
    const c = loadConfig(nested, home)!;
    expect(c.permissions).toEqual({ edits: false, commands: true, network: false });
    expect(c.agents.codex).toMatchObject({
      provider: 'codex',
      enabled: true,
      instructions: '',
    });
    expect(c.agents.codex!.model).toBeUndefined();
    expect(c.agents.codex!.effort).toBeUndefined();
    expect(Object.keys(c.agents)).toEqual(['codex']);
    expect(c.provenance['defaultAgents.codex.model']).toBeUndefined();
    expect(c.sources).toHaveLength(2);
  });
  it('resolves instructions relative to the selected config and preserves their listed order', () => {
    const { home, project } = fixture();
    writeFileSync(join(home, '.agents/global.md'), 'Global file');
    writeFileSync(join(project, '.agents/local.md'), 'Local file');
    writeFileSync(
      join(home, '.agents/chittr.yaml'),
      'version: 1\ndefaultAgents:\n  codex:\n    provider: codex\n    instructions:\n      sources: [{text: Global inline}, {file: global.md}]\n',
    );
    const fallback = loadConfig(project, home)!;
    expect(fallback.agents.codex!.instructions).toContain(
      `Instructions from ${join(home, '.agents/global.md')}`,
    );
    expect(fallback.agents.codex!.instructions.indexOf('Global inline')).toBeLessThan(
      fallback.agents.codex!.instructions.indexOf('Global file'),
    );
    writeFileSync(
      join(project, '.agents/chittr.yaml'),
      'version: 1\nagents:\n  codex:\n    provider: codex\n    instructions:\n      sources: [{file: local.md}, {text: Local inline}]\n',
    );
    const first = loadConfig(project, home)!;
    const instruction = first.agents.codex!.instructions;
    expect(instruction).not.toContain('Global');
    expect(instruction.indexOf('Local file')).toBeLessThan(instruction.indexOf('Local inline'));
    writeFileSync(
      join(project, '.agents/chittr.yaml'),
      'version: 1\nagents:\n  codex:\n    provider: codex\n    instructions: {mode: replace, sources: []}\n',
    );
    const second = loadConfig(project, home)!;
    expect(second.agents.codex!.instructions).toBe('');
    expect(second.agents.codex!.fingerprint).not.toBe(first.agents.codex!.fingerprint);
  });
  it.each([
    'version: 1\nagents: {codex: {provider: codex, permissions: {edits: true}}}',
    'version: 1\npermissions: {edits: "false"}',
    'version: 2',
    'version: 1\nversion: 1',
    'version: 1\nagents: {human: {provider: codex}}',
    'version: 1\nagents: {codex: {provider: codex, effort: ""}}',
    'version: 1\nagents: {codex: {provider: codex, effort: 2}}',
    'version: 1\nagents: {codex: {provider: codex, effort: "high\\nlow"}}',
  ])('rejects invalid config without silent fallback: %s', (text) => {
    const { home, project } = fixture();
    writeFileSync(join(project, '.agents/chittr.yaml'), text);
    expect(() => loadConfig(project, home)).toThrow();
  });
  it('writes only explicitly selected default agents without models or stock instructions', () => {
    const { home, project } = fixture();
    expect(loadConfig(project, home)).toBeUndefined();
    const path = writeStarter(['codex'], home);
    const raw = parse(readFileSync(path, 'utf8'));
    expect(raw.defaultAgents).toEqual({ codex: { provider: 'codex' } });
    expect(raw.agents).toBeUndefined();
    const c = loadConfig(project, home)!;
    expect(c.permissions).toEqual({ edits: false, commands: false, network: false });
    expect(c.agents.codex!.model).toBeUndefined();
    expect(c.agents.codex!.instructions).toBe('');
    expect(() => writeStarter(['codex'], home)).toThrow();
  });
});

it.each(['agents', 'defaultAgents'])(
  'loads independent effort settings from %s and fingerprints changes and removal',
  (key) => {
    const { home, project } = fixture();
    const path = join(key === 'agents' ? project : home, '.agents/chittr.yaml');
    const write = (effort?: string) =>
      writeFileSync(
        path,
        `version: 1
skills: {enabled: false}
${key}:
  astra: {provider: codex, model: gpt-6-astra${effort ? `, effort: ${effort}` : ''}}
  sol: {provider: codex, model: gpt-5.6-sol, effort: medium}
`,
      );
    write('high');
    const first = loadConfig(project, home)!;
    expect(first.agents.astra!.effort).toBe('high');
    expect(first.agents.sol!.effort).toBe('medium');
    expect(realpathSync(first.provenance[`${key}.astra.effort`]!)).toBe(realpathSync(path));
    write('xhigh');
    const second = loadConfig(project, home)!;
    expect(second.agents.astra!.fingerprint).not.toBe(first.agents.astra!.fingerprint);
    expect(second.agents.sol!.fingerprint).toBe(first.agents.sol!.fingerprint);
    write();
    const third = loadConfig(project, home)!;
    expect(third.agents.astra!.effort).toBeUndefined();
    expect(third.agents.astra!.fingerprint).not.toBe(second.agents.astra!.fingerprint);
    expect(third.provenance[`${key}.astra.effort`]).toBeUndefined();
  },
);

it.each([
  ['codex', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['claude', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['grok', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['antigravity', ['low', 'medium', 'high']],
] as const)('accepts the effort vocabulary for %s', (provider, levels) => {
  const { home, project } = fixture();
  for (const effort of levels) {
    writeFileSync(
      join(project, '.agents/chittr.yaml'),
      `version: 1\nskills: {enabled: false}\nagents: {reviewer: {provider: ${provider}, effort: ${effort}}}`,
    );
    expect(loadConfig(project, home)!.agents.reviewer!.effort).toBe(effort);
  }
});

it.each(['agents', 'defaultAgents'])(
  'rejects invalid %s efforts with the provider and accepted values',
  (key) => {
    const { home, project } = fixture();
    const path = join(key === 'agents' ? project : home, '.agents/chittr.yaml');
    for (const [provider, invalid, accepted] of [
      ['codex', 'hihg', 'none, minimal, low, medium, high, xhigh, max, ultra'],
      ['codex', 'auto', 'none, minimal, low, medium, high, xhigh, max, ultra'],
      ['claude', 'minimal', 'low, medium, high, xhigh, max'],
      ['grok', 'ultra', 'none, minimal, low, medium, high, xhigh, max'],
      ['antigravity', 'max', 'low, medium, high'],
      ['antigravity', 'HIGH', 'low, medium, high'],
      ['antigravity', '', 'low, medium, high'],
    ]) {
      writeFileSync(
        path,
        `version: 1\n${key}: {reviewer: {provider: ${provider}, effort: "${invalid}"}}`,
      );
      try {
        loadConfig(project, home);
        expect.fail('Invalid effort must be rejected');
      } catch (error) {
        expect(String(error)).toContain(
          `Unsupported effort \\"${invalid}\\" for ${provider}. Accepted values: ${accepted}`,
        );
        expect(String(error)).toContain('chittr.yaml');
        expect(String(error)).toContain('reviewer');
        expect(String(error)).toContain('effort');
      }
    }
  },
);

it('requires at least one provider in a starter config', () => {
  const { home } = fixture();
  expect(() => writeStarter([], home)).toThrow('Select at least one');
});

it.each(['defaultAgents', 'agents'])(
  'replaces user %s entirely and does not read unused instruction files',
  (key) => {
    const { home, project } = fixture();
    writeFileSync(
      join(home, '.agents/chittr.yaml'),
      `version: 1
${key}:
  codex: {provider: codex, instructions: {sources: [{file: missing.md}]}}
  claude: {provider: claude}
`,
    );
    writeFileSync(
      join(project, '.agents/chittr.yaml'),
      `version: 1
agents:
  astra: {provider: codex, model: gpt-6-astra}
  sol: {provider: codex, model: gpt-5.6-sol}
`,
    );
    expect(Object.keys(loadConfig(project, home)!.agents)).toEqual(['astra', 'sol']);
    rmSync(join(project, '.agents/chittr.yaml'));
    expect(() => loadConfig(project, home)).toThrow(`${key}.codex.instructions`);
  },
);

it('preserves legacy user agent settings as a fallback without rewriting the config', () => {
  const { home, project } = fixture();
  const path = join(home, '.agents/chittr.yaml');
  const original =
    'version: 1\n# Personal choices\nagents:\n  reviewer: {provider: codex, model: custom, instructions: {sources: [{text: Personal guidance}]}}\n';
  writeFileSync(path, original);
  const legacy = loadConfig(project, home)!;
  expect(legacy.agents.reviewer).toMatchObject({
    id: 'reviewer',
    model: 'custom',
    instructions: 'Personal guidance',
  });
  expect(readFileSync(path, 'utf8')).toBe(original);
  writeFileSync(path, original.replace('\nagents:', '\ndefaultAgents:'));
  expect(loadConfig(project, home)!.agents).toEqual(legacy.agents);
});

it('reads the user config once when the launch directory is the user home', () => {
  const { home } = fixture();
  writeStarter(['claude'], home);
  const config = loadConfig(home, home)!;
  expect(config.sources).toHaveLength(1);
  expect(Object.keys(config.agents)).toEqual(['claude']);
});

it.each([
  ['version: 1\nagents: {}\n', 'agents is empty'],
  ['version: 1\nagents: {codex: {model: custom}}\n', 'provider is required'],
  [
    'version: 1\ndefaultAgents: {codex: {provider: codex}}\n',
    'defaultAgents belongs in user config',
  ],
])(
  'rejects explicit empty or incomplete project rosters without falling back: %s',
  (text, error) => {
    const { home, project } = fixture();
    writeStarter(['codex', 'claude'], home);
    writeFileSync(join(project, '.agents/chittr.yaml'), text!);
    expect(() => loadConfig(project, home)).toThrow(error);
  },
);

it('rejects ambiguous user rosters and reports missing agent configuration', () => {
  const { home, project } = fixture();
  const path = join(home, '.agents/chittr.yaml');
  writeFileSync(path, 'version: 1\nagents: {}\ndefaultAgents: {}\n');
  expect(() => loadConfig(project, home)).toThrow('cannot be combined');
  writeFileSync(path, 'version: 1\ndefaultAgents: {}\n');
  expect(() => loadConfig(project, home)).toThrow('defaultAgents is empty');
  writeFileSync(path, 'version: 1\nhuman: {name: Alex}\n');
  expect(() => loadConfig(project, home)).toThrow('No agents configured');
});

it('inherits the human name from the user config and records explicit project overrides', () => {
  const { home, project } = fixture();
  writeStarter(['codex'], home, 'Bill');
  const userPath = join(home, '.agents/chittr.yaml');
  const projectPath = join(project, '.agents/chittr.yaml');
  writeFileSync(projectPath, 'version: 1\nhuman: {}\n');
  expect(loadConfig(project, home)).toMatchObject({
    humanName: 'Bill',
    provenance: { 'human.name': userPath },
  });
  writeFileSync(projectPath, 'version: 1\nhuman: {name: "  Zoë 👩‍💻  "}\n');
  expect(loadConfig(project, home)).toMatchObject({
    humanName: 'Zoë 👩‍💻',
    provenance: { 'human.name': realpathSync(projectPath) },
  });
});
it('keeps configurations without a human name valid and defaults the label to You', () => {
  const { home, project } = fixture();
  writeFileSync(
    join(project, '.agents/chittr.yaml'),
    'version: 1\nagents: {codex: {provider: codex}}\n',
  );
  expect(loadConfig(project, home)!.humanName).toBe('You');
});
it('uses configured keys as participant IDs independently of the provider', () => {
  const { home, project } = fixture();
  const userPath = join(home, '.agents/chittr.yaml');
  writeFileSync(
    userPath,
    `version: 1
skills: {enabled: false}
defaultAgents:
  astra: {provider: codex, model: gpt-6-astra}
  sol: {provider: codex, model: gpt-5.6-sol}
  gemini: {provider: antigravity}
`,
  );
  const initial = loadConfig(project, home)!;
  expect(initial.agents.astra).toMatchObject({
    id: 'astra',
    provider: 'codex',
    model: 'gpt-6-astra',
  });
  expect(initial.agents.sol).toMatchObject({
    id: 'sol',
    provider: 'codex',
    model: 'gpt-5.6-sol',
  });
  expect(initial.agents.gemini).toMatchObject({ id: 'gemini', provider: 'antigravity' });
  expect(Object.keys(initial.agents)).toEqual(['astra', 'sol', 'gemini']);
});
it.each(['agents', 'defaultAgents'])('rejects separate agent names in %s', (key) => {
  const { home, project } = fixture();
  writeFileSync(
    join(key === 'defaultAgents' ? home : project, '.agents/chittr.yaml'),
    JSON.stringify({
      version: 1,
      [key]: { antigravity: { provider: 'antigravity', name: 'gemini' } },
    }),
  );
  expect(() => loadConfig(project, home)).toThrow('name');
});
it.each(['', '  ', 'Bill\nJones', '\x1b[31mBill', 'x'.repeat(81)])(
  'rejects unusable display names: %j',
  (name) => {
    const { home, project } = fixture();
    writeFileSync(
      join(project, '.agents/chittr.yaml'),
      JSON.stringify({ version: 1, human: { name }, agents: { codex: { provider: 'codex' } } }),
    );
    expect(() => loadConfig(project, home)).toThrow();
  },
);
