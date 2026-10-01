import type { Permissions } from './types.js';

/** Host-owned diagnostics only. Never put tool input, paths or private content in reasons. */
export type ImageSupportStatus = 'available' | 'not_observed' | 'unsupported';
export type ImagePathSupport =
  | { available: true; status: 'available' }
  | { available: false; status: Exclude<ImageSupportStatus, 'available'>; reason: string };
export type ImageProvider = 'grok' | 'claude' | 'codex' | 'antigravity';
export interface ImageSupportReport {
  provider: ImageProvider;
  initial: ImagePathSupport;
  retrieval: ImagePathSupport;
}
export interface RetrievalBridgeRegistration {
  key: string;
  report: ImageSupportReport;
}

const available = (): ImagePathSupport => ({ available: true, status: 'available' });
const unavailable = (
  status: Exclude<ImageSupportStatus, 'available'>,
  reason: string,
): ImagePathSupport => ({ available: false, status, reason });

function unavailableFrom(
  provider: string,
  path: 'initial images' | 'retrieval',
  observations: string[],
  unsupported: string[],
  live: string[] = [],
): ImagePathSupport {
  const status = unsupported.length ? 'unsupported' : 'not_observed';
  const reasons = unsupported.length
    ? [...unsupported, ...observations, ...live]
    : [...observations, ...live];
  return unavailable(
    status,
    `${provider} ${path} ${status === 'unsupported' ? 'unsupported' : 'not observed'}: ${reasons.join('; ')}`,
  );
}

// Unknown diagnostic values are not echoed. These are protocol identities, not free text.
export function safeCliIdentity(value: string): string {
  return /^(grok \d+\.\d+\.\d+ \([a-z0-9]{1,16}\) \[stable\]|codex-cli \d+\.\d+\.\d+|\d+\.\d+\.\d+( \(Claude Code\))?)$/.test(
    value,
  )
    ? value
    : 'unknown or unavailable';
}
/**
 * Model and effort identities are protocol values reported by the provider or
 * the room configuration. They are rendered for diagnostics only when they fit
 * a bounded identifier shape; anything else is replaced, never echoed.
 */
export function safeModelIdentity(value: string | undefined): string {
  if (value === undefined || value === '') return 'unavailable';
  return value === 'provider default' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
    ? value
    : 'unrecognized';
}

export function unavailableImageSupport(
  provider: ImageProvider,
  cliVersion = '',
): ImageSupportReport {
  const reason = `${provider} image support is unavailable: no accepted native mapping/tested build; live CLI ${safeCliIdentity(cliVersion)}`;
  return {
    provider,
    initial: unavailable('unsupported', reason),
    retrieval: unavailable('unsupported', reason),
  };
}

/**
 * The one historical identity whose evidence covers only the restricted room:
 * permissions off, skills off, command mode off. That restriction is preserved
 * exactly, and it is the only version-keyed branch in any gate. It only
 * restricts. The observed isolated-room contract below never widens it, and no
 * maintenance route reads it: since #105 native compaction is not pinned to
 * any build.
 */
export const legacyRestrictedGrokBuild = 'grok 1.0.13 (5e9a58528b76) [stable]';

/**
 * Host-derived observation of the isolated-room runtime. The adapter sets each
 * check only after it passed on the live native process. Nothing here is read
 * from room or user configuration, and nothing is inferred from a CLI version.
 */
export const grokRoomContractChecks = {
  isolatedRuntime: 'host-created isolated runtime',
  acpInitialized: 'ACP initialization',
  subscriptionAuthenticated: 'cached subscription authentication',
  roomMcpInventory: 'exact room MCP server and tool inventory',
  processLive: 'live native process',
} as const;
export type GrokRoomContractCheck = keyof typeof grokRoomContractChecks;
export type GrokRoomContract = { policy: 'isolated-rooms-v1' } & Record<
  GrokRoomContractCheck,
  boolean
>;

export interface GrokImageTuple {
  /** Evidence and bounded diagnostics. A version difference alone never changes eligibility. */
  cliVersion: string;
  requestedModel: string;
  observedModel: string;
  /** Evidence on current builds; only the legacy restriction reads the room policy. */
  permissions: Permissions;
  skillsEnabled: boolean;
  commandMode?: 'off' | 'sandboxed' | 'trusted';
  nativeInventoryVerified?: boolean;
  roomContract?: GrokRoomContract;
}

