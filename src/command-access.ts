import type { CommandAccess, CommandMode, Permissions, RoomConfig } from './types.js';

export function commandMode(
  config: Pick<RoomConfig, 'permissions' | 'commandAccess'>,
): CommandMode {
  return config.commandAccess?.mode ?? (config.permissions.commands ? 'sandboxed' : 'off');
}

export function resolveCommandAccess(
  config: Pick<RoomConfig, 'permissions' | 'provenance'>,
  persistentSource?: string,
  requested = false,
): CommandAccess {
  const source = requested ? '--trusted-commands' : persistentSource;
  const blockedBy = source
    ? (Object.keys(config.permissions) as (keyof Permissions)[])
        .filter((key) => !config.permissions[key])
        .map((permission) => ({
          permission,
          source: config.provenance[`permissions.${permission}`] ?? 'default',
        }))
    : [];
  if (requested && blockedBy.length)
    throw new Error(
      `--trusted-commands requires edits, commands, and network enabled. Disabled: ${blockedBy.map(({ permission, source }) => `permissions.${permission} (${source})`).join(', ')}.`,
    );
  return {
    mode:
      source && !blockedBy.length ? 'trusted' : config.permissions.commands ? 'sandboxed' : 'off',
    ...(source ? { source } : {}),
    blockedBy,
  };
}

export function commandAccessSummary(
  config: Pick<RoomConfig, 'permissions' | 'commandAccess'>,
): string {
  const mode = commandMode(config);
  const access = config.commandAccess;
  if (mode === 'trusted')
    return `Trusted commands: read, write, network and existing credentials outside the workspace. Source: ${access?.source ?? 'launch configuration'}.`;
  const policy = `Commands ${mode === 'off' ? 'off' : 'sandboxed'}`;
  if (!access?.source) return policy;
  return `${policy}. Trust inactive (${access.source}): ${access.blockedBy.map(({ permission, source }) => `permissions.${permission}=false from ${source}`).join('; ')}.`;
}
