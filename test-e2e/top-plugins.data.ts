/**
 * Inventory and evidence shapes for the opt-in top-plugins e2e suite
 * (`top-plugins.e2e.test.ts`).
 *
 * The sources were ranked by the publishing repository's GitHub stars from
 * the agentpluginsdirectory.com census of 2026-09-11 and re-validated with
 * this client's `install --dry-run` (each source carries the canonical
 * `$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`).
 * Expected counts are checked softly: default branches move, and the report
 * records what actually resolved.
 */

/** One real-world Agent Plugin exercised in a clean container. */
export interface TopPlugin {
  /** Short id used in the test name and report. */
  id: string;
  /** Exact source string passed to `install` (default branch HEAD). */
  source: string;
  /** Manifest name the source must resolve to. */
  manifestName: string;
  /** Skill count validated at inventory time (2026-09-11). */
  expectedSkillCount: number;
  /** MCP server names the source must register. */
  expectedMcp: string[];
}

/** Structured result of `/app/scan-plugin.mjs` (one plugin tree). */
export interface ScanResult {
  /** Absolute store root the scan ran against. */
  root: string;
  /** Manifest facts; `unknownKeys` are warn+ignored and `extensions` unused. */
  manifest: {
    name: string;
    version: string | null;
    schema: string;
    rawKeys: string[];
    unknownKeys: string[];
    extensions: string[];
  };
  /** Skill names the client's validation pipeline accepts. */
  skills: string[];
  /** Raw `skills/` layout, including entries the client ignores. */
  skillsLayout: {
    present: boolean;
    dirs: string[];
    dirsWithoutSkillMd: string[];
    nestedSkillFiles: string[];
    strayEntries: string[];
  };
  /** MCP servers the client would register (post-validation preview). */
  servers: Array<{ name: string; kind: 'local' | 'remote'; target: string; headers: string[] }>;
  /** Raw `mcp.json`, including entries the client would skip. */
  mcpRaw: {
    present: boolean;
    parseError: boolean;
    schema?: string;
    topLevelKeys: string[];
    entries: Array<{ name: string; type: unknown; keys: string[] }>;
  };
  /** Taxonomy failures reported during validation. */
  warnings: Array<{ kind: string; level: string; message: string }>;
  /** True when a validation failure would abort install (MCP disabled etc.). */
  fatal: boolean;
  /** Raw top-level layout; component dirs the client ignores. */
  layout: {
    topLevel: Array<{ name: string; kind: 'dir' | 'file' }>;
    unsupportedComponentDirs: string[];
  };
}

/** Evidence collected for one plugin inside its clean container. */
export interface PluginReport {
  /** Short plugin id. */
  id: string;
  /** Configured source string. */
  source: string;
  /** CLI install outcome and printed preview. */
  install?: { exit: number; output: string };
  /** Resolved store root the scan ran against. */
  storeRoot?: string;
  /** Structured tree scan (validation + unsupported-construct findings). */
  scan?: ScanResult;
  /** `GET /config` response (registration evidence). */
  config?: unknown;
  /** `GET /mcp` response (connection status per server). */
  mcpEndpoint?: unknown;
  /** Skill names from `GET /skill` (host discovery). */
  skillEndpoint?: string[];
  /** Tool names the provider request advertised (MCP discovery). */
  providerTools?: string[];
  /** Skill names the provider request advertised. */
  providerSkills?: string[];
  /** Per-server registration/status/discovery summary. */
  mcpDiscovery?: Record<string, { registered: boolean; status: string; discovered: boolean }>;
  /** opencode log lines mentioning the plugin. */
  registrationLogs?: string[];
  /** Set when the scenario body threw (container/network failure). */
  failure?: string;
}

/** The top-10 inventory exercised by the suite. */
export const TOP_PLUGINS: TopPlugin[] = [
  {
    id: 'worldmonitor',
    source: 'https://github.com/koala73/worldmonitor.git',
    manifestName: 'worldmonitor',
    expectedSkillCount: 25,
    expectedMcp: ['worldmonitor', 'worldmonitor-docs'],
  },
  {
    id: 'context7',
    source: 'https://github.com/upstash/context7.git#:plugins/agent-plugins/context7',
    manifestName: 'context7',
    expectedSkillCount: 1,
    expectedMcp: ['context7'],
  },
  {
    id: 'chrome-devtools',
    source: 'https://github.com/ChromeDevTools/chrome-devtools-mcp.git',
    manifestName: 'chrome-devtools',
    expectedSkillCount: 7,
    expectedMcp: ['chrome-devtools'],
  },
  {
    id: 'agentic-bundle-aas',
    source:
      'https://github.com/sickn33/agentic-awesome-skills.git#:plugins/agentic-bundle-aas-accessibility-inclusive-ux',
    manifestName: 'agentic-bundle-aas-accessibility-inclusive-ux',
    expectedSkillCount: 8,
    expectedMcp: [],
  },
  {
    id: 'scientific-agent-skills',
    source: 'https://github.com/K-Dense-AI/scientific-agent-skills.git',
    manifestName: 'scientific-agent-skills',
    expectedSkillCount: 164,
    expectedMcp: [],
  },
  {
    id: 'daisyui',
    source: 'https://github.com/saadeghi/daisyui.git',
    manifestName: 'daisyui',
    expectedSkillCount: 1,
    expectedMcp: [],
  },
  {
    id: 'openviking',
    source: 'https://github.com/volcengine/OpenViking.git#:agent-plugins',
    manifestName: 'openviking',
    expectedSkillCount: 2,
    expectedMcp: ['openviking'],
  },
  {
    id: 'diffusers',
    source: 'https://github.com/huggingface/diffusers.git#:.ai',
    manifestName: 'diffusers',
    expectedSkillCount: 4,
    expectedMcp: [],
  },
  {
    id: 'openwork-connect',
    source:
      'https://github.com/different-ai/openwork.git#:integrations/agent-plugins/openwork-connect',
    manifestName: 'openwork-connect',
    expectedSkillCount: 1,
    expectedMcp: ['openwork'],
  },
  {
    id: 'hindsight',
    source: 'https://github.com/vectorize-io/hindsight.git#:hindsight-integrations/agent-plugin',
    manifestName: 'hindsight',
    expectedSkillCount: 1,
    expectedMcp: ['hindsight'],
  },
];