const listed = (names: string[]): string =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
const grokCliIdentity = /^grok \d+\.\d+\.\d+ \([a-z0-9]{1,16}\) \[stable\]$/;

/**
 * The single diagnostic source for Grok's initial-image gate. The room preflight
 * shows this reason per recipient; the adapter's own guard repeats it only as an
 * invariant failure. Every failed condition is listed, using the live effective
 * state the adapter started with, never the on-disk config alone.
 *
 * Eligibility comes from the observed runtime contract, not from the CLI version,
 * the room configuration or, since #105, the requested or observed model. A model
 * is required evidence and a bounded diagnostic; which model it is decides nothing.
 * Room permissions, skills and command mode do not change image delivery, so any
 * room configuration is eligible on a current build. `testedImageBuilds` records
 * what was exercised and is not consulted here. The exact legacy identity is the
 * only version-keyed branch, and it only restricts.
 */
export function grokInitialImageGate(tuple: GrokImageTuple): ImagePathSupport {
  const observations: string[] = [];
  const mismatches: string[] = [];
  const current = tuple.cliVersion !== legacyRestrictedGrokBuild;
  // An unreadable identity cannot be shown not to be the legacy build, and the
  // identity is required evidence, so it is a missing observation.
  const identityObserved = grokCliIdentity.test(tuple.cliVersion);
  if (!identityObserved) observations.push('the live CLI identity has not been observed');
  // Only the legacy restriction reads the room policy.
  const policyUnknown =
    !current &&
    (['edits', 'commands', 'network'].some(
      (key) => typeof tuple.permissions?.[key as keyof Permissions] !== 'boolean',
    ) ||
      typeof tuple.skillsEnabled !== 'boolean');
  if (policyUnknown) observations.push('effective room policy has not been observed');
  // The session model is required evidence. Its value is not compared: an
  // explicit request or a model outside the historical records is not a
  // mismatch, and a provider that cannot take images fails at delivery.
  const modelObserved = tuple.observedModel !== 'unavailable' && tuple.observedModel !== '';
  if (!modelObserved) observations.push('the session model has not been observed');
  const granted = (['edits', 'commands', 'network'] as const).filter(
    (permission) => tuple.permissions?.[permission],
  );
  if (current) {
    const contract = tuple.roomContract;
    const checks = Object.keys(grokRoomContractChecks) as GrokRoomContractCheck[];
    const named = (names: GrokRoomContractCheck[]) =>
      listed(names.map((check) => grokRoomContractChecks[check]));
    // The checks only mean something under a policy this gate knows.
    if (contract?.policy !== 'isolated-rooms-v1')
      observations.push('the isolated-room runtime contract has not been observed');
    else {
      // Collected independently: an unobserved check never hides a failed one.
      const missing = checks.filter((check) => typeof contract[check] !== 'boolean');
      const failed = checks.filter((check) => contract[check] === false);
      if (missing.length)
        observations.push(`the runtime contract has unobserved checks: ${named(missing)}`);
      if (failed.length) mismatches.push(`the observed runtime contract failed: ${named(failed)}`);
    }
  }
  if (current && tuple.nativeInventoryVerified === undefined)
    observations.push('native tool inventory has not been observed');
  else if (current && tuple.nativeInventoryVerified === false)
    mismatches.push('the observed native tool inventory failed policy verification');
  if (!policyUnknown && !current && granted.length)
    mismatches.push(
      `room ${granted.length === 1 ? 'permission' : 'permissions'} ${listed(granted)} ${granted.length === 1 ? 'is' : 'are'} on; the verified tuple requires edits, commands and network off`,
    );
  if (!policyUnknown && !current && tuple.skillsEnabled)
    mismatches.push('skills are enabled; the verified tuple requires skills disabled');
  if (!current && tuple.commandMode !== undefined && tuple.commandMode !== 'off')
    mismatches.push('command mode is on; the verified tuple requires command mode off');
  // Bounded diagnostics only: identities are reported, never compared.
  const live = [
    ...(current && identityObserved ? [`live CLI ${tuple.cliVersion}`] : []),
    ...(modelObserved ? [`observed model ${safeModelIdentity(tuple.observedModel)}`] : []),
  ];
  return mismatches.length
    ? unavailable(
        'unsupported',
        `Grok's verified initial-image tuple does not match: ${[...mismatches, ...observations, ...live].join('; ')}`,
      )
    : observations.length
      ? unavailable(
          'not_observed',
          `Grok initial images not observed: ${[...observations, ...live].join('; ')}`,
        )
      : available();
}

