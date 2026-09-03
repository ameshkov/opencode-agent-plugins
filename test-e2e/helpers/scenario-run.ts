/**
 * Convenience wrapper around {@link Scenario} for the e2e suites: boot one
 * scenario container, run a body, ensure cleanup regardless of outcome.
 */

import { Scenario, type ScenarioOptions } from './scenario.js';
import type { SessionRun } from './capture.js';

/**
 * Runs a function against a fresh scenario container, cleaning up after.
 *
 * @param image - The e2e image tag.
 * @param mode - Scenario mode (see `write-config.mjs`).
 * @param options - Fake-model and env options.
 * @param body - The scenario body.
 */
export async function withScenario(
  image: string,
  mode: string,
  options: ScenarioOptions,
  body: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const scenario = new Scenario(image, mode, options);
  await scenario.start();
  try {
    await body(scenario);
  } finally {
    await scenario.stop();
  }
}
