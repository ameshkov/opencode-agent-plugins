/**
 * Shared types for the registration pipeline (`src/register.ts` and its
 * `register-*.ts` siblings).
 *
 * These live in their own module because the pipeline is split across
 * several files: the entry orchestration (`register.ts`), the MCP
 * registration (`register-mcp.ts`) and the skills registration
 * (`register-skills.ts`) all mutate the same opencode `Config` shape and
 * share the per-hook-run collision state, so the types must be importable
 * without creating a cycle.
 */

import type { Config } from '@opencode-ai/plugin';

/** Runtime shape of `config.skills` (the SDK type lags here). */
export type RuntimeConfig = Config & { skills?: { paths: string[] } };

/** Registration state shared across the components of one hook run. */
export interface RegisterState {
  /** MCP names registered earlier in this hook run (plugin–plugin collisions). */
  registeredMcp: Set<string>;
  /** Skills roots registered earlier in this hook run (plugin–plugin collisions). */
  registeredSkillsPaths: Set<string>;
  /** Plugin roots already registered this run (dedupe by realpath). */
  seenRoots: Set<string>;
}