/**
 * Code-owned bridge identities shared by the host and its isolated MCP process.
 * Each provider registers exactly one key here, in source. This is the whole
 * registration authority: the historical catalogs below record evidence and
 * grant nothing, and a CLI version, model or effort never authorizes a key.
 * Adding an entry is not acceptance; it requires docs/image-support.md staging
 * and provider acceptance.
 */
export interface ImageBridgeRegistration {
  provider: ImageProvider;
  key: string;
}
export const claudeImageBridge: ImageBridgeRegistration = Object.freeze({
  provider: 'claude',
  key: 'claude-mcp-image',
});
export const codexImageBridge: ImageBridgeRegistration = Object.freeze({
  provider: 'codex',
  key: 'codex-dynamic-image',
});
export const grokImageBridge: ImageBridgeRegistration = Object.freeze({
  provider: 'grok',
  key: 'grok-mcp-image',
});
const imageBridges: readonly ImageBridgeRegistration[] = Object.freeze([
  claudeImageBridge,
  codexImageBridge,
  grokImageBridge,
]);
/**
 * True only for a registered key, and for the provider that owns it when one
 * is named. Unknown keys and wrong-provider pairs are refused whatever the CLI,
 * model, effort or evidence record says.
 */
export function registeredImageMapping(key: unknown, provider?: unknown): boolean {
  return imageBridges.some(
    (entry) => entry.key === key && (provider === undefined || entry.provider === provider),
  );
}

/**
 * Immutable record of the Grok CLI identities and evidence that were actually
 * exercised, with the model and room each run observed. `grokInitialImageGate`
 * does not look a build or a model up here: `cliVersion`, `observedModel` and
 * `roomPolicy` say what the linked evidence ran on, and an entry neither grants
 * nor denies images for the live CLI. The key names which registered bridge the
 * evidence went through; it does not register it. Historical issue numbers
 * identify the work; deleted raw records remain under the #99 custody process.
 */
interface TestedGrokImageBuild {
  provider: 'grok';
  key: string;
  cliVersion: string;
  requestedModel: string;
  observedModel: string;
  roomPolicy: 'restricted-v1' | 'isolated-rooms-v1';
  historicalIssues: readonly number[];
}
export const testedImageBuilds: readonly TestedGrokImageBuild[] = Object.freeze([
  // #69 ran the restricted, sandboxed-command and trusted-command rooms through
  // the browser, controller and built-CLI PTY on the managed 1.0.34 CLI. This
  // records that identity's evidence. It is not what makes 1.0.34 eligible.
  Object.freeze({
    provider: 'grok' as const,
    key: 'grok-mcp-image',
    cliVersion: 'grok 1.0.34 (3736acbc8658) [stable]',
    roomPolicy: 'isolated-rooms-v1' as const,
    requestedModel: 'provider default',
    observedModel: 'grok-4.6',
    historicalIssues: Object.freeze([69]),
  }),
  // The restricted and sandboxed-command rooms passed browser, controller and
  // built-CLI PTY acceptance on this build in #56. #69's 1.0.34 runs are a
  // separate entry: one build's evidence is never relabelled as another's.
  Object.freeze({
    provider: 'grok' as const,
    key: 'grok-mcp-image',
    cliVersion: 'grok 1.0.30 (04b7ffed98c6) [stable]',
    roomPolicy: 'isolated-rooms-v1' as const,
    requestedModel: 'provider default',
    observedModel: 'grok-4.6',
    historicalIssues: Object.freeze([56]),
  }),
  Object.freeze({
    provider: 'grok' as const,
    key: 'grok-mcp-image',
    cliVersion: legacyRestrictedGrokBuild,
    roomPolicy: 'restricted-v1' as const,
    requestedModel: 'provider default',
    observedModel: 'grok-4.6',
    historicalIssues: Object.freeze([32, 35, 33, 50]),
  }),
]);
export function grokImageSupport(tuple?: GrokImageTuple): ImageSupportReport {
  if (!tuple) {
    const reason = 'Grok has not connected, so its initial-image tuple is unknown';
    return {
      provider: 'grok',
      initial: unavailable('not_observed', reason),
      retrieval: unavailable(
        'not_observed',
        'Grok has not connected, so its retrieval tuple is unknown',
      ),
    };
  }
  const initial = grokInitialImageGate(tuple);
  return {
    provider: 'grok',
    initial,
    retrieval: initial.available
      ? available()
      : unavailable(
          initial.status,
          initial.reason
            .replace('initial-image', 'retrieval')
            .replace('initial images', 'retrieval'),
        ),
  };
}

