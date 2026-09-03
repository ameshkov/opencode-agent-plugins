/**
 * `docker exec` helpers for the e2e scenario containers.
 *
 * Every command runs with the shared HOME (`/app/opencode-home`) so the CLI
 * resolves the same client store the opencode plugin uses at startup, and
 * with cwd `/app/workspace` (the opencode project root). Commands are argv
 * arrays — no shell in the image by design.
 */

import type { StartedTestContainer } from 'testcontainers';

/** Container environment shared by every exec (matches bootstrap). */
const EXEC_ENV = { HOME: '/app/opencode-home' };

/** Result of one `docker exec` inside the container. */
export interface ExecOutcome {
  code: number;
  output: string;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command inside the container.
 *
 * @param container - The booted scenario container.
 * @param args - Command argv (no shell).
 * @returns The exit code and captured output.
 */
export async function execIn(
  container: StartedTestContainer,
  args: string[],
): Promise<ExecOutcome> {
  const result = await container.exec(args, {
    workingDir: '/app/workspace',
    env: { ...EXEC_ENV },
  });
  return {
    code: result.exitCode,
    output: result.output,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Reads a file from the container as UTF-8.
 *
 * @param container - The booted scenario container.
 * @param path - Absolute in-container path.
 * @returns The file content, or '' when unreadable.
 */
export async function readFileIn(container: StartedTestContainer, path: string): Promise<string> {
  const result = await execIn(container, [
    'node',
    '-e',
    `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)}, 'utf8'))`,
  ]);
  return result.code === 0 ? result.stdout : '';
}

/**
 * Whether a path exists inside the container.
 *
 * @param container - The booted scenario container.
 * @param path - Absolute in-container path.
 * @returns True when the path exists.
 */
export async function existsIn(container: StartedTestContainer, path: string): Promise<boolean> {
  const result = await execIn(container, ['test', '-e', path]);
  return result.code === 0;
}

/**
 * Signals the `cli` scenario bootstrap to start opencode (via the serve
 * marker) after the test has run its CLI commands.
 *
 * @param container - The booted scenario container.
 */
export async function markServeIn(container: StartedTestContainer): Promise<void> {
  const result = await execIn(container, [
    'node',
    '-e',
    "require('fs').writeFileSync('/app/ctrl/serve', '')",
  ]);
  if (result.code !== 0) {
    throw new Error(`markServe failed: ${result.output}`);
  }
}
