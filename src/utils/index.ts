/**
 * Shared, dependency-free utilities used across the plugin and the CLI.
 *
 * This layer must stay free of `@opencode-ai/*` runtime imports (type-only
 * imports are fine) so the compiled `build/` remains import-safe inside
 * opencode and the CLI runs without the SDK installed.
 */
export type { LogLevel, Logger } from './logger.js';
export { createLogger } from './logger.js';