export interface ClaudeImageTuple {
  cliVersion: string;
  requestedModel: string;
  requestedEffort: string;
  /** Evidence and a bounded diagnostic only. */
  observedModel?: string;
  /** Evidence only: the accepted Claude build does not acknowledge effort natively. */
  observedEffort?: string;
  /** The adapter's provider process is running. */
  connected: boolean;
  /** Undefined until a turn's init event lists the native tools. */
  nativeInventoryVerified?: boolean;
}

/**
 * Historical Claude coverage: accepted only after both rooms and all product
 * entry paths passed. Each record keeps the CLI identity, the requested model
 * and effort and the observed turn model of its own runs. Since #85 the CLI
 * identity is evidence and a bounded diagnostic, and since #105 so are the
 * model and effort: `claudeImageSupport` consults none of these records and
 * compares no tuple. An unlisted build, model or effort is presumed compatible
 * when the live requirements pass, not visually tested.
 */
export const testedClaudeImageBuilds: readonly {
  provider: 'claude';
  key: 'claude-mcp-image';
  cliVersion: string;
  requestedModel: string;
  requestedEffort: string;
  observedModel: string;
  historicalIssues: readonly number[];
}[] = Object.freeze([
  {
    provider: 'claude',
    key: 'claude-mcp-image',
    cliVersion: '2.1.268 (Claude Code)',
    requestedModel: 'opus',
    requestedEffort: 'xhigh',
    observedModel: 'claude-opus-5',
    historicalIssues: [53],
  },
  // #57: the owner accepted this build as a scope decision beyond that ticket's text.
  // It is a separate entry with its own full run set; 2.1.268's evidence is not reused.
  {
    provider: 'claude',
    key: 'claude-mcp-image',
    cliVersion: '2.1.274 (Claude Code)',
    requestedModel: 'opus',
    requestedEffort: 'xhigh',
    observedModel: 'claude-opus-5',
    historicalIssues: [57],
  },
  // #57: the managed CLI moved again on 2026-09-18; the owner accepted this build the
  // same way. Its own six-run set backs it; 2.1.268 and 2.1.274 evidence is not reused.
  {
    provider: 'claude',
    key: 'claude-mcp-image',
    cliVersion: '2.1.276 (Claude Code)',
    requestedModel: 'opus',
    requestedEffort: 'xhigh',
    observedModel: 'claude-opus-5',
    historicalIssues: [57],
  },
  // #57: the managed CLI moved once more on 2026-09-18, before the 2.1.276 continuity
  // rows could run; the owner accepted this build the same way. Its own six-run set
  // backs it; 2.1.268, 2.1.274 and 2.1.276 evidence is not reused.
  {
    provider: 'claude',
    key: 'claude-mcp-image',
    cliVersion: '2.1.277 (Claude Code)',
    requestedModel: 'opus',
    requestedEffort: 'xhigh',
    observedModel: 'claude-opus-5',
    historicalIssues: [57],
  },
]);

