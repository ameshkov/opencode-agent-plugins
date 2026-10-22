/**
 * Shared, dependency-free utilities used across the plugin and the CLI.
 *
 * This layer must stay free of `@opencode/*` runtime imports (type-only
 * imports are fine). The plugin entry and `src/lib/` keep zero runtime
 * `@opencode/*` imports; the CLI layer depends on `@opencode/client` only
 * for the reload call.
 */
export type { LogLevel, Logger } from './logger.js';
export { createLogger } from './logger.js';
