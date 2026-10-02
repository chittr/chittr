import { expect, it } from 'vitest';
import {
  claudeImageBridge,
  claudeImageSupport,
  codexImageBridge,
  codexImageSupport,
  grokImageBridge,
  grokImageSupport,
  grokRoomContractChecks,
  legacyRestrictedGrokBuild,
  registeredImageMapping,
  safeModelIdentity,
  testedClaudeImageBuilds,
  testedCodexImageBuilds,
  testedImageBuilds,
  unavailableImageSupport,
  type GrokRoomContract,
  type GrokRoomContractCheck,
} from '../src/image-support.js';
import {
  liveEvidenceIssue,
  liveImageSelection,
  liveImageDriver,
} from '../scripts/live-image-selection.js';
const tuple = {
  cliVersion: legacyRestrictedGrokBuild,
  requestedModel: 'provider default',
  observedModel: 'grok-4.6',
  permissions: { edits: false, commands: false, network: false },
  skillsEnabled: false,
  nativeInventoryVerified: true,
};
it('reports both paths separately and rejects unknown builds, policy and private diagnostic inputs', () => {
  expect(grokImageSupport(tuple)).toMatchObject({
    initial: { available: true },
    retrieval: { available: true },
  });
  for (const change of [
    { cliVersion: '' },
    { permissions: {} as typeof tuple.permissions },
    { skillsEnabled: undefined as unknown as boolean },
  ]) {
    const report = grokImageSupport({ ...tuple, ...change });
    expect(report.initial.available).toBe(false);
    expect(report.retrieval.available).toBe(false);
  }
  const privateText = '/private/workspace/private-visual-answer?credential=secret';
  expect(
    JSON.stringify(
      grokImageSupport({
        ...tuple,
        cliVersion: privateText,
        requestedModel: privateText,
        observedModel: privateText,
      }),
    ),
  ).not.toContain(privateText);
  for (const provider of ['codex', 'claude', 'antigravity'] as const) {
    const report = unavailableImageSupport(provider, privateText);
    expect(report.initial).toMatchObject({ available: false, status: 'unsupported' });
    expect(report.retrieval).toMatchObject({ available: false, status: 'unsupported' });
    expect(JSON.stringify(report)).not.toContain(privateText);
  }
});
it('carries explicit script configuration and rejects selections with no complete driver', () => {
  expect(
    liveImageSelection(['--adapter', 'grok', '--model', 'grok-4.6', '--effort', 'high']),
  ).toMatchObject({
    adapter: 'grok',
    model: 'grok-4.6',
    effort: 'high',
    permissions: { commands: false },
    commandAccess: { mode: 'off' },
  });
  expect(liveImageSelection(['--room', 'trusted', '--trusted-commands'])).toMatchObject({
    skills: { enabled: true },
    commandAccess: { mode: 'trusted', source: '--trusted-commands' },
  });
  expect(
    liveImageSelection(['--adapter', 'grok', '--room', 'trusted', '--effort', 'high']),
  ).toMatchObject({
    permissions: { edits: true, commands: true, network: true },
    skills: { enabled: true },
    commandAccess: { mode: 'sandboxed' },
  });
  expect(() => liveImageSelection(['--adapter', 'claude', '--room', 'trusted'])).toThrow(
    'explicit --trusted-commands',
  );
  expect(() => liveImageSelection(['--adapter', 'unknown'])).toThrow('unknown adapter');
  expect(liveImageDriver(liveImageSelection(['--adapter', 'claude'])).create).toBeTypeOf(
    'function',
  );
  expect(liveImageDriver(liveImageSelection(['--adapter', 'codex'])).create).toBeTypeOf('function');
  expect(() => liveImageDriver(liveImageSelection(['--adapter', 'antigravity']))).toThrow(
    'Unavailable',
  );
});