/**
 * Claude's image gate. Images are eligible from connection, before any turn, in
 * every room configuration. The one live observation that closes them is an
 * observed native tool inventory that failed policy verification; a turn whose
 * init lists an unexpected native tool is aborted by the adapter whatever this
 * report says. The CLI identity, the requested model and effort and the observed
 * model are reported, never compared, so an unlisted build or an untested model
 * is decided by the same requirements as a recorded one, and a provider that
 * cannot take images fails at delivery.
 */
export function claudeImageSupport(tuple: ClaudeImageTuple): ImageSupportReport {
  const observations: string[] = [];
  const unsupported: string[] = [];
  if (!tuple.connected) observations.push('the Claude process is not connected');
  if (tuple.nativeInventoryVerified === false)
    unsupported.push('the observed native tool inventory failed policy verification');
  // Bounded diagnostics only: identities are reported, never compared. Empty or
  // unrecognized text renders as unknown/unrecognized and closes nothing.
  const live = [
    `live CLI ${safeCliIdentity(tuple.cliVersion)}`,
    ...(tuple.observedModel ? [`observed model ${safeModelIdentity(tuple.observedModel)}`] : []),
  ];
  const initial =
    observations.length || unsupported.length
      ? unavailableFrom('Claude', 'initial images', observations, unsupported, live)
      : available();
  const retrieval =
    observations.length || unsupported.length
      ? unavailableFrom('Claude', 'retrieval', observations, unsupported, live)
      : available();
  return {
    provider: 'claude',
    initial,
    retrieval,
  };
}

export interface CodexImageTuple {
  cliVersion: string;
  requestedModel: string;
  requestedEffort: string;
  observedModel?: string;
  observedEffort?: string;
  /** The native policy result startup enforces, for the live thread only. */
  nativePolicyVerified?: boolean;
}

/**
 * Historical Codex coverage: the build, model and effort accepted for verified
 * fresh threads after #52's six live runs. As for Claude, this is a record of
 * what was exercised: `codexImageSupport` consults it for nothing and compares
 * no model or effort. The verified native policy and the observed session
 * identity decide every identity, for fresh and resumed threads alike.
 */
export const testedCodexImageBuilds: readonly {
  provider: 'codex';
  key: 'codex-dynamic-image';
  cliVersion: string;
  model: string;
  effort: string;
  historicalIssues: readonly number[];
}[] = Object.freeze([
  {
    provider: 'codex',
    key: 'codex-dynamic-image',
    cliVersion: 'codex-cli 0.154.0',
    model: 'gpt-6-astra',
    effort: 'xhigh',
    historicalIssues: [52],
  },
]);

/**
 * Codex's image gate. Eligibility comes from the live observations the adapter
 * made on its own thread: the native session reported its model and effort and
 * the native policy checks that startup enforces passed. A resumed thread and
 * any room configuration are decided by the same requirements as a fresh one.
 * The CLI identity and the requested and observed model and effort are reported,
 * never compared, so an unlisted build or an untested model/effort pair is
 * decided by the same requirements as the recorded one.
 */
export function codexImageSupport(tuple: CodexImageTuple): ImageSupportReport {
  const observations: string[] = [];
  const unsupported: string[] = [];
  if (!tuple.observedModel) observations.push('native session model has not been observed');
  if (!tuple.observedEffort) observations.push('native session effort has not been observed');
  if (tuple.nativePolicyVerified === undefined)
    observations.push('native policy checks have not completed');
  else if (tuple.nativePolicyVerified === false)
    unsupported.push('the observed native policy checks failed');
  // Bounded diagnostics only, exactly as for Claude above.
  const live = [
    `live CLI ${safeCliIdentity(tuple.cliVersion)}`,
    ...(tuple.observedModel
      ? [
          `observed model ${safeModelIdentity(tuple.observedModel)}` +
            (tuple.observedEffort ? ` at effort ${safeModelIdentity(tuple.observedEffort)}` : ''),
        ]
      : []),
  ];
  const initial =
    observations.length || unsupported.length
      ? unavailableFrom('Codex', 'initial images', observations, unsupported, live)
      : available();
  const retrieval =
    observations.length || unsupported.length
      ? unavailableFrom('Codex', 'retrieval', observations, unsupported, live)
      : available();
  return {
    provider: 'codex',
    initial,
    retrieval,
  };
}
