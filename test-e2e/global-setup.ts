/**
 * Vitest globalSetup for the docker e2e suite.
 *
 * Runs once per `pnpm test:e2e`, before any test file (and in its own
 * context, so no file can build the image twice):
 *
 * 1. verifies Docker is reachable — this suite is a CI release gate, so it
 *    hard-fails instead of silently skipping (`docs/explanation/design.md` §9.2.4);
 * 2. builds the e2e image (`test-e2e/Dockerfile`) once;
 * 3. records the built image tag in {@link IMAGE_CACHE_FILE}, which every
 *    test file reads via `helpers/image.ts`.
 */

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { GenericContainer } from 'testcontainers';
import { IMAGE_CACHE_FILE, IMAGE_NAME, OPENCODE_VERSION } from './helpers/constants.js';

const execFileP = promisify(execFile);

/**
 * Builds the shared e2e image once and records its tag.
 *
 * testcontainers' `build()` skips the build when the tag already exists, so a
 * stale local image (e.g. from pre-change fixtures or a different
 * OPENCODE_VERSION checkout) must be removed first — otherwise the suite
 * silently tests the wrong image. `docker build` layer caching still makes
 * repeat runs fast.
 *
 * @throws {Error} When Docker is unreachable (the gate is mandatory).
 */
export default async function setup(): Promise<void> {
  await execFileP('docker', ['info']).catch(() => {
    throw new Error('e2e requires a running Docker engine (`docker info` failed)');
  });
  // Local-iteration escape hatch: `E2E_IMAGE_REUSE=1` trusts an existing
  // image (must have been built from the CURRENT Dockerfile/build).
  if (process.env['E2E_IMAGE_REUSE'] !== '1') {
    await execFileP('docker', ['image', 'rm', '-f', IMAGE_NAME]).catch(() => {
      // No previous image — nothing to remove.
    });
    await GenericContainer.fromDockerfile('.', 'test-e2e/Dockerfile')
      .withBuildArgs({ OPENCODE_VERSION })
      .build(IMAGE_NAME);
  }
  await writeFile(IMAGE_CACHE_FILE, JSON.stringify({ tag: IMAGE_NAME }));
}