it('stamps every new Grok run as #69 evidence without relabelling #56 coverage', () => {
  const grok = (...args: string[]) =>
    liveEvidenceIssue(liveImageSelection(['--adapter', 'grok', ...args]));
  // The amended #69 owns the whole 1.0.34 matrix. #56's retained records keep
  // their own stamp on disk; no new run can be stamped as that ticket's.
  expect(grok('--room', 'restricted')).toBe(69);
  // `--room trusted` alone is the sandboxed-command room, not trusted commands.
  expect(grok('--room', 'trusted', '--effort', 'high')).toBe(69);
  const trusted = liveImageSelection([
    '--adapter',
    'grok',
    '--model',
    'provider-default',
    '--effort',
    'high',
    '--room',
    'trusted',
    '--trusted-commands',
  ]);
  expect(trusted).toMatchObject({
    model: undefined,
    effort: 'high',
    permissions: { edits: true, commands: true, network: true },
    skills: { enabled: true },
    commandAccess: { mode: 'trusted', source: '--trusted-commands', blockedBy: [] },
  });
  expect(liveEvidenceIssue(trusted)).toBe(69);
  expect(() => grok('--room', 'restricted', '--trusted-commands')).toThrow('Unavailable');
  for (const [adapter, issue] of [
    ['codex', 52],
    ['claude', 53],
  ] as const)
    expect(
      liveEvidenceIssue(
        liveImageSelection(['--adapter', adapter, '--room', 'trusted', '--trusted-commands']),
      ),
    ).toBe(issue);
  // #57 reruns the provider scripts on its integrated build. Only the explicit
  // option restamps a run, for every provider, and no other ticket can be named.
  for (const adapter of ['grok', 'codex', 'claude'] as const) {
    const room =
      adapter === 'grok' ? ['--room', 'restricted'] : ['--room', 'trusted', '--trusted-commands'];
    const selected = liveImageSelection(['--adapter', adapter, ...room, '--evidence-issue', '57']);
    expect(selected.evidenceIssue).toBe(57);
    expect(liveEvidenceIssue(selected)).toBe(57);
    expect(liveImageSelection(['--adapter', adapter, ...room]).evidenceIssue).toBeUndefined();
  }
  for (const other of ['52', '56', '69', '', 'fifty-seven'])
    expect(() => liveImageSelection(['--evidence-issue', other])).toThrow('accepts only 57');
});

const observedContract: GrokRoomContract = {
  policy: 'isolated-rooms-v1',
  isolatedRuntime: true,
  acpInitialized: true,
  subscriptionAuthenticated: true,
  roomMcpInventory: true,
  processLive: true,
};
const liveBuild = 'grok 1.0.34 (3736acbc8658) [stable]';
const modern = {
  ...tuple,
  cliVersion: liveBuild,
  nativeInventoryVerified: true,
  commandMode: 'off' as const,
  roomContract: observedContract,
};
const sandboxed = {
  ...modern,
  permissions: { edits: true, commands: true, network: true },
  skillsEnabled: true,
  commandMode: 'sandboxed' as const,
};
// #69: the same all-permissions, skills-on room under effective command mode
// `trusted`. The tuple has no trust-source field, so the source cannot matter.
const trustedCommands = { ...sandboxed, commandMode: 'trusted' as const };
const closed = { initial: { available: false }, retrieval: { available: false } };

it('keeps Grok eligible across CLI versions when the same runtime contract is observed', () => {
  expect(Object.keys(trustedCommands).sort()).toEqual(Object.keys(sandboxed).sort());
  const open = {
    provider: 'grok',
    initial: { available: true, status: 'available' },
    retrieval: { available: true, status: 'available' },
  };
  // Synthetic identities that no evidence record can name, older and newer than
  // anything exercised. A version-only change never closes the gate, and semver
  // order grants nothing either way.
  const uncatalogued = [
    'grok 1.0.14 (unknown) [stable]',
    'grok 0.0.1 (a) [stable]',
    'grok 10.200.3000 (abcdef0123456789) [stable]',
  ];
  for (const cliVersion of uncatalogued)
    expect(testedImageBuilds.some((entry) => entry.cliVersion === cliVersion)).toBe(false);
  // Catalogued identities behave the same; the catalog's membership is not asserted.
  const catalogued = testedImageBuilds
    .map((entry) => entry.cliVersion)
    .filter((cliVersion) => cliVersion !== legacyRestrictedGrokBuild);
  expect(catalogued).toContain('grok 1.0.30 (04b7ffed98c6) [stable]');
  for (const cliVersion of [...uncatalogued, ...catalogued, liveBuild])
    for (const room of [modern, sandboxed, trustedCommands])
      expect(grokImageSupport({ ...room, cliVersion })).toEqual(open);
  // The catalog is an immutable evidence record, not something a run can extend.
  expect(Object.isFrozen(testedImageBuilds)).toBe(true);
  expect(testedImageBuilds.every((entry) => Object.isFrozen(entry))).toBe(true);
});

