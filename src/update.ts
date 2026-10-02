import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { errorText, killTree, runProcess } from './process.js';

const packageName = '@chittr/cli';
const guide = 'https://github.com/chittr/chittr/blob/main/docs/installation.md';
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d/.test(value) && semver.valid(value) !== null;
}

function manifestVersion(root: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!object(manifest) || manifest.name !== packageName || !validVersion(manifest.version))
    throw new Error(`Invalid ${packageName} manifest at ${root}.`);
  return manifest.version;
}

function findNpm(cwd: string, env: NodeJS.ProcessEnv): string {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(cwd, directory, 'npm');
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through PATH just as executable lookup does.
    }
  }
  throw new Error(
    'npm was not found on PATH. Use the installation method that owns this Chittr copy.',
  );
}

/** npm owns replacement. Inherited streams have no buffer cap or install deadline. */
export function installWithNpm(
  npm: string,
  args: string[],
  context: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (context.signal.aborted) {
      reject(new Error('Update cancelled.'));
      return;
    }
    const child = spawn(npm, args, {
      cwd: context.cwd,
      env: context.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    let spawnError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const cancel = () => {
      killTree(child, context.signal.reason as NodeJS.Signals);
      // Give npm a chance to stop, then terminate an installer that ignores the signal.
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 1500);
    };
    context.signal.addEventListener('abort', cancel, { once: true });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      clearTimeout(killTimer);
      context.signal.removeEventListener('abort', cancel);
      if (context.signal.aborted) reject(new Error('Update cancelled; npm has stopped.'));
      else if (spawnError) reject(new Error(`Could not start npm: ${spawnError.message}`));
      else if (code !== 0) reject(new Error(`npm install failed (${signal ?? `exit ${code}`}).`));
      else resolve();
    });
  });
}

/** Standalone package maintenance: no configuration, storage or room dependencies. */
export async function updateInstallation(entrypoint: URL): Promise<void> {
  let phase: 'identity' | 'metadata' | 'install' = 'identity';
  const controller = new AbortController();
  const handlers = signals.map((signal) => {
    const handler = () => controller.abort(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    const context = { cwd: process.cwd(), env: { ...process.env }, signal: controller.signal };
    const npm = findNpm(context.cwd, context.env);
    const entry = realpathSync(fileURLToPath(entrypoint));
    if (basename(entry) !== 'cli.js' || basename(dirname(entry)) !== 'dist')
      throw new Error('This is a source installation, not an installed dist/cli.js.');
    const root = realpathSync(dirname(dirname(entry)));
    const running = manifestVersion(root);
    const query = async (args: string[]) => {
      const result = await runProcess(npm, [...args, '--global'], context);
      if (result.code !== 0)
        throw new Error(
          `npm ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
        );
      return result.stdout.trim();
    };
    const npmRoot = await query(['root']);
    if (!isAbsolute(npmRoot)) throw new Error(`npm returned an invalid global root: ${npmRoot}`);
    const destination = join(npmRoot, '@chittr', 'cli');
    let packageEntry;
    try {
      packageEntry = lstatSync(destination);
    } catch (error) {
      throw new Error(
        `This Chittr runs from ${root}, but npm on PATH has no verifiable global ${packageName} at ${destination}: ${errorText(error)}`,
      );
    }
    if (packageEntry.isSymbolicLink())
      throw new Error(
        `The global package at ${destination} is linked. Linked packages cannot self-update.`,
      );
    if (realpathSync(destination) !== root)
      throw new Error(
        `This Chittr runs from ${root}, but PATH npm installs at ${destination}. The prefixes do not match.`,
      );

    phase = 'metadata';
    const response: unknown = JSON.parse(
      await query(['view', `${packageName}@latest`, 'version', 'engines', '--json']),
    );
    // npm unwraps a single returned field when the package has no engines field.
    const metadata = typeof response === 'string' ? { version: response } : response;
    if (!object(metadata) || !validVersion(metadata.version))
      throw new Error('npm returned invalid latest-version metadata.');
    const target = metadata.version;
    if (metadata.engines !== undefined && !object(metadata.engines))
      throw new Error('npm returned invalid engines metadata.');
    const nodeRange = object(metadata.engines) ? metadata.engines.node : undefined;
    if (
      nodeRange !== undefined &&
      (typeof nodeRange !== 'string' || semver.validRange(nodeRange) === null)
    )
      throw new Error('npm returned an invalid engines.node range.');
    const comparison = semver.compare(running, target);
    if (comparison === 0) {
      process.stdout.write(`Chittr ${running} is already current.\n`);
      return;
    }
    if (comparison > 0) {
      process.stdout.write(
        `Chittr ${running} is newer than npm latest ${target}. Nothing changed.\n`,
      );
      return;
    }
    if (
      typeof nodeRange === 'string' &&
      !semver.satisfies(process.versions.node, nodeRange, { includePrerelease: true })
    )
      throw new Error(
        `Chittr ${target} requires Node ${nodeRange}; running Node ${process.versions.node}. Update Node before retrying.`,
      );

    process.stdout.write(
      `Updating Chittr ${running} to ${target} at ${destination}.\n` +
        `Close all other Chittr rooms and make the complete backup before installation.\n${guide}#back-up-and-restore\n`,
    );
    phase = 'install';
    await installWithNpm(npm, ['install', '--global', `${packageName}@${target}`], context);
    // Every import above is loaded before npm can replace this package. Read disk anew.
    if (lstatSync(destination).isSymbolicLink() || realpathSync(destination) !== root)
      throw new Error('The installation destination changed during the update.');
    const installed = manifestVersion(destination);
    if (installed !== target)
      throw new Error(
        `npm finished, but installed Chittr ${installed} does not match expected ${target}.`,
      );
    process.stdout.write(`Updated Chittr to ${installed}. Launch Chittr again to use it.\n`);
  } catch (error) {
    throw new Error(
      `Chittr update failed: ${errorText(error)}\n` +
        (phase === 'identity'
          ? `Use the installation method that owns this copy; source, local/npx, linked and other-manager installations need their own update method.\n`
          : '') +
        (phase === 'install'
          ? `npm may have changed package files; the previous package was not restored automatically.\n`
          : `Installation was not started; no package files were changed.\n`) +
        `Reinstall: ${guide}#reinstall-or-uninstall\nBackup and restore: ${guide}#back-up-and-restore`,
    );
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
}
