import { readFileSync, existsSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import type { AgentConfig, RoomConfig, SkillCatalog, Provider } from './types.js';
import { effortError, providerIds } from './providers.js';
import { discoverSkills } from './skills.js';
import { resolveCommandAccess } from './command-access.js';
import { readInstructionFile } from './instructions.js';

const displayName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value),
    'Use a single-line display name without control characters',
  );
const source = z.union([
  z.object({ text: z.string() }).strict(),
  z.object({ file: z.string().min(1) }).strict(),
]);
const agent = z
  .object({
    provider: z.enum(providerIds).optional(),
    enabled: z.boolean().optional(),
    model: z.string().min(1).optional(),
    effort: z.string().trim().optional(),
    instructions: z
      .object({
        mode: z.enum(['append', 'replace']).optional(),
        sources: z.array(source).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider && value.effort !== undefined) {
      const message = effortError(value.provider, value.effort);
      if (message) context.addIssue({ code: 'custom', path: ['effort'], message });
    }
  });
const agents = z.record(
  z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/)
    .refine(
      (v) => !['human', 'all', '__proto__', 'constructor', 'prototype'].includes(v),
      'Reserved agent name',
    ),
  agent,
);
const schema = z
  .object({
    version: z.literal(1),
    instructions: z
      .object({ sources: z.array(source).optional() })
      .strict()
      .optional(),
    human: z.object({ name: displayName.optional() }).strict().optional(),
    skills: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    conversation: z
      .object({ follow_up_turns: z.number().int().min(1).max(1000).optional() })
      .strict()
      .optional(),
    permissions: z
      .object({
        edits: z.boolean().optional(),
        commands: z.boolean().optional(),
        network: z.boolean().optional(),
      })
      .strict()
      .optional(),
    agents: agents.optional(),
    defaultAgents: agents.optional(),
    trustedCommands: z
      .object({ workspaces: z.array(z.string().min(1)) })
      .strict()
      .optional(),
  })
  .strict();