it('rejects both Grok paths when any required observation is missing, unknown or failed', () => {
  const checks = Object.keys(grokRoomContractChecks) as GrokRoomContractCheck[];
  expect(checks.sort()).toEqual(
    Object.keys(observedContract)
      .filter((key) => key !== 'policy')
      .sort(),
  );
  for (const room of [modern, sandboxed, trustedCommands]) {
    for (const invalid of [
      { ...room, roomContract: undefined },
      { ...room, roomContract: {} as GrokRoomContract },
      { ...room, roomContract: { ...observedContract, policy: 'isolated-rooms-v2' as never } },
      { ...room, roomContract: { ...observedContract, policy: undefined as never } },
      ...checks.flatMap((check) => [
        { ...room, roomContract: { ...observedContract, [check]: false } },
        { ...room, roomContract: { ...observedContract, [check]: undefined as never } },
        { ...room, roomContract: { ...observedContract, [check]: 'true' as never } },
      ]),
      { ...room, nativeInventoryVerified: false },
      { ...room, nativeInventoryVerified: undefined },
      { ...room, observedModel: 'unavailable' },
      { ...room, observedModel: '' },
      // The identity is required evidence; an unreadable one is not observed.
      { ...room, cliVersion: '' },
      { ...room, cliVersion: 'grok 1.0.34' },
      { ...room, cliVersion: 'grok 1.0.34 (3736acbc8658) [beta]' },
      { ...room, cliVersion: 'codex-cli 0.154.0' },
      { ...room, cliVersion: '1.0.34' },
    ])
      expect(grokImageSupport(invalid)).toMatchObject(closed);
  }
  expect(grokImageSupport({ ...trustedCommands, roomContract: undefined }).initial).toEqual({
    available: false,
    status: 'not_observed',
    reason: `Grok initial images not observed: the isolated-room runtime contract has not been observed; live CLI ${liveBuild}; observed model grok-4.6`,
  });
  expect(
    grokImageSupport({
      ...trustedCommands,
      roomContract: {
        ...observedContract,
        subscriptionAuthenticated: false,
        roomMcpInventory: false,
      },
    }),
  ).toEqual({
    provider: 'grok',
    initial: {
      available: false,
      status: 'unsupported',
      reason: `Grok's verified initial-image tuple does not match: the observed runtime contract failed: cached subscription authentication and exact room MCP server and tool inventory; live CLI ${liveBuild}; observed model grok-4.6`,
    },
    retrieval: {
      available: false,
      status: 'unsupported',
      reason: `Grok's verified retrieval tuple does not match: the observed runtime contract failed: cached subscription authentication and exact room MCP server and tool inventory; live CLI ${liveBuild}; observed model grok-4.6`,
    },
  });
  // An unobserved check never hides a failed one: the failure decides the
  // status, and both are named.
  expect(
    grokImageSupport({
      ...trustedCommands,
      roomContract: {
        ...observedContract,
        subscriptionAuthenticated: false,
        roomMcpInventory: undefined as never,
      },
    }).initial,
  ).toEqual({
    available: false,
    status: 'unsupported',
    reason: `Grok's verified initial-image tuple does not match: the observed runtime contract failed: cached subscription authentication; the runtime contract has unobserved checks: exact room MCP server and tool inventory; live CLI ${liveBuild}; observed model grok-4.6`,
  });
  expect(
    grokImageSupport({
      ...trustedCommands,
      roomContract: { ...observedContract, acpInitialized: undefined as never },
    }).initial,
  ).toEqual({
    available: false,
    status: 'not_observed',
    reason: `Grok initial images not observed: the runtime contract has unobserved checks: ACP initialization; live CLI ${liveBuild}; observed model grok-4.6`,
  });
  expect(
    grokImageSupport({ ...modern, roomContract: { ...observedContract, processLive: false } })
      .initial,
  ).toMatchObject({
    status: 'unsupported',
    reason: expect.stringContaining('the observed runtime contract failed: live native process'),
  });
  expect(grokImageSupport({ ...trustedCommands, cliVersion: 'grok 1.0.34' }).initial).toEqual({
    available: false,
    status: 'not_observed',
    reason:
      'Grok initial images not observed: the live CLI identity has not been observed; observed model grok-4.6',
  });
});

// #105: the requested and observed models are evidence and bounded
// diagnostics. Neither an explicit request nor a model outside the historical
// records closes a path; only a missing model observation does.
it('keeps Grok eligible for explicit and uncatalogued model identities on every observed room', () => {
  const open = {
    provider: 'grok',
    initial: { available: true, status: 'available' },
    retrieval: { available: true, status: 'available' },
  };
  for (const room of [modern, sandboxed, trustedCommands])
    for (const models of [
      { requestedModel: 'grok-4.6', observedModel: 'grok-4.6' },
      { requestedModel: 'grok-3', observedModel: 'grok-3' },
      { requestedModel: 'provider default', observedModel: 'grok-other' },
      { requestedModel: 'provider default', observedModel: 'grok-5.1' },
      { requestedModel: 'grok-4.6', observedModel: 'grok-4-fast' },
    ])
      expect(grokImageSupport({ ...room, ...models }), JSON.stringify(models)).toEqual(open);
  expect(grokImageSupport({ ...modern, requestedModel: 'grok-3', skillsEnabled: true })).toEqual(
    open,
  );
  const unrecognized = grokImageSupport({
    ...modern,
    observedModel: '/private/model?credential=secret',
    nativeInventoryVerified: false,
  }).initial;
  expect(unrecognized.available ? '' : unrecognized.reason).toContain(
    'observed model unrecognized',
  );
  expect(JSON.stringify(unrecognized)).not.toContain('credential');
});

