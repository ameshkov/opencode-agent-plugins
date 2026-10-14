/**
 * Stub V2 plugin context for tests.
 *
 * Implements the `RegistrationContext` subset the pipeline uses: an in-memory
 * skills/MCP registry with the same semantics as the real transform editors
 * (edits build on the baseline + earlier registrations) and an async `list()`
 * baseline read. For skills the baseline models other plugins' registrations
 * only — config skills are invisible to transforms (§9.1.5); for MCP it also
 * models config-defined servers, which are visible. Test support code — must
 * NOT end in `.test.ts`.
 */

import type { Mcp, Skill } from '@opencode/plugin';
import type { MCPEditor } from '@opencode/plugin/promise/mcp';
import type { SkillEditor } from '@opencode/plugin/promise/skill';
import { parseOptions } from '../src/options.js';
import { registerAgentPlugins } from '../src/register.js';
import type { RegistrationContext } from '../src/register-types.js';
import type { LogSink } from '../src/utils/logger.js';
import { createLogger, type LogLevel, type Logger } from '../src/utils/index.js';

/** One recorded log entry. */
export interface RecordedLog {
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

/** A logger plus the entries it recorded. */
export interface RecordingLogger {
  logger: Logger;
  entries: RecordedLog[];
}

/**
 * Creates a logger that records every forwarded entry in memory.
 *
 * @param logLevel - Minimum level to forward (defaults to everything).
 * @returns The logger and its recorded entries.
 */
export function recordingLogger(logLevel: LogLevel = 'debug'): RecordingLogger {
  const entries: RecordedLog[] = [];
  const record = (level: LogLevel, message: string, extra?: Record<string, unknown>): void => {
    entries.push({ level, message, ...(extra === undefined ? {} : { extra }) });
  };
  const sink: LogSink = {
    debug: (message, extra) => record('debug', message, extra),
    info: (message, extra) => record('info', message, extra),
    warn: (message, extra) => record('warn', message, extra),
    error: (message, extra) => record('error', message, extra),
  };
  return { logger: createLogger(logLevel, sink), entries };
}

/** Options for {@link stubContext}. */
export interface StubContextOptions {
  /** Workspace directory (defaults to `process.cwd()`). */
  directory?: string;
  /** Plugin options as passed by the V2 config entry. */
  options?: Record<string, unknown>;
  /**
   * Skills already registered by other opencode plugins at the location.
   * Config skills are invisible to transforms (§9.1.5), so they cannot be
   * seeded here; for MCP, `mcp` seeds config-defined servers, which are.
   */
  skills?: Skill.Info[];
  /** MCP servers already present at the location. */
  mcp?: [string, Mcp.ServerConfig][];
}

/** A stub context plus its recorded registrations and logs. */
export interface StubContext {
  context: RegistrationContext;
  /** Skills registered through the skills transform, by id. */
  registeredSkills: Map<string, Skill.Info>;
  /** MCP servers registered through the MCP transform, by name. */
  registeredMcp: Map<string, Mcp.ServerConfig>;
  /** Logger backed by `logs`. */
  logger: Logger;
  /** Every log entry recorded during the test. */
  logs: RecordedLog[];
}

/**
 * Builds a skill definition for a baseline entry (test convenience).
 *
 * @param name - Skill name.
 * @param path - Absolute `SKILL.md` path.
 * @param id - Skill id when it differs from the name (other plugins may
 * choose `id !== name`).
 * @returns The skill definition (brands satisfied by cast).
 */
export function skillInfo(name: string, path = `/skills/${name}/SKILL.md`, id = name): Skill.Info {
  return {
    id,
    name,
    description: `${name} skill`,
    path,
    content: `# ${name}\n`,
  } as unknown as Skill.Info;
}

/**
 * Builds a stub V2 plugin context for registration tests.
 *
 * @param options - Baseline entries and options.
 * @returns The context plus its registries, logger and recorded logs.
 */
export function stubContext(options: StubContextOptions = {}): StubContext {
  const { logger, entries } = recordingLogger();
  const baselineSkills = options.skills ?? [];
  const baselineMcp = options.mcp ?? [];
  const registeredSkills = new Map<string, Skill.Info>();
  const registeredMcp = new Map<string, Mcp.ServerConfig>();

  const skillEditor = {
    list: () => [...baselineSkills, ...registeredSkills.values()],
    get: (id: string) =>
      registeredSkills.get(id) ?? baselineSkills.find((skill) => String(skill.id) === id),
    add: (skill: Skill.Info) => {
      registeredSkills.set(String(skill.id), skill);
    },
    update: () => {},
    remove: (id: string) => {
      registeredSkills.delete(id);
    },
  } as unknown as SkillEditor;

  const mcpEditor = {
    list: () => [...baselineMcp, ...registeredMcp.entries()],
    get: (name: string) => registeredMcp.get(name) ?? baselineMcp.find(([id]) => id === name)?.[1],
    set: (name: string, config: Mcp.ServerConfig) => {
      registeredMcp.set(name, config);
    },
    update: () => {},
    remove: (name: string) => {
      registeredMcp.delete(name);
    },
  } as unknown as MCPEditor;

  const context = {
    location: { directory: options.directory ?? process.cwd() },
    options: options.options ?? {},
    skill: {
      transform: async (callback: (editor: SkillEditor) => void) => {
        callback(skillEditor);
        return { dispose: async () => {} };
      },
    },
    mcp: {
      transform: async (callback: (editor: MCPEditor) => void) => {
        callback(mcpEditor);
        return { dispose: async () => {} };
      },
    },
  } as unknown as RegistrationContext;

  return { context, registeredSkills, registeredMcp, logger, logs: entries };
}

/**
 * Runs the registration pipeline against a stub context (test convenience).
 *
 * The logger is created at the level from the parsed options, mirroring the
 * plugin entry, and its entries are appended to the stub's `logs`.
 *
 * @param stub - The stub context to register into.
 * @param options - Raw plugin options.
 */
export async function runRegistration(
  stub: StubContext,
  options: Record<string, unknown>,
): Promise<void> {
  const parsed = parseOptions(options);
  const { logger, entries } = recordingLogger(parsed.options.logLevel);
  await registerAgentPlugins(stub.context, parsed, logger);
  stub.logs.push(...entries);
}

/**
 * Returns the recorded entries with the given failure boundary.
 *
 * @param stub - The stub context whose logs to filter.
 * @param boundary - The `boundary` metadata value to match.
 * @returns The matching entries.
 */
export function logsWithBoundary(stub: StubContext, boundary: string): RecordedLog[] {
  return stub.logs.filter((entry) => entry.extra?.['boundary'] === boundary);
}