export class ConfigError extends Error {}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function configPaths(workspace: string, home = homedir()): string[] {
  const seen = new Set<string>();
  return [join(home, '.agents', 'chittr.yaml'), join(workspace, '.agents', 'chittr.yaml')].filter(
    (path) => {
      const canonical = existsSync(path) ? realpathSync(path) : resolve(path);
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    },
  );
}
export function loadConfig(
  workspaceInput: string,
  home = homedir(),
  options: { trustedCommands?: boolean } = {},
): RoomConfig | undefined {
  const workspace = realpathSync(workspaceInput);
  const config: RoomConfig = {
    workspace,
    humanName: 'You',
    permissions: { edits: false, commands: false, network: false },
    skills: { enabled: true },
    followUpTurns: 8,
    agents: {},
    sources: [],
    provenance: {},
  };
  const paths = configPaths(workspace, home);
  let trustedSource: string | undefined;
  let roomInstructions: { path: string; sources: z.infer<typeof source>[] } | undefined;
  let selected:
    { path: string; key: 'agents' | 'defaultAgents'; entries: z.infer<typeof agents> } | undefined;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8');
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Config exceeds 1 MiB');
      const doc = parseDocument(text, { uniqueKeys: true });
      if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join('\n'));
      const raw = doc.toJS({ maxAliasCount: 20 });
      if (
        raw?.permissions?.commands === 'trusted' ||
        (path !== paths[0] && raw?.trustedCommands !== undefined)
      )
        throw new Error(
          `Trust can only be granted through trustedCommands.workspaces in ${paths[0]} or --trusted-commands. permissions.commands must remain a boolean.`,
        );
      const layer = schema.parse(raw);
      if (layer.instructions !== undefined)
        roomInstructions = { path, sources: layer.instructions.sources ?? [] };
      if (layer.trustedCommands) {
        for (const entry of layer.trustedCommands.workspaces) {
          const expanded = entry.startsWith('~/') ? join(home, entry.slice(2)) : entry;
          if (!isAbsolute(expanded))
            throw new Error('trustedCommands.workspaces requires absolute paths or ~/ paths');
          // Ignore absent checkouts; never substitute a lexical match for realpath.
          if (existsSync(expanded) && realpathSync(expanded) === workspace)
            trustedSource = `${path} (trustedCommands.workspaces)`;
        }
      }
      if (path === paths[0]) {
        if (layer.defaultAgents !== undefined && layer.agents !== undefined)
          throw new Error(
            'Use defaultAgents in user config; agents is a legacy alias and cannot be combined with it',
          );
        const key = layer.defaultAgents !== undefined ? 'defaultAgents' : 'agents';
        if (layer[key] !== undefined) selected = { path, key, entries: layer[key] };
      } else {
        if (layer.defaultAgents !== undefined)
          throw new Error('defaultAgents belongs in user config; use agents for this project');
        if (layer.agents !== undefined) selected = { path, key: 'agents', entries: layer.agents };
      }
      config.sources.push(path);
      if (layer.skills?.enabled !== undefined) {
        config.skills = { enabled: layer.skills.enabled };
        config.provenance['skills.enabled'] = path;
      }
      if (layer.human?.name !== undefined) {
        config.humanName = layer.human.name;
        config.provenance['human.name'] = path;
      }
      if (layer.conversation?.follow_up_turns !== undefined) {
        config.followUpTurns = layer.conversation.follow_up_turns;
        config.provenance['conversation.follow_up_turns'] = path;
      }
      for (const [key, value] of Object.entries(layer.permissions || {})) {
        config.permissions[key as keyof typeof config.permissions] = value;
        config.provenance[`permissions.${key}`] = path;
      }
    } catch (error) {
      throw new ConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    config.commandAccess = resolveCommandAccess(config, trustedSource, options.trustedCommands);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  if (!config.sources.length) return undefined;
  if (!selected)
    throw new ConfigError(
      `No agents configured. Set defaultAgents in ${paths[0]} or agents in the launch directory's .agents/chittr.yaml`,
    );
  const { path, key, entries } = selected;
  if (!Object.keys(entries).length)
    throw new ConfigError(
      `${path}: ${key} is empty. Configure at least one agent${key === 'agents' && path !== paths[0] ? ', or omit agents to use your user defaults' : ''}`,
    );
  config.provenance.agents = path;
  if (roomInstructions) {
    config.instructions = resolveInstructions(
      roomInstructions.sources,
      roomInstructions.path,
      home,
      'instructions',
    );
    config.provenance.instructions = roomInstructions.path;
  }
  const catalogs = new Map<string, SkillCatalog>();
  for (const [id, value] of Object.entries(entries)) {
    if (!value.provider)
      throw new ConfigError(
        `${path}: ${key}.${id}.provider is required; agent definitions are self-contained`,
      );
    const instructions = resolveInstructions(
      value.instructions?.sources ?? [],
      path,
      home,
      `${key}.${id}.instructions`,
    );
    for (const field of Object.keys(value)) config.provenance[`${key}.${id}.${field}`] = path;
    let skills: SkillCatalog | undefined;
    if (config.skills?.enabled && value.enabled !== false) {
      skills = catalogs.get(value.provider) ?? discoverSkills(value.provider, workspace, home);
      catalogs.set(value.provider, skills);
    }
    const resolved: Omit<AgentConfig, 'fingerprint'> = {
      id,
      provider: value.provider,
      enabled: value.enabled ?? true,
      ...(value.model ? { model: value.model } : {}),
      ...(value.effort ? { effort: value.effort } : {}),
      instructions,
      ...(skills ? { skills } : {}),
    };
    config.agents[id] = {
      ...resolved,
      fingerprint: fingerprint({
        provider: resolved.provider,
        model: resolved.model,
        effort: resolved.effort,
        instructions: resolved.instructions,
        skillsEnabled: config.skills?.enabled,
        skills: resolved.skills,
      }),
    };
  }
  return config;
}
function resolveInstructions(
  sources: z.infer<typeof source>[],
  path: string,
  home: string,
  field: string,
): string {
  try {
    return sources
      .map((item) => {
        if ('text' in item) return item.text;
        const file = readInstructionFile(item.file, dirname(path), home);
        return `Instructions from ${file.source}:\n${file.text}`;
      })
      .join('\n\n');
  } catch (error) {
    throw new ConfigError(
      `${path}: ${field}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export function parseProviderSelection(choice: string, installed: Provider[]): Provider[] {
  const selected = [...new Set(choice.split(/[,\s]+/).filter(Boolean))];
  if (!selected.length)
    throw new ConfigError('Select at least one installed CLI; none are selected by default');
  if (selected.some((provider) => !installed.includes(provider as Provider)))
    throw new ConfigError('Select only detected providers: ' + installed.join(', '));
  return selected as Provider[];
}
export function writeStarter(providers: Provider[], home = homedir(), humanName = 'You'): string {
  if (!providers.length) throw new ConfigError('Select at least one installed CLI');
  const name = displayName.parse(humanName);
  const path = join(home, '.agents', 'chittr.yaml');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    stringify({
      version: 1,
      human: { name },
      conversation: { follow_up_turns: 8 },
      permissions: { edits: false, commands: false, network: false },
      skills: { enabled: true },
      defaultAgents: Object.fromEntries(providers.map((provider) => [provider, { provider }])),
    }),
    { flag: 'wx', mode: 0o600 },
  );
  return path;
}