// Room permissions, skills and command mode do not change image delivery, so a
// current build is eligible in every room configuration, including the defaults.
it('keeps Grok eligible in every room configuration and lists only failed observations', () => {
  const open = {
    provider: 'grok',
    initial: { available: true, status: 'available' },
    retrieval: { available: true, status: 'available' },
  };
  for (const edits of [false, true])
    for (const commands of [false, true])
      for (const network of [false, true])
        for (const skillsEnabled of [false, true])
          for (const commandMode of ['off', 'sandboxed', 'trusted', undefined] as const) {
            const room = { permissions: { edits, commands, network }, skillsEnabled, commandMode };
            expect(grokImageSupport({ ...modern, ...room }), JSON.stringify(room)).toEqual(open);
          }
  // The policy is evidence on a current build: an unreadable one decides nothing.
  for (const room of [
    { commandMode: undefined },
    { permissions: {} as typeof modern.permissions },
    { skillsEnabled: undefined as unknown as boolean },
  ])
    expect(grokImageSupport({ ...modern, ...room })).toEqual(open);
  // Every failed condition is listed. The live identity is a bounded trailing
  // diagnostic: a version difference is never itself a mismatch, and the room
  // configuration is never named.
  const several = grokImageSupport({
    ...trustedCommands,
    cliVersion: 'grok 1.0.31 (unknown) [stable]',
    nativeInventoryVerified: false,
    permissions: { edits: true, commands: false, network: true },
  }).initial;
  expect(several).toEqual({
    available: false,
    status: 'unsupported',
    reason:
      "Grok's verified initial-image tuple does not match: the observed native tool inventory failed policy verification; live CLI grok 1.0.31 (unknown) [stable]; observed model grok-4.6",
  });
  expect(several.available ? '' : several.reason).not.toMatch(
    /CLI version is|no accepted image build|room configuration/,
  );
});

it('keeps each recorded Claude build as coverage while eligibility follows the live requirements', () => {
  const tuple = (cliVersion: string) => ({
    cliVersion,
    requestedModel: 'opus',
    requestedEffort: 'xhigh',
    observedModel: 'claude-opus-5',
    connected: true,
    nativeInventoryVerified: true,
  });
  expect(testedClaudeImageBuilds.map((item) => item.cliVersion)).toEqual([
    '2.1.268 (Claude Code)',
    '2.1.274 (Claude Code)',
    '2.1.276 (Claude Code)',
    '2.1.277 (Claude Code)',
  ]);
  // Each record names the registered bridge it went through and keeps the
  // tuple its own runs used. #105: that tuple is history, not a requirement.
  for (const item of testedClaudeImageBuilds) {
    expect(item.key).toBe(claudeImageBridge.key);
    expect(item.provider).toBe(claudeImageBridge.provider);
    expect({
      requestedModel: item.requestedModel,
      requestedEffort: item.requestedEffort,
      observedModel: item.observedModel,
    }).toEqual({
      requestedModel: 'opus',
      requestedEffort: 'xhigh',
      observedModel: 'claude-opus-5',
    });
  }
  for (const item of testedCodexImageBuilds) {
    expect(item.key).toBe(codexImageBridge.key);
    expect({ model: item.model, effort: item.effort }).toEqual({
      model: 'gpt-6-astra',
      effort: 'xhigh',
    });
  }
  for (const item of testedImageBuilds) expect(item.key).toBe(grokImageBridge.key);
  // Recorded, neighbouring, newer, older and malformed identities are all decided
  // by the same requirements: the record is coverage, not the condition.
  for (const cliVersion of [
    ...testedClaudeImageBuilds.map((item) => item.cliVersion),
    '2.1.267 (Claude Code)',
    '2.1.275 (Claude Code)',
    '2.1.278 (Claude Code)',
    '3.0.0 (Claude Code)',
    '2.1.277',
    '',
  ])
    expect(claudeImageSupport(tuple(cliVersion)), cliVersion).toMatchObject({
      initial: { available: true },
      retrieval: { available: true },
    });
});

