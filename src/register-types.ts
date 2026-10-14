/**
 * Shared types for the registration pipeline (`src/register.ts` and its
 * `register-*.ts` siblings).
 *
 * These live in their own module because the pipeline is split across
 * several files: the entry orchestration (`register.ts`), the MCP
 * registration (`register-mcp.ts`) and the skills registration
 * (`register-skills.ts`) all register through the same V2 plugin context
 * domains and share the per-setup collision state, so the types must be
 * importable without creating a cycle.
 *
 * The `RegistrationContext` below is the *subset* of `@opencode/plugin`'s
 * `Context` the pipeline uses, spelled out against the SDK's own editor types
 * (type-only imports, erased at compile time). `src/index.ts` passes the real
 * context, so TypeScript checks assignability at that call site and a V2 SDK
 * change fails `pnpm typecheck`.
 */

import type { Context } from '@opencode/plugin/promise/plugin';
import type { MCPEditor } from '@opencode/plugin/promise/mcp';
import type { Registration } from '@opencode/plugin/promise/registration';
import type { SkillEditor } from '@opencode/plugin/promise/skill';

/** The subset of the V2 plugin context the registration pipeline uses. */
export interface RegistrationContext {
  /** Location this plugin instance was loaded for. */
  readonly location: Context['location'];
  /** Plugin options from the V2 `{ package, options }` config entry. */
  readonly options: Context['options'];
  /** Skills domain. */
  readonly skill: {
    /** Registers a synchronous skills transform. */
    transform(callback: (editor: SkillEditor) => void): Promise<Registration>;
  };
  /** MCP domain. */
  readonly mcp: {
    /** Registers a synchronous MCP transform. */
    transform(callback: (editor: MCPEditor) => void): Promise<Registration>;
  };
}

/** Registration state shared across the components of one setup run. */
export interface RegisterState {
  /** MCP names registered earlier in this run (plugin–plugin collisions). */
  registeredMcp: Set<string>;
  /** Skill names registered earlier in this run (plugin–plugin collisions). */
  registeredSkillNames: Set<string>;
  /** Plugin roots already registered this run (dedupe by realpath). */
  seenRoots: Set<string>;
}
