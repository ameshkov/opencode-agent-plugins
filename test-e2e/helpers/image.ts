/**
 * Shared image lookup for the docker e2e suites.
 *
 * The image is built exactly once per run by `test-e2e/global-setup.ts`
 * (globalSetup runs in its own context, before any worker); it records the
 * built tag in {@link IMAGE_CACHE_FILE} so every test file reads the same
 * image instead of building it again.
 */

import { readFile } from 'node:fs/promises';
import { IMAGE_CACHE_FILE } from './constants.js';

/**
 * Returns the tag of the e2e image built by global-setup.ts.
 *
 * Throws with a pointer to the setup step when global-setup has not recorded
 * an image (e.g. the suite is run without the e2e vitest config).
 *
 * @returns The image tag (e.g. `opencode-agent-plugins-e2e:1.18.25`).
 */
export async function imageTag(): Promise<string> {
  const text = await readFile(IMAGE_CACHE_FILE, 'utf8').catch(() => null);
  if (text === null || text.trim() === '') {
    throw new Error('e2e image was not built: run `pnpm test:e2e` (global-setup builds it)');
  }
  const parsed = JSON.parse(text) as { tag?: unknown };
  if (typeof parsed.tag !== 'string' || parsed.tag === '') {
    throw new Error(`e2e image cache is malformed: ${text}`);
  }
  return parsed.tag;
}