it('preserves the exact 1.0.13 legacy restriction without any compaction pin', () => {
  expect(legacyRestrictedGrokBuild).toBe('grok 1.0.13 (5e9a58528b76) [stable]');
  expect(
    testedImageBuilds
      .filter((entry) => entry.roomPolicy === 'restricted-v1')
      .map((e) => e.cliVersion),
  ).toEqual([legacyRestrictedGrokBuild]);
  const legacy = { ...tuple, cliVersion: legacyRestrictedGrokBuild };
  // Permissions off, skills off, command mode off; no contract was ever recorded.
  for (const room of [
    legacy,
    { ...legacy, commandMode: 'off' as const },
    { ...modern, cliVersion: legacyRestrictedGrokBuild },
  ])
    expect(grokImageSupport(room)).toMatchObject({
      initial: { available: true },
      retrieval: { available: true },
    });
  expect(grokImageSupport({ ...legacy, nativeInventoryVerified: undefined }).initial).toMatchObject(
    {
      available: true,
      status: 'available',
    },
  );
  // A fully observed isolated-room contract never widens that identity.
  for (const room of [sandboxed, trustedCommands])
    expect(grokImageSupport({ ...room, cliVersion: legacyRestrictedGrokBuild })).toMatchObject({
      initial: { available: false, status: 'unsupported' },
      retrieval: { available: false, status: 'unsupported' },
    });
  for (const commandMode of ['sandboxed', 'trusted'] as const)
    expect(
      grokImageSupport({ ...legacy, commandMode, roomContract: observedContract }).initial,
    ).toEqual({
      available: false,
      status: 'unsupported',
      reason:
        "Grok's verified initial-image tuple does not match: command mode is on; the verified tuple requires command mode off; observed model grok-4.6",
    });
  expect(
    grokImageSupport({
      ...legacy,
      permissions: {} as typeof legacy.permissions,
      skillsEnabled: undefined as unknown as boolean,
    }).initial,
  ).toMatchObject({ available: false, status: 'not_observed' });
  expect(
    grokImageSupport({
      ...legacy,
      permissions: undefined as unknown as typeof legacy.permissions,
    }).initial,
  ).toMatchObject({ available: false, status: 'not_observed' });
});

it('classifies missing observations separately from observed incompatibility', () => {
  const grok = {
    ...tuple,
    cliVersion: 'grok 1.0.30 (04b7ffed98c6) [stable]',
    commandMode: 'off' as const,
    nativeInventoryVerified: true,
    roomContract: observedContract,
  };
  expect(grokImageSupport(grok).initial.status).toBe('available');
  expect(grokImageSupport({ ...grok, roomContract: undefined }).initial.status).toBe(
    'not_observed',
  );
  expect(
    grokImageSupport({ ...grok, roomContract: { ...observedContract, acpInitialized: false } })
      .initial.status,
  ).toBe('unsupported');
  expect(grokImageSupport({ ...grok, observedModel: 'unavailable' }).initial.status).toBe(
    'not_observed',
  );
  expect(grokImageSupport({ ...grok, nativeInventoryVerified: undefined }).initial.status).toBe(
    'not_observed',
  );
  expect(grokImageSupport({ ...grok, nativeInventoryVerified: false }).initial.status).toBe(
    'unsupported',
  );
  expect(
    grokImageSupport({
      ...grok,
      observedModel: 'unavailable',
      nativeInventoryVerified: false,
    }).initial.status,
  ).toBe('unsupported');

  const claude = {
    cliVersion: '2.1.268 (Claude Code)',
    requestedModel: 'opus',
    requestedEffort: 'xhigh',
    observedModel: 'claude-opus-5',
    observedEffort: 'xhigh',
    connected: true,
    nativeInventoryVerified: true,
  };
  expect(claudeImageSupport(claude).initial.status).toBe('available');
  expect(claudeImageSupport({ ...claude, connected: false }).initial.status).toBe('not_observed');
  expect(claudeImageSupport({ ...claude, nativeInventoryVerified: false }).initial.status).toBe(
    'unsupported',
  );
  // Before the first turn neither the inventory nor a turn model has been observed.
  // #105: requested and observed model and effort are evidence only.
  for (const change of [
    { observedModel: undefined },
    { nativeInventoryVerified: undefined },
    { observedModel: undefined, nativeInventoryVerified: undefined, observedEffort: undefined },
    { requestedEffort: 'high' },
    { observedModel: 'claude-fable-5-1' },
    { requestedModel: 'sonnet', observedModel: 'claude-sonnet-5' },
  ])
    expect(claudeImageSupport({ ...claude, ...change }).initial.status).toBe('available');
  for (const observedEffort of [undefined, 'high'])
    expect(claudeImageSupport({ ...claude, observedEffort }).initial.status).toBe('available');
  expect(
    claudeImageSupport({ ...claude, connected: false, nativeInventoryVerified: false }).initial
      .status,
  ).toBe('unsupported');

  const codex = {
    cliVersion: 'codex-cli 0.154.0',
    requestedModel: 'gpt-6-astra',
    requestedEffort: 'xhigh',
    observedModel: 'gpt-6-astra',
    observedEffort: 'xhigh',
    nativePolicyVerified: true,
  };
  expect(codexImageSupport(codex).initial.status).toBe('available');
  for (const change of [
    { observedModel: undefined },
    { observedEffort: undefined },
    { nativePolicyVerified: undefined },
  ])
    expect(codexImageSupport({ ...codex, ...change }).initial.status).toBe('not_observed');
  expect(codexImageSupport({ ...codex, nativePolicyVerified: false }).initial.status).toBe(
    'unsupported',
  );
  for (const change of [
    { requestedModel: 'gpt-5.6-sol' },
    { observedModel: 'gpt-5.6-sol' },
    { observedEffort: 'high' },
    { requestedEffort: 'high', observedEffort: 'high' },
  ])
    expect(codexImageSupport({ ...codex, ...change }).initial.status).toBe('available');
  expect(
    codexImageSupport({
      ...codex,
      observedEffort: undefined,
      nativePolicyVerified: false,
    }).initial.status,
  ).toBe('unsupported');
});

const claudeTuple = (cliVersion: string) => ({
  cliVersion,
  requestedModel: 'opus',
  requestedEffort: 'xhigh',
  observedModel: 'claude-opus-5',
  observedEffort: 'xhigh',
  connected: true,
  nativeInventoryVerified: true,
});
const codexTuple = (cliVersion: string) => ({
  cliVersion,
  requestedModel: 'gpt-6-astra',
  requestedEffort: 'xhigh',
  observedModel: 'gpt-6-astra',
  observedEffort: 'xhigh',
  nativePolicyVerified: true,
});
const reasons = (report: { initial: unknown; retrieval: unknown }) =>
  [report.initial, report.retrieval].map((path) => (path as { reason: string }).reason);

it('keeps Codex and Claude image paths open on unlisted CLI builds and reports the identity only', () => {
  // The upgrades that closed the paths, newer and older unlisted identities, an
  // empty diagnostic and unrecognized text: all available, with no catalog entry.
  expect(testedClaudeImageBuilds.map((item) => item.cliVersion)).not.toContain(
    '2.1.278 (Claude Code)',
  );
  expect(testedCodexImageBuilds.map((item) => item.cliVersion)).not.toContain('codex-cli 0.155.1');
  for (const cliVersion of [
    '2.1.278 (Claude Code)',
    '2.1.400 (Claude Code)',
    '2.1.100 (Claude Code)',
    '2.1.278',
    '',
    'not a version at all',
  ])
    expect(claudeImageSupport(claudeTuple(cliVersion)), cliVersion).toEqual({
      provider: 'claude',
      initial: { available: true, status: 'available' },
      retrieval: { available: true, status: 'available' },
    });
  for (const cliVersion of [
    'codex-cli 0.155.1',
    'codex-cli 0.300.0',
    'codex-cli 0.100.0',
    'codex-cli 1.0.0',
    '',
    'not a version at all',
  ])
    expect(codexImageSupport(codexTuple(cliVersion)), cliVersion).toEqual({
      provider: 'codex',
      initial: { available: true, status: 'available' },
      retrieval: { available: true, status: 'available' },
    });

  // A real unmet requirement still closes both paths and keeps the live identity.
  const claudeClosed = claudeImageSupport({
    ...claudeTuple('2.1.278 (Claude Code)'),
    nativeInventoryVerified: false,
  });
  expect(claudeClosed.initial).toMatchObject({ available: false, status: 'unsupported' });
  expect(claudeClosed.retrieval).toMatchObject({ available: false, status: 'unsupported' });
  for (const reason of reasons(claudeClosed)) {
    expect(reason).toContain('the observed native tool inventory failed policy verification');
    expect(reason).toContain('live CLI 2.1.278 (Claude Code)');
  }
  const codexClosed = codexImageSupport({
    ...codexTuple('codex-cli 0.155.1'),
    nativePolicyVerified: false,
  });
  expect(codexClosed.initial).toMatchObject({ available: false, status: 'unsupported' });
  for (const reason of reasons(codexClosed)) expect(reason).toContain('live CLI codex-cli 0.155.1');

  // Arbitrary paths and private text are replaced, never echoed, and an empty
  // identity renders the same way without closing anything by itself.
  const privateText = '/private/workspace/visual-answer?credential=secret';
  for (const report of [
    claudeImageSupport({ ...claudeTuple(privateText), nativeInventoryVerified: false }),
    codexImageSupport({ ...codexTuple(privateText), nativePolicyVerified: false }),
    claudeImageSupport({ ...claudeTuple(''), connected: false }),
  ]) {
    expect(JSON.stringify(report)).not.toContain('credential=secret');
    for (const reason of reasons(report)) expect(reason).toContain('unknown or unavailable');
  }
});

it('decides every Claude and Codex requirement on an unlisted CLI version', () => {
  const claude = claudeTuple('2.1.278 (Claude Code)');
  const codex = codexTuple('codex-cli 0.155.1');
  expect(claudeImageSupport({ ...claude, connected: false }).initial.status).toBe('not_observed');
  expect(claudeImageSupport({ ...claude, nativeInventoryVerified: false }).initial.status).toBe(
    'unsupported',
  );
  for (const change of [
    { observedModel: undefined },
    { nativeInventoryVerified: undefined },
    { requestedModel: 'claude-opus-5' },
    { requestedEffort: 'high' },
    { observedModel: 'claude-fable-5-1' },
  ])
    expect(claudeImageSupport({ ...claude, ...change }).initial.status).toBe('available');
  // Observed effort stays evidence for Claude, never a requirement.
  for (const observedEffort of [undefined, 'high', 'xhigh'])
    expect(claudeImageSupport({ ...claude, observedEffort }).initial.status).toBe('available');
  // Failure precedence is unchanged: an observed failure outranks a missing one.
  expect(
    claudeImageSupport({ ...claude, connected: false, nativeInventoryVerified: false }).initial
      .status,
  ).toBe('unsupported');

  for (const change of [
    { observedModel: undefined },
    { observedEffort: undefined },
    { nativePolicyVerified: undefined },
  ])
    expect(codexImageSupport({ ...codex, ...change }).initial.status).toBe('not_observed');
  expect(codexImageSupport({ ...codex, nativePolicyVerified: false }).initial.status).toBe(
    'unsupported',
  );
  for (const change of [
    { requestedModel: 'gpt-5.6-sol' },
    { requestedEffort: 'high' },
    { observedModel: 'gpt-5.6-sol' },
    { observedEffort: 'high' },
  ])
    expect(codexImageSupport({ ...codex, ...change }).initial.status).toBe('available');
  expect(
    codexImageSupport({ ...codex, observedEffort: undefined, nativePolicyVerified: false }).initial
      .status,
  ).toBe('unsupported');
  // Both paths always agree on an unlisted identity.
  for (const report of [
    claudeImageSupport({ ...claude, connected: false }),
    codexImageSupport({ ...codex, nativePolicyVerified: undefined }),
  ])
    expect(report.initial.status).toBe(report.retrieval.status);
});

// #105: the reported case and its generalization. Requested and observed model
// and effort vary independently; none of them is compared to a historical tuple.
it('opens Codex, Claude and Grok image paths for identities outside the historical tuples', () => {
  const open = (provider: string) => ({
    provider,
    initial: { available: true, status: 'available' },
    retrieval: { available: true, status: 'available' },
  });
  // The reported warning: gpt-6-astra at high on codex-cli 0.156.1, fresh
  // thread, verified policy, restricted room. No catalog row names it.
  expect(
    testedCodexImageBuilds.some(
      (item) => item.effort === 'high' || item.cliVersion.includes('0.156'),
    ),
  ).toBe(false);
  expect(
    codexImageSupport({
      ...codexTuple('codex-cli 0.156.1'),
      requestedEffort: 'high',
      observedEffort: 'high',
    }),
  ).toEqual(open('codex'));
  const codexRequested = [
    { requestedModel: 'gpt-6-astra', requestedEffort: 'high' },
    { requestedModel: 'gpt-5.6-sol', requestedEffort: 'xhigh' },
    { requestedModel: 'custom-model', requestedEffort: 'ultra' },
    { requestedModel: 'provider default', requestedEffort: 'provider default' },
  ];
  const codexObserved = [
    { observedModel: 'gpt-6-astra', observedEffort: 'high' },
    { observedModel: 'gpt-5.6-sol', observedEffort: 'medium' },
    { observedModel: 'gpt-7', observedEffort: 'none' },
  ];
  for (const requested of codexRequested)
    for (const observed of codexObserved)
      expect(
        codexImageSupport({ ...codexTuple('codex-cli 1.0.0'), ...requested, ...observed }),
        JSON.stringify({ requested, observed }),
      ).toEqual(open('codex'));
  const claudeRequested = [
    { requestedModel: 'opus', requestedEffort: 'high' },
    { requestedModel: 'sonnet', requestedEffort: 'xhigh' },
    { requestedModel: 'claude-fable-5-1', requestedEffort: 'max' },
    { requestedModel: 'provider default', requestedEffort: 'provider default' },
  ];
  for (const requested of claudeRequested)
    for (const observedModel of ['claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5'])
      expect(
        claudeImageSupport({
          ...claudeTuple('2.1.278 (Claude Code)'),
          ...requested,
          observedModel,
        }),
        JSON.stringify({ requested, observedModel }),
      ).toEqual(open('claude'));
  for (const requestedModel of ['provider default', 'grok-4.6', 'grok-3'])
    for (const observedModel of ['grok-4.6', 'grok-3', 'grok-other'])
      expect(
        grokImageSupport({ ...trustedCommands, requestedModel, observedModel }),
        JSON.stringify({ requestedModel, observedModel }),
      ).toEqual(open('grok'));
  // The independent checks still decide, on the same identities.
  expect(
    codexImageSupport({
      ...codexTuple('codex-cli 0.156.1'),
      requestedEffort: 'high',
      observedEffort: 'high',
      nativePolicyVerified: false,
    }).initial,
  ).toMatchObject({ available: false, status: 'unsupported' });
  expect(
    claudeImageSupport({
      ...claudeTuple('2.1.278 (Claude Code)'),
      requestedEffort: 'high',
      connected: false,
    }).initial,
  ).toMatchObject({ available: false, status: 'not_observed' });
});

it('renders observed model and effort as bounded diagnostics without comparing them', () => {
  const codex = codexImageSupport({
    ...codexTuple('codex-cli 0.156.1'),
    requestedEffort: 'high',
    observedEffort: 'high',
    nativePolicyVerified: false,
  });
  for (const reason of reasons(codex)) {
    expect(reason).toContain('the observed native policy checks failed');
    expect(reason).toContain(
      'live CLI codex-cli 0.156.1; observed model gpt-6-astra at effort high',
    );
    expect(reason).not.toContain('approved configuration');
    expect(reason).not.toContain('does not match');
  }
  const claude = claudeImageSupport({
    ...claudeTuple('2.1.278 (Claude Code)'),
    observedModel: 'claude-fable-5-1',
    nativeInventoryVerified: false,
  });
  for (const reason of reasons(claude))
    expect(reason).toContain('live CLI 2.1.278 (Claude Code); observed model claude-fable-5-1');
  // Unobserved identities are omitted, unrecognized ones replaced, nothing echoed.
  const missing = claudeImageSupport({
    ...claudeTuple('2.1.278 (Claude Code)'),
    observedModel: undefined,
    nativeInventoryVerified: false,
  });
  for (const reason of reasons(missing)) expect(reason).not.toContain('observed model');
  const secret = '/private/model?credential=secret';
  const leaked = codexImageSupport({
    ...codexTuple('codex-cli 0.156.1'),
    requestedModel: secret,
    observedModel: secret,
    observedEffort: 'hi gh',
    nativePolicyVerified: false,
  });
  expect(JSON.stringify(leaked)).not.toContain('credential');
  for (const reason of reasons(leaked))
    expect(reason).toContain('observed model unrecognized at effort unrecognized');
  expect(safeModelIdentity('gpt-6-astra')).toBe('gpt-6-astra');
  expect(safeModelIdentity('provider default')).toBe('provider default');
  expect(safeModelIdentity(undefined)).toBe('unavailable');
  expect(safeModelIdentity('')).toBe('unavailable');
  expect(safeModelIdentity('x'.repeat(65))).toBe('unrecognized');
  expect(safeModelIdentity('-leading')).toBe('unrecognized');
});

// #105: bridge registration is code-owned per provider. The historical
// catalogs record evidence and register nothing.
it('registers exactly one code-owned bridge key per provider and rejects every other pair', () => {
  expect([claudeImageBridge, codexImageBridge, grokImageBridge]).toEqual([
    { provider: 'claude', key: 'claude-mcp-image' },
    { provider: 'codex', key: 'codex-dynamic-image' },
    { provider: 'grok', key: 'grok-mcp-image' },
  ]);
  for (const bridge of [claudeImageBridge, codexImageBridge, grokImageBridge]) {
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(registeredImageMapping(bridge.key, bridge.provider)).toBe(true);
    expect(registeredImageMapping(bridge.key)).toBe(true);
    for (const other of ['claude', 'codex', 'grok', 'antigravity'])
      if (other !== bridge.provider) expect(registeredImageMapping(bridge.key, other)).toBe(false);
  }
  for (const key of [
    'antigravity',
    'unavailable',
    'future-native-image',
    'grok-mcp-image-v2',
    '',
    undefined,
    null,
    {},
    42,
  ])
    for (const provider of [undefined, 'claude', 'codex', 'grok', 'antigravity'])
      expect(registeredImageMapping(key, provider)).toBe(false);
  // Evidence identities are not keys, and a record's key grants nothing extra.
  for (const item of [...testedImageBuilds, ...testedClaudeImageBuilds, ...testedCodexImageBuilds])
    expect(registeredImageMapping(item.cliVersion)).toBe(false);
});
