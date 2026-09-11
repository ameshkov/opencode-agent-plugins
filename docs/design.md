# Design: `opencode-agent-plugins`

**Status:** Draft
**Date:** 2026-09-01
**Repo:** `opencode-agent-plugins`
**Target spec:** [Agent Plugins Specification v1.0.0](https://agent-plugins.org/specification) (published), conformance per the [client implementers checklist](https://agent-plugins.org/client-implementers/conformance).

---

## 1. Goal

Build an Opencode plugin, configured as

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-agent-plugins", { "plugins": "<path-to-plugin>" }]
  ]
}
```

that acts as a **conformant Agent Plugins client** for Opencode: it loads a plugin
package (a directory containing `plugin.json`, optionally `skills/` and `mcp.json`),
validates it against the Agent Plugins specification, and registers its components
into Opencode:

- **Skills** → registered via `config.skills.paths` (Opencode scans each path for
  `SKILL.md` files — scan depth verified per release, see §5.6), so plugin skills
  appear in the `skill` tool with no file copies.
- **MCP servers** → translated from the portable `mcp.json` format into Opencode's
  native `config.mcp` entries (a `stdio` server becomes `type: "local"`, a remote
  server becomes `type: "remote"`).
- **`PLUGIN_ROOT` / `PLUGIN_DATA`** → provided to stdio subprocess environments,
  with a client-managed persistent data directory per plugin instance.

Beyond the plugin, the package ships a **CLI** (`opencode-agent-plugins`) that
manages the plugin lifecycle: install (from a local path or a git URL), remove,
check for updates, update, list, and store hygiene (doctor/prune) — see
§5.11–§5.12.

### 1.1 Non-goals (v1)

- No package registry: sources are local paths and git URLs (https, ssh) only;
  npm/registry distribution is future work (§12).
- No new component types beyond skills and MCP servers (the v1 portable format
  defines exactly these two; other types are outside the spec and ignored).
- No OAuth/credential plumbing: per the spec, authorization is client-managed.
  Opencode already handles OAuth for remote MCP servers (`opencode mcp auth`).
- No file-based client extension namespace support (none implemented in v1).
- No hot reload of running Opencode sessions: plugin registrations are applied at
  Opencode startup; the CLI therefore asks the user to restart Opencode after
  install/remove/update (§5.12.4).

---

## 2. Background

### 2.1 The Agent Plugins format (what a client must do)

A plugin is a **directory** with a required `plugin.json` manifest and optional
components at **fixed locations**:

| Component | Fixed location | Notes |
| --- | --- | --- |
| Skills | `skills/<name>/SKILL.md` | Immediate children only; no recursion. Skills conform to the Agent Skills spec. |
| MCP servers | `mcp.json` | Closed format: `$schema` + `mcpServers`. Server variants: `stdio`, `streamable-http`, `sse`. |
| Client extensions | `extensions` object / top-level dirs | Reverse-DOM namespaces; client-specific. |

Key normative behaviors the client must implement (full list in §7):

1. **Manifest is a closed schema** — only `$schema`, `name`, `version`, `description`,
   `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`.
   Unknown top-level fields and a non-object `extensions` are *reported and ignored*
   (non-fatal); any other violation is *fatal* (reject plugin, load nothing).
   `$schema` must be a recognized canonical identifier; the client must **not**
   fetch schemas while loading.
2. **Name constraints** (§5.5): 1–64 chars, `a-z 0-9 - .`, alphanumeric start/end,
   no `--`, no `..`.
3. **Path containment** (§4.1): every package path the client touches must resolve
   within the filesystem-resolved plugin root. Failure boundaries are narrowest-first
   (reject plugin → invalid component type → skip skill → invalid server entry →
   deny path).
4. **Placeholder expansion** (§9.2): `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` only, only
   in `args`, `env` **values**, and `cwd`; single non-recursive textual replacement;
   unrecognized placeholder-like text stays literal; no expansion in `command`,
   `url`, headers, env keys.
5. **Subprocess environment** (§9.1): `PLUGIN_ROOT` (plugin root) and `PLUGIN_DATA`
   (client-managed persistent dir, created before launch, writable, preserved across
   updates) must be supplied; configured `env` entries for these names are invalid.
6. **Failure isolation** (§11.3): a bad `mcp.json`, bad server entry, unsupported
   transport, or a server that fails to start/connect must not affect other
   components; only the narrowest unit is dropped.
7. **Version consistency**: `mcp.json` `$schema` version must match `plugin.json`'s.

### 2.2 Opencode integration points (verified against the opencode source/docs)

| Need | Opencode facility |
| --- | --- |
| Receive config | `["opencode-agent-plugins", { ... }]` → plugin function called as `(input, options)` where `options` is the second tuple element. `PluginOptions = Record<string, unknown>`. |
| Mutate config | `Hooks.config?: (config: Config) => Promise<void>` — receives the live resolved config; mutations (as done by e.g. `opencode-sdd`) take effect for the session. |
| Register MCP servers | `config.mcp[name] = { type: "local", command: string[], cwd?, environment?, enabled?, timeout? }` or `{ type: "remote", url, headers?, oauth?, enabled?, timeout? }` (from `opencode.ai/config.json` schema, `McpLocalConfig` / `McpRemoteConfig`). |
| Register skills | `config.skills.paths: string[]` — each entry is a directory scanned for `SKILL.md` files (absolute paths are used as-is). **Scan-depth discrepancy:** the skills doc describes `skills/*/SKILL.md` (one level); the 1.18.25 PoC observed behavior consistent with a recursive `**/SKILL.md` scan. The design is robust to both (§5.6), and the E2E test pins the actual behavior per release. |
| Logging | `input.client.app.log({ body: { service, level, message, extra } })` (the `body` wrapper is required — see §9.1). |
| Workspace context | `input.directory` (workspace dir, used to resolve relative plugin paths), `input.worktree`, `input.$` (Bun shell). |

Opencode's `skills.paths` config also supports `skills.urls` (remote skill indexes);
we do not use it (the spec's plugin model is directory-based, and URLs would violate
"no schema/component fetching surprises" — out of scope).

Transport mapping caveat: Opencode has no legacy HTTP+SSE client. `sse` entries are
therefore **skipped** with a reported warning per §7.2.2 rule 4 ("unsupported
transport"), which is conformance-compliant (support for `sse` is OPTIONAL).

### 2.3 Version note

The spec repo tracks a 1.1.0 **working draft** whose normative content is identical
to 1.0.0 (only schema identifiers changed). The design keys all selection logic off
the canonical `$schema` URL rather than an implied version number, so adding 1.1.0
later is a one-line compatibility map (§5.9).

---

## 3. User experience

### 3.1 Configuration

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-agent-plugins", {
      "plugins": [
        "./agent-plugins/my-plugin",
        "git+https://github.com/org/my-plugin.git#v1.2.0"
      ]
    }]
  ]
}
```

> **Why a single entry with an array, and never two `["opencode-agent-plugins", …]`
> entries:** Opencode loads duplicate npm packages with the same name and version
> **only once** (per the plugins doc, "Load order"), so a second entry would be
> silently ignored — and with two instances there would be no defined precedence
> between their config mutations. One hook instance owns all plugin registrations
> for the session, which makes collision handling and dedup deterministic (§5.7).
> This must be re-verified empirically per Opencode release (§9.1, §11).

All options in one entry:

```jsonc
["opencode-agent-plugins", {
  "plugins": ["./agent-plugins/my-plugin", "git@github.com:org/third.git"],  // string or string[]
  "prefix": false,        // true: MCP server names become "<plugin-name>-<server>" (sanitized, §5.7)
  "logLevel": "info"      // debug | info | warn | error (default: info)
}]
```

Options schema (parsed with Zod, unknown keys warn):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `plugins` | `string \| string[]` | — | Plugin source(s): local path, git URL, or an installed plugin name. Required. |
| `prefix` | `boolean` | `false` | Namespace MCP server names to avoid cross-plugin collisions. Applies to all sources in this entry. |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Minimum level forwarded to `client.app.log`. |

### 3.2 Startup behavior

On every Opencode start the plugin:

1. Resolves each configured source (§5.3): local paths are used directly (realpath,
   `~`-expanded, or relative to the workspace directory); git URLs and installed
   plugin names are resolved against the client store — **no network access at
   startup** (installing/updating is the CLI's job, §5.12).
2. Validates `plugin.json` (fatal/reject vs. report-and-ignore, per §5).
3. Discovers skills and MCP servers from fixed locations.
4. Mutates `config.skills.paths` and `config.mcp` accordingly, following the
   **precedence principle: user-authored config always wins**. The `config` hook
   runs after config resolution, so blind mutation would clobber user intent
   (e.g. an `mcp: { "name": { "enabled": false } }` stub or a user-defined server
   of the same name). Any pre-existing `config.mcp` entry or `skills.paths` entry
   that collides with a plugin registration is left untouched; the plugin's
   registration is skipped and reported. This also gives users an escape hatch
   the portable format lacks (per-server `timeout`, `enabled`, name overrides):
   define the entry yourself under the same name and the plugin defers (§5.7).
   Skills are directory-granular: a skill-name collision with an existing
   `skills.paths` entry skips the plugin's whole `skills/` dir (user config
   wins, §5.6).
5. Logs a structured summary: loaded N skills, M servers (M-local/remote/skipped),
   per-plugin status. No startup crashes ever — every failure goes through the
   failure taxonomy (§6).

### 3.3 What the user sees

- Skills: appear in the `<available_skills>` list automatically (surface —
  system prompt vs. `skill` tool description — is version-dependent, §9.1).
- MCP tools: available as `<server-name>_*` tools; can be gated with
  `tools: { "server-name_*": false }` or per-agent overrides as usual.
- Diagnostics: `client.app.log` entries with `service: "opencode-agent-plugins"`;
  `opencode debug config` shows the final merged `mcp`/`skills` state.

---

## 4. Architecture

```text
opencode (config hook)                    CLI (opencode-agent-plugins bin)
   │  config (mutable) + options              │  install | remove | check | update | list
   ▼                                          ▼
┌──────────────────────────────────────────────────────────────────┐
│          shared core: one module per spec concern                │
│  source resolution   install/update lifecycle   client store     │
│  manifest validation skills discovery           mcp translation  │
│  containment + placeholder expansion            PLUGIN_DATA      │
│  failure taxonomy (types shared by both)                         │
└───────────────────┬────────────────────────────┬─────────────────┘
                    ▼                            ▼
        plugin entry (opencode Plugin)    CLI entry (bin)
        wraps core with input.client       wraps core with stdio prompts
        ──────────────┴──────────────────────────┴──────────────
                    ▼
        config.skills.paths += <pluginRoot>/skills
        config.mcp[name]     = { type: "local"|"remote", ... }
        (PLUGIN_DATA dirs created when stdio servers are registered)
```

The shared core is the single implementation of validation, translation,
and store management; the Opencode plugin and the CLI are thin wrappers — the CLI
validates exactly what the plugin will load, so `install` can never register
something the plugin would reject.

Modules keep the four spec concerns separate — **validation**, **isolation**,
**containment**, **registration** — so each failure boundary maps to exactly one
code path (see §6).

### 4.1 Package layout

```text
opencode-agent-plugins/
├── src/
│   ├── plugin entry             # (input, options) => Hooks
│   ├── CLI                      # the opencode-agent-plugins binary
│   ├── lib/                     # shared core: one module per spec concern
│   └── schemas/                 # vendored Agent Plugins schemas (committed)
├── scripts/                     # build/dev gates (schema sync, import checks)
├── test/                        # unit/integration test support (helpers, stub client)
└── test-e2e/                    # Docker E2E suite against a real opencode
```

The exact file split is left to the implementation — what is pinned here is
that the shared core is a single module layer below both entrypoints with one
module per spec concern (§4, §6), and that the vendored schemas are committed
artifacts, never fetched at runtime (§5.4).

### 4.2 Technical design: language, entrypoints, packaging

**Language and build.** The tool is written in **TypeScript** (ESM, compiled with
`tsc` to `build/`; no bundler — mirrors the `opencode-sdd`
layout). Target runtimes: **Bun** for the plugin entrypoint (Opencode's plugin
loader) and **Node ≥ 26** for the CLI; shared-core code sticks to the portable
intersection (`node:*` builtins only — no Bun-only APIs — so both runtimes run
the same compiled output).

**Two entrypoints, one package.** The npm package exposes exactly two
entrypoints, both thin wrappers over the shared core:

| # | Entrypoint | Output | Contract | Runtime |
| --- | --- | --- | --- | --- |
| 1 | Opencode plugin | `build/index.js` | Default-exports a `Plugin` (`(input, options) => Hooks`); only the `config` hook is used (§5.1). Zero top-level side effects (§5.1 import-safety note). | Bun (inside Opencode) |
| 2 | CLI | `build/cli/index.js` | Exposed as the `opencode-agent-plugins` bin with a `#!/usr/bin/env node` shebang; command surface in §5.11. | Node ≥ 26 |

```jsonc
// package.json (excerpt)
{
  "name": "opencode-agent-plugins",
  "type": "module",
  "main": "./build/index.js",              // entrypoint 1: opencode plugin
  "exports": { ".": "./build/index.js" },
  "bin": { "opencode-agent-plugins": "./build/cli/index.js" },  // entrypoint 2
  "files": ["build"]
}
```

Dependency boundaries:

- The shared core imports only `node:*`, Ajv, Zod, and `jsonc-parser` —
  **never** `@opencode-ai/*`, so the CLI installs and runs with no Opencode
  dependency.
- The plugin entry uses `@opencode-ai/plugin` as a **type-only** import
  (`import type { Plugin, Hooks }`), so it stays a devDependency and nothing
  Opencode-specific ends up in the CLI's module graph.

**Decision: single package — not a multi-package workspace.** A
`packages/core` + `packages/opencode-plugin` + `packages/cli` workspace was
considered and rejected for v1:

- The shared code is one small library and both wrappers are thin; a workspace
  adds publishing and topological-build complexity with no consumer-facing
  benefit.
- The plugin and the CLI **must version and publish together anyway** — the
  design invariant is that `install`-time validation is byte-identical to
  load-time validation (§4), which is trivially guaranteed when both ship from
  one `build/` of one commit.
- Opencode loads plugins as a single npm package name, and the CLI must ship
  from that same package (users get `opencode-agent-plugins` the CLI by
  installing `opencode-agent-plugins` the plugin) — two published packages
  would invite version skew between them.
- The separation a workspace would enforce already exists as a module boundary:
  the shared core has no Opencode imports, and a lint rule (or a test that walks the
  CLI's import graph) pins that. If the core ever gains independent consumers,
  it can be extracted into its own package later (§12).

---

## 5. Component design

### 5.1 Entry point

```ts
import type { Plugin, Hooks } from "@opencode-ai/plugin";

const agentPlugins: Plugin = async (input, options) => {
  const logger = createLogger(input.client, options);
  return {
    config: async (config) => {
      await registerAgentPlugins(config, options, logger);
    },
  };
};

export default agentPlugins;
```

The `config` hook is the only hook we need: registration mutates `config.mcp` and
`config.skills`. All per-plugin failures are caught, mapped through the taxonomy
(§6) and logged; the hook never throws (a throwing hook would log a plugin error
but, per Opencode behavior, we prefer explicit per-plugin reporting).

Import-safety note: a module-level error in the plugin file makes Opencode skip the
plugin **silently** (verified on 1.18.25). The bundle must have no top-level side
effects that can throw; all work happens inside the hooks.

Defensive note: `config.skills` may be missing from the TS type of the installed
SDK version; the code normalizes it (`config.skills ??= { paths: [] }`) and treats
the runtime schema (`opencode.ai/config.json`) as authoritative.

### 5.2 Options

Zod-parsed, strict on known keys, warn on unknowns. See §3.1.

### 5.3 Plugin sources & resolution

#### 5.3.1 Source grammar

```text
<source>   := <local-path> | <git-url>["#"<fragment>]
<git-url>  := https://... | git+https://... | ssh://... | git+ssh://... | git@host:path (scp-like)
<fragment> := <ref> | [<ref>]":"<subdir>
<ref>      := <branch> | <tag> | <commit-sha>   (Git ref names cannot contain ":")
<subdir>   := <segment>("/"<segment>)*          (no empty, "." or ".." segment)
```

- **Local path** — absolute, `~/...` (expand `HOME`), or relative (resolved against
  `input.directory` — the workspace dir — since that is the cwd the user configures
  from). Used **in place**: edits to a path-sourced plugin are picked up on the next
  Opencode start; this is the developer workflow. A local path always points at the
  plugin root itself; it carries no fragment.
- **Git URL** — https or ssh, with an optional `#fragment`: a ref pin
  (`#v1.2.0`, `#main`, `#<sha>`), a subpath selection
  (`#v1.2.0:packages/plugin`, `#:packages/plugin`), or both (§5.3.4). Recognized
  by scheme prefixes or the scp-like `user@host:path` form; a leading `git+` is
  normalized away. Without a ref, the remote's `HEAD` is used (recorded at
  install time).
- **Installed name** — an already-installed plugin can be referenced by its
  manifest name or store slug; resolves to the copy in the client store (below).

#### 5.3.2 Client store (managed plugin copies)

```text
<data-home>/opencode/agent-plugins/
├── installed/<slug>/          # exported plugin root (repo root or subdir, no .git)
├── meta/<slug>.json           # client metadata (git URL, ref, resolved commit, ...)
├── data/<key>/                # PLUGIN_DATA (see §5.8)
└── backups/                   # config-edit .bak files, kept out of the user's repo
```

`<data-home>` follows Opencode's own data-dir convention: `$XDG_DATA_HOME` when
set, else `~/.local/share` on Linux/macOS and `%LOCALAPPDATA%` on Windows.

- `slug` is derived from the source URL (host/org/repo, sanitized) so the same
  repository is idempotently installed once; a subdir selection extends the slug
  so each plugin of a monorepo gets its own entry (§5.3.4).
- `installed/<slug>` is an **exported tree at the pinned commit — `.git` is
  removed at install time.** Nothing in the design ever uses the installed `.git`
  (update checks use `ls-remote`, updates re-clone to staging, §5.12.3), so
  keeping it would double disk for no benefit and invite "dirty working tree"
  confusion. Faster fetch-in-place updates are future work (§12).
- **Metadata lives outside the plugin root**, in `meta/<slug>.json`:
  `{ source, url, ref, subdir, resolvedCommit, manifestVersion, installedAt }`
  (`subdir` only for monorepo sources, §5.3.4). Keeping
  it out of the tree keeps the tree pristine (exactly what was published),
  removes it from the containment surface, and avoids spec §8.2 questions about
  non-reverse-DOM client directories inside the package.
- `PLUGIN_DATA` lives outside the installed tree and therefore survives updates
  and `remove --keep-data`; it is deleted by `remove` (§5.12.2).
- Only git-sourced plugins live in the store. Local-path plugins are never copied
  (editing source is the point of using a path).

#### 5.3.3 Resolution order at startup (plugin/config hook)

1. Parse the source string (§5.3.1).
2. Local path that exists → use it in place (realpath, then containment as today).
3. Git URL or installed name → look up `installed/<slug>`; if absent, **skip with a
   warning** and continue with other plugins — **never** fetch at startup. (The CLI
   is the only thing that touches network; startup must stay fast and offline.)
4. `fs.realpath()` the plugin root; all containment checks run against the
   realpath-resolved root (handles symlinks deterministically).

Future sources (explicit enum in the parser, not implemented in v1): `file://`
URLs, npm package names.

#### 5.3.4 Monorepo subpath selection

A git source may select a plugin that lives in a subdirectory of its repository,
so a monorepo can publish several plugins without a per-plugin repository:

```text
https://github.com/org/monorepo.git#v1.2.0:packages/linter
https://github.com/org/monorepo.git#:apps/research      # HEAD + subdir
```

- **Syntax** — the fragment is split at the first `:`. Everything before it is
  the ref (may be empty), everything after it is the subdir; a fragment without
  `:` is a bare ref, exactly as today. Git ref names cannot contain `:`, so the
  split is unambiguous. `#:<subdir>` is the unpinned form: the remote's `HEAD`
  at install time, identical to a source with no fragment. An empty fragment
  (`#`) or `#:` is rejected at parse time.
- **Subdir shape** — one or more `/`-separated segments; no empty, `.` or `..`
  segment, no leading or trailing `/`, no `\` and no `:`. The subdir is not
  `~`-expanded and not percent-decoded. A subdir that fails these rules is
  rejected at parse time, before any network call, like a malformed ref.
- **Plugin root** — after the staging clone at the resolved commit, the plugin
  root is `realpath(<staging>/<subdir>)`. It must exist, be a directory, contain
  `plugin.json`, and resolve inside `realpath(<staging>)` (symlinks may point
  within the clone, never out of it — the existing containment rules, §5.5).
  A failure here aborts `install` with nothing written and fails `update`
  staging validation, keeping the previous install and reporting `corrupted`
  (same path as any invalid staged copy, §5.12.3).
- **Store** — the installer exports only the plugin root tree (the subdir, not
  the repository) into `installed/<slug>` and strips `.git` at that root, so the
  invariant *plugin root = `installed/<slug>`* holds for every source kind.
  Sibling files above the subdir are not reachable by the plugin anyway: the
  containment rules already deny `../` paths. `meta/<slug>.json` gains an
  optional `subdir` field with the canonical subdir; `check`, `update`, `list`,
  and installed-name resolution read it. Startup needs no subdir logic: by then
  the plugin root is the exported tree.
- **Slug** — without a subdir, `slugOf(url)` as today. With a subdir,
  `<slugOf(url)>-<flattened subdir>-<hash8>`: subdir segments are lowercased,
  non-`[a-z0-9-]` characters become `-`, joined with `-`, and `hash8` is the
  first 8 hex characters of the SHA-256 of the lowercased canonical subdir.
  The hash is always present, so the mapping is injective even when two
  distinct subdirs flatten alike (`packages/a/b`, `packages/a-b`, and
  `packages/a_b` all flatten to `packages-a-b`). The whole slug is truncated
  to 64 characters, preserving the `-<hash8>` suffix. Two subdirs of one
  repository therefore get distinct slugs, roots, and `PLUGIN_DATA` dirs, and
  install side by side — except subdirs that differ only by case, which
  deliberately share a slug (§10).
- **`--ref`** — overrides only the ref in the source; a `:subdir` already
  present is preserved. The flag cannot add or remove a subdir.
- **Failure classification** — parse-time subdir errors and post-clone subdir
  resolution failures are `install-fail` (§6).
- **Tests** — parse and slug cases in `resolve.test.ts`; staging and containment
  cases (missing subdir, file instead of directory, `..` and symlink escapes)
  against the local bare-repo fixtures; CLI install/update/remove and config
  round-trip; two subdirs of one repository side by side (§9.2).

### 5.4 Manifest validation

- **Schemas vendored, never fetched** (§5.2: "Clients MUST NOT retrieve a schema
  while loading a plugin"). The two JSON schemas are committed under
  the schemas directory, copied into `build/` by the build, and loaded at
  runtime via `createRequire` (never fetched); the dev-only schema-sync script
  verifies their hashes against `agent-plugins.org/schemas/1.0.0/...` in CI
  (dev-time only; runtime is offline).
- Validated with Ajv. The vendored schemas are verified to actually encode
  closedness (`additionalProperties: false` / `unevaluatedProperties: false`) —
  the report-and-ignore reclassification below is meaningless against an open
  schema; the schema-sync script asserts this when re-vendoring.
  Validation order: strip unknown top-level keys first, then validate the
  remainder, so a fatal error in a known field is never masked by the presence
  of unknown ones. Error classification:
    - Unknown top-level fields → Ajv `unevaluatedProperties` errors are re-classified
    as **warn + ignore** (strip the offending keys, re-validate the remainder).
    - Non-object `extensions` → **warn + ignore** (ignore whole field).
    - Missing/empty/invalid-type `$schema`, `name`; name constraint violations (§5.5);
    `author` shape violations; any other schema violation → **fatal** → reject plugin.
- `$schema` recognition: a map of canonical identifiers → supported version rules.
  Unrecognized → reject with "unsupported Agent Plugins version". Storing the map
  keeps 1.1.0 future-proof (§2.3).
- `extensions`: we implement no namespace in v1 → all members ignored without
  validating their contents (§8.1). Recorded for a future
  `com.ameshkov.opencode-agent-plugins` namespace (see §12).

### 5.5 Path containment

Single helper used by manifest, skills, and MCP processing:

```ts
resolvePluginPath(root: string, value: string, kind: "command" | "cwd" | "generic")
  → { ok: true; path: string } | { ok: false; reason: "escapes" | "not-relative" | ... }
```

Rules enforced:

- `command`: single token; either a bare executable name or `./...` (resolved
  against root, must stay inside). No placeholder expansion in command.
- `cwd`: omitted → plugin root. Allowed forms: `./...`, `${PLUGIN_ROOT}` or
  `${PLUGIN_ROOT}/...`, `${PLUGIN_DATA}` or `${PLUGIN_DATA}/...`. Expand first,
  then verify containment against the respective anchor (plugin root / data dir).
- Generic paths (`args`/`env` values that look like paths but are opaque strings):
  no containment enforcement is applied to `args`/`env` **values** (§4.1 item 5);
  only expansion takes place. Post-expansion, if an args/env value points outside
  the plugin root we do **not** reject it — the spec treats them as opaque ("must
  not interpret them as package paths"); rejection happens only for `cwd` and
  `command`.

### 5.6 Skills

- Discovery: immediate children of `<root>/skills/` that are directories containing
  a regular file named exactly `SKILL.md`. No recursion. Missing `skills/` → valid
  absence (no error).
- Containment (§5.5): the `skills/` dir *and* each immediate skill subdirectory
  must resolve (realpath) inside the resolved plugin root. A symlinked entry
  pointing outside the tree is a `path-escape` (`warn`) and disables the whole
  `skills/` registration for that plugin — registration is directory-granular,
  so if any subdirectory escapes, none of the dir may be exposed.
- Per-skill validation against Agent Skills + Opencode's loader requirements:
    - YAML frontmatter parseable; `name` and `description` present and non-empty.
    - `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 chars, and equals the directory
    name.
    - `description` ≤ 1024 chars.
    - Invalid skill → skip it, warn, continue with others (§7.1).
- Registration: push the **absolute plugin `skills/` dir** into `config.skills.paths`
  (absolute paths are used as-is, so no copying and no staleness).
- **Nested `SKILL.md` leak guard.** The spec defines skills as *immediate children
  only* (§7.1: "MUST NOT recursively search deeper"). If Opencode's scan of
  `skills.paths` is recursive (`**`), a stray `SKILL.md` nested inside a skill dir
  (e.g. `skills/foo/references/SKILL.md`) would be exposed even though we never
  validated it as a skill. Mitigation: at discovery time, detect any `SKILL.md`
  deeper than `skills/<name>/SKILL.md` and **warn loudly** (naming the file and
  the consequence); such a file is almost always a plugin authoring mistake. If a
  future Opencode version proves to scan one level deep, the warning becomes a
  no-op note. Copying/symlinking validated skills into a client-managed dir was
  considered and rejected: it adds staleness and sync complexity to close a hole
  that only exists under one of the two observed scan behaviors.
- Collisions: skill names must be unique across all locations (per the skills
  doc). At registration time we scan the already-present `config.skills.paths`
  targets (paths we registered this run, plus any pre-existing entries) and
  compare their skill names against the plugin's. **User config wins**: a
  collision with a *pre-existing* entry warns and we skip ours; a collision
  with a path we registered earlier in this same hook run is a *plugin–plugin*
  collision, errors, and skips the later one. Registration is
  directory-granular, so a colliding name drops the plugin's whole `skills/`
  dir (with a warning naming the skill), mirroring §5.7's `mcp` override
  semantics.

### 5.7 MCP translation

Portable format → Opencode native mapping:

```ts
// stdio → local
config.mcp[name] = {
  type: "local",
  command: [server.command, ...server.args],   // single token + args preserved
  environment: { ...server.env, PLUGIN_ROOT, PLUGIN_DATA },
  ...(server.cwd ? { cwd: expandedCwd } : { cwd: pluginRoot }),
};

// streamable-http → remote
config.mcp[name] = { type: "remote", url: server.url, ...(server.headers && { headers: server.headers }) };

// sse → skipped (unsupported transport, §7.2.2 rule 4), warned
```

Details:

- `env` values expanded; env **keys** never expanded; `PLUGIN_ROOT`/`PLUGIN_DATA`
  values set **after** overlaying configured env (replacing anything nominally
  colliding — though such an entry is invalid per §9.2 anyway).
- `cwd` defaulted to the plugin root (spec requirement; Opencode's own default
  resolves relative to the workspace, so we always pass an explicit absolute path).
- **Remote URL/header validation** (spec §7.2.1, enforced before registration;
  violations make the server entry invalid, not just warned): `url` is absolute
  HTTP(S) with no user info and no fragment; non-loopback hosts require HTTPS
  (HTTP only for `localhost` or loopback IP literals); header names are valid
  HTTP field names and contain no duplicates under case-insensitive comparison
  (not expressible in JSON Schema — custom check). Client-generated headers
  (HTTP/MCP/auth) taking precedence over configured ones, and not forwarding
  configured headers across redirects, are **delegated to Opencode's MCP client**
  and verified in E2E, not reimplemented.
- **Name collision handling — user config wins.** If `config.mcp[name]` already
  exists, the entry's origin decides: an entry we registered earlier in this same
  hook run (tracked in a local set) is a *plugin–plugin* collision → error, skip
  the later one; anything else is *user config* → warn, skip ours, leave theirs
  untouched. With `prefix: true` we register as `<plugin-name>-<name>` instead
  (after sanitization, below) and only collide-skip if *that* name is taken.
  This makes `mcp: { "name": { "enabled": false } }` or a full user-defined entry
  a supported per-server override (timeout, enabled, rename) without any
  extension namespace.
- **Server-name sanitization.** MCP server names become LLM tool-name prefixes
  (`<server>_<tool>`); many providers restrict tool names to `[A-Za-z0-9_-]`.
  Spec plugin names allow dots, so prefixed names are sanitized: `.` → `-`, any
  other disallowed character → `-`; a name that is still invalid after
  sanitization (empty, >64 chars) makes that server entry invalid with an error.
  Unprefixed server names come from `mcp.json` member names and are validated
  against the same charset at entry-validation time.
- Opencode handles per-server runtime failure non-fatally (tools simply don't
  appear); our logs report the registration-time drops (invalid entry, unsupported
  transport).

### 5.8 `PLUGIN_DATA`

- Layout: `<data-home>/opencode/agent-plugins/data/<key>/` (see §5.3.2 for
  `<data-home>` resolution). The key is chosen per source kind:
    - **Git-sourced:** `key = slug` — stable across plugin renames (the slug comes
    from the URL and any subdir selection, not the manifest) and human-matching
    to `installed/<slug>`; distinct subdirs of one repository get distinct keys
    (§5.3.4).
    - **Path-sourced:** `key = <manifest-name>-<hash8>`, where `hash8` is the first
    8 hex chars of the SHA-256 of the realpathed plugin root. The name segment is
    a debugging hint only; identity is the hash. If a path-sourced plugin renames
    itself, the directory name goes stale but the data stays attached — cosmetic,
    and `doctor` reports it.
    - Per **instance** (two different sources → different roots → different data dirs).
    - Update-stable (updates swap the installed tree **in place**, keeping the same
    realpath → same data dir → state preserved, per §9.1 "preserve its contents
    across plugin updates").
    - Removed by `opencode-agent-plugins remove` (§5.12.2); path-sourced plugins have
    no CLI-managed removal.
    - **Orphans:** if the store moves (XDG change, home migration) or a config entry
    is hand-deleted, data dirs become orphaned. Nothing auto-deletes them at
    startup; `opencode-agent-plugins doctor` lists them and `prune` removes them
    (§5.11). Startup stays read-only/fast.
- Created eagerly during registration only when the plugin has at least one valid
  stdio server (spec: "MUST create the directory before launching a plugin
  subprocess").
- `PLUGIN_ROOT` = realpathed plugin root; `PLUGIN_DATA` = the data dir above. Both
  injected into each local server's `environment`.

### 5.9 Versioning / schema selection

- Supported canonical identifiers map (v1): `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` and `.../mcp.schema.json`. Adding 1.1.0 = extend the map (values are the same rule sets, confirmed by diff of the 1.1.0 draft).
- `mcp.json` `$schema` must be recognized **and** match the `plugin.json` version;
  mismatch → MCP disabled for that plugin, skills still load (§7.2.2 rule 2).

### 5.10 Logging and errors

- Every notice goes through `client.app.log({ service: "opencode-agent-plugins", level, message, extra })`; structured `extra` carries plugin name, component type, and spec section reference (e.g. `§5.5`).
- Error taxonomy types mirror the spec's failure boundary ladder, so tests can assert exact classifications (§6).

### 5.11 CLI interface

The same npm package exposes a CLI (`"bin": { "opencode-agent-plugins": "build/cli/index.js" }`)
that manages the plugin store and the user's Opencode config. It runs on Node
(≥26) **outside** Opencode. The `git` binary is required only by git-backed
commands (`install` from a URL, `check`, `update`, and `list`'s status column)
and is checked lazily when such a command runs — `remove`, `doctor`, and
path-sourced `install` work on machines without git, while `list` still
completes and reports every git-sourced plugin as `unreachable` when it
cannot resolve the recorded ref (its status is classified exactly like
`check`). It shares validation and store logic with the
plugin, so install-time validation is byte-identical to what the plugin will do.

| Command | What it does |
| --- | --- |
| `install <source> [--ref <ref>] [--global \| --config <path>] [--yes] [--dry-run] [--no-register]` | Fetches the source (§5.12.1), validates it, previews components, asks for confirmation, registers it in the Opencode config |
| `remove <name>` `[--keep-data] [--yes]` | Unregisters from Opencode config and deletes the store entry **and** its `PLUGIN_DATA` |
| `check [<name>…]` | Read-only update check (network) — resolves the configured ref remotely and compares with the recorded commit; no names = all |
| `update [<name>…] [--yes] [--force]` | Applies available updates (staging → validate → atomic swap, §5.12.3); `--force` follows a moved tag |
| `list` | Shows installed plugins: source kind, URL/ref/subdir, resolved commit, manifest version, status (current / update available / pinned) |
| `doctor` | Read-only health report: config entries with no store entry, store entries referenced by no config, orphaned `PLUGIN_DATA` dirs, stale `.old-*` swap leftovers, stale name segments in data-dir keys |
| `prune [--yes]` | Removes what `doctor` lists as orphaned/stale (never anything referenced by a config entry) |

Behavior notes:

- **Interaction**: prompts on stdin for confirmation; `--yes` for scripts/CI.
  `--dry-run` prints the plan (components that would be registered) without
  touching anything.
- **Config registration** (`install`): edits the `plugin` array of the resolved
  Opencode config — the project `opencode.json` by default, `--global` for
  `~/.config/opencode/opencode.json`, `--config <path>` to pick a file. If both
  `opencode.json` and `opencode.jsonc` exist in the target scope, the `.jsonc`
  file wins and the CLI says so; if neither exists, it creates `opencode.json`.
  The edit is
  **JSONC-preserving** (`jsonc-parser`, same approach as `opencode-sdd`): only the
  `plugin` array changes, comments/formatting elsewhere stay. Written atomically
  (temp file + rename) with a timestamped backup in the store's `backups/` dir —
  **not** `<config>.bak` next to the config, which would invite accidentally
  committing `opencode.json.bak` into the user's repo — and re-parsed before
  writing to guarantee the result is valid: a CLI can never leave Opencode with a
  corrupt config (§5.12.4).
- **Loader-entry bootstrap** (`install`): registering a source is inert
  unless the config already contains the `["opencode-agent-plugins", {…}]`
  loader tuple — without it Opencode never loads the loader, so the
  registered source is never resolved. When the resolved config has no
  loader tuple, `install` therefore probes it first (read-only,
  `probeConfig`), warns the user, and — in interactive mode — asks whether
  to add the entry to the opencode config before registering; declining
  aborts the whole install with nothing written (the staged git tree is
  dropped). Under `--yes` the entry is added automatically with the warning
  only (skipping confirmation prompts). Existing configs that already have
  the tuple are never re-prompted.
- The registered value is the **original source string** exactly as given (git
  URL including any `#ref`/`:subdir` fragment, or the local path) — the startup
  resolver (§5.3.3) maps it back to the store entry. We never register
  store-internal paths.
- **`--no-register`**: installs and prints the config snippet to add manually
  (no loader-entry check — nothing is edited).
- The CLI never touches a running Opencode process.

### 5.12 Install / update / remove lifecycle

#### 5.12.1 Install

1. Resolve the source; for git URLs, check `git` availability (lazily — only
   git-backed commands require it), resolve the ref to a commit via
   `git ls-remote` (dereferencing annotated tags with `^{}`), then clone into a
   temp staging dir (`--depth 1` at the resolved ref where the transport allows;
   a full clone only when a raw commit SHA pin requires it).
2. Determine the plugin root: the staged clone root, or `<staging>/<subdir>` for
   a subpath source, after the subdir containment and `plugin.json` checks
   (§5.3.4). Validate the plugin root with the full pipeline (manifest → skills
   → MCP).
3. Preview: print manifest name/version, the skills and MCP servers that would be
   registered — for stdio servers the command + args, for remote servers the URL
   and configured header names (values redacted) — installing a plugin means
   Opencode will later *run* those commands and *talk to* those endpoints, so
   both are shown before confirmation.
4. On confirm: strip `.git` at the plugin root, export that tree into
   `installed/<slug>` — the whole staged clone for a root source, only the
   selected subdir for a subpath source (§5.3.4) — write `meta/<slug>.json`
   (`url`, `ref`, `subdir`, `resolvedCommit`, `manifestVersion`, `installedAt`),
   register the source in the Opencode config (§5.11). When writing the
   metadata or registering the source fails after the tree moved, the store
   entry is rolled back, so a failed install leaves nothing half-applied.
5. Message: *"installed `<name> <version>`. **Restart Opencode** to use it."*

Failure at any validation step aborts with nothing changed on disk.

#### 5.12.2 Remove

1. Resolve `<name>` to a store entry: exact slug match first, then manifest name;
   if a manifest name matches **multiple** store entries (same name installed from
   two sources), refuse with a list of matching slugs — never guess which instance
   the user means.
2. Print what will be removed (with `--dry-run`), ask for confirmation.
3. Delete the `plugin` config entry (JSONC-preserving, atomic, backup in
   `backups/`) and remove `installed/<slug>`, `meta/<slug>.json`, **and**
   `data/<slug>` unless `--keep-data`. The three deletions are attempted
   independently; when one fails after the config entry is gone, the failure
   names the leftover paths (`install-fail`) instead of aborting with a raw
   filesystem error. A missing or blank config holds no registration, so it
   reports `"<source>" is not registered`, never a JSONC parse error.
4. Message: *"removed `<name>`. **Restart Opencode** to drop its tools and skills."*

Path-sourced plugins have no `remove` (the path is the source of truth); suggest
editing the config instead.

#### 5.12.3 Checking and applying updates

**When updates happen — explicit CLI time only.** The Opencode plugin never fetches
at startup (§5.3.3); updates are applied by `opencode-agent-plugins check` / `update`.

**How:**

- `check` is read-only and network-only: for each git-sourced plugin, resolve the
  recorded `ref` remotely (`git ls-remote <url> <ref>`, with `^{}` deref for
  annotated tags; for `HEAD`-sourced plugins, `ls-remote <url> HEAD`) and compare
  with the recorded `resolvedCommit`. Commit drift is all `check` reports —
  `ls-remote` cannot read the remote manifest, so a remote-vs-installed `version`
  comparison would require a fetch and is deliberately **not** done; the new
  version is shown by `update` after staging. Reports per plugin: `up to date` /
  `update available` / `pinned (immutable)` / `unreachable`.
  **No restart needed — `check` changes nothing.**
- `update` then re-fetches: clone into a temp staging dir at the resolved ref
  (the commit `ls-remote` reported, §5.12.1's clone strategy), re-derive the
  recorded plugin root (the subdir for a subpath source, §5.3.4), strip `.git`,
  run the full validation pipeline on that root — all failure modes are caught
  here, *before* anything live is touched —
  and only then swap it into `installed/<slug>` (rename `installed/<slug>` →
  `.old-<slug>`, rename staged → `installed/<slug>`) and rewrite
  `meta/<slug>.json` with the new `resolvedCommit`/`manifestVersion`. On swap
  failure the rename is reverted (previous tree restored). On success
  `.old-<slug>` is deleted immediately; it exists only as rollback during the
  swap, and `prune` reaps any stray `.old-*` left by a crash (§5.11).
  `PLUGIN_DATA` is untouched. Then print: *"updated `<name>` to `<version>`
  (commit …). **Restart Opencode** to pick it up."*

Ref semantics:

| Ref kind | `check` | `update` |
| --- | --- | --- |
| branch / no `#ref` (HEAD) | compare remote SHA vs recorded | re-resolve, swap on change |
| tag | verify the tag still points at the recorded commit; warn if it moved | no-op (immutable pin); `--force` to follow a moved tag |
| commit SHA | no-op | no-op |

- Path sources are reported as *"local path — update by editing the source"*.
- Failure (unreachable host, auth failure, invalid new manifest, disappeared
  subdir, swap failure) aborts with the previous install untouched and nothing
  half-applied.
- Failure statuses carry the §6 taxonomy classification as structured
  `UpdateStatus.failure` records: `unreachable` is a `check-unreachable` and a
  moved tag an `update-ref` — both `warn` per §6 rows 807-808. Non-failure
  statuses carry none.

#### 5.12.4 How Opencode learns about changes — and can they break it?

**Opencode learns about changes on its next start.** The plugin's `config` hook runs
exactly once per Opencode start and there is no supported live re-registration:
plugin modules are imported at startup, MCP clients connect once, and the skill
list is built at session start — config-file watching in the TUI reloads config
*values*, not plugin modules or their produced registrations. So:

- `install`, `remove`, and `update` **print — they do not prompt or force — a
  "restart Opencode" message**. (The CLI could detect a running server and say so;
  it will not attempt to reload it.)
- `check`, `list`, and `doctor` are read-only and need **no** restart.

**Can these changes break Opencode?** No hard breakage is expected, and the design
bounds the realistic failure modes:

1. **Plugin load failures are non-fatal by construction.** Opencode wraps plugin
   import and every hook in try/catch — a broken plugin is skipped or reported
   ("plugin config hook failed") and Opencode continues (verified empirically,
   §9.1). A plugin with an invalid manifest is rejected by *our* loader before
   anything is registered, and each component failure is isolated per §6.
2. **The one real risk is a bad config edit by the CLI** — e.g. an invalid
   `plugin` entry would make Opencode refuse the config at startup. Mitigation:
   JSONC-preserving edits, validity re-parse before write, atomic write +
   timestamped backup in the store's `backups/` dir, and abort-on-conflict
   (never overwrite a config that changed between read and write).
3. **Misbehaving MCP servers are bounded by Opencode**: a stdio server that hangs
   or fails the handshake is dropped after the tool-fetch timeout (5000 ms
   default) and does not block other components. `remove`/`update` cannot leave a
   half-started server behind because registrations only change at startup.
4. **Supply-chain/trust note**: installing a plugin means Opencode will later
   execute the stdio commands the plugin declares. The install preview (§5.12.1)
   surfaces these before confirmation; users should pin `#ref` (tag/commit) for
   reproducible installs; the resolved commit is recorded so `check` reports drift
   even when refs move.

---

## 6. Failure taxonomy (spec failure boundaries → behavior)

| Condition | Boundary | Behavior | Report |
| --- | --- | --- | --- |
| `plugin.json` missing / unparsable / realpath escapes root | plugin | reject plugin, load nothing | error |
| Unknown `$schema` identifier (unsupported version) | plugin | reject plugin | error |
| Fatal manifest violation (required fields, name, author shape, other schema errors) | plugin | reject plugin | error |
| Unknown top-level manifest fields | plugin | report + ignore fields, continue | warn |
| Non-object `extensions` | plugin | report + ignore field, continue | warn |
| Unimplemented extension namespace | extension | ignore silently | debug |
| Generic package path escapes root | path | deny that path | warn |
| `skills/` missing | skills | valid absence | debug |
| `skills/` wrong kind, or invalid skill | skill | skip that skill, continue | warn |
| `mcp.json` missing | mcp | valid absence | debug |
| `mcp.json` invalid JSON / wrong version / unknown `$schema` / bad top-level shape | mcp | disable MCP only, continue with skills | error |
| Invalid individual server entry (incl. remote URL/header rule violations, §5.7) | server | skip entry, continue | warn |
| Unsupported transport (`sse`) | server | skip entry, continue | warn |
| Server name collides with existing `config.mcp` entry | server | existing entry wins — user config: warn + skip ours; plugin–plugin (same hook run): error + skip the later one | warn / error |
| Skill name collides with an existing `skills.paths` entry | skill | existing entry wins — user config: warn + skip ours; plugin–plugin (same hook run): error + skip the later one | warn / error |
| Nested `SKILL.md` deeper than `skills/<name>/` | skill | not a skill per spec §7.1; not registered by us; warn that Opencode may still expose it (§5.6) | warn |
| Server fails to start/connect/auth (runtime) | server | Opencode drops it; other components unaffected | warn (from Opencode) |
| Git-sourced plugin not installed at startup | source | skip entry, continue — no network fetch | warn |
| Installed store entry corrupted / missing manifest | source | reject plugin, continue with others | error |
| `install`: fetch, clone, validation, subpath resolution, or store write fails; `remove`: store deletion fails | install | abort; install rolls back so nothing is written, remove names the leftover paths | error |
| `check`: remote unreachable / auth failure | check | report status unknown, no changes | warn |
| `update`: moved tag / non-fast-forward ref | update | refuse, keep current tree | warn |
| CLI config edit conflicts or fails re-parse | config | abort, keep timestamped backup in store `backups/`, nothing changed | error |

---

## 7. Conformance checklist mapping

Map to the [client implementers checklist](https://agent-plugins.org/client-implementers/conformance):

| Checklist item | Design | Test |
| --- | --- | --- |
| Load a plugin from a directory & enforce filesystem-resolved package boundary | §5.3, §5.5 | source-resolution + containment unit tests |
| Select locally supported manifest rules from `$schema`; no schema retrieval during load | §5.4 | fixture with unreachable-network assertion (validators never fetch) |
| Validate closed `plugin.json` schema + required `$schema`/`name` | §5.4 | Ajv-based tests, spec examples |
| Report and ignore unknown top-level fields | §5.4 | fixture from §5.2 spec example |
| Ignore non-object `extensions` and unimplemented namespaces | §5.4 | fixtures |
| Reject other fatal manifest violations before discovery | §5.4 | fixtures |
| Discover component types only from fixed locations | §5.6, §5.7 | layout fixtures |
| Treat missing component locations as valid absence | §5.6, §5.7 | fixtures |
| Isolate invalid components at specified boundaries | §6 | taxonomy tests |
| Ignore unsupported component types; support ≥ 1 of skills/MCP | §5.6, §5.7 | — |
| MCP: ≥ 1 of stdio / streamable-http (both recommended) | §5.7 (both implemented) | — |
| Use each entry's declared transport for initial attempt | §5.7 | mapping tests |
| Validate closed top-level `mcp.json` + each entry independently | §5.7, §6 | `#/$defs/server` per-entry Ajv |
| Resolve stdio commands as single executable tokens | §5.5, §5.7 | unit tests |
| Provide `PLUGIN_ROOT` + dedicated persistent `PLUGIN_DATA` | §5.8 | unit tests |
| Expand only the two placeholders, only in `args`/`env` values/`cwd` | §5.5 | expansion tests |
| Enforce cwd containment + remote URL/header requirements | §5.5, §5.7 | unit tests |
| Continue loading after an independent MCP server fails | §6, §5.7 | unit tests |
| Require matching versions in `plugin.json`/`mcp.json` | §5.9 | fixtures |
| Never reassign published canonical schema ids | §5.4 (vendored, hash-checked) | CI script |
| Allow older versions per local compatibility policy | §5.9 | — |

**Delegated-to-host requirements.** Three spec duties are implemented by Opencode's
MCP client rather than by us, and are asserted in E2E rather than unit tests:
the *base subprocess environment* selection (spec §9.1 lets the client choose;
Opencode chooses, we only overlay `environment`), *bare-command `PATH` search*
(spec §7.2.1 leaves it client-defined; Opencode's spawn behavior applies), and
*client-generated header precedence / redirect header forwarding* (spec §7.2.1;
Opencode's HTTP stack owns both). Where a future Opencode change breaks one of
these, the E2E test (§9.2) is the tripwire.

---

## 8. Tech choices

| Decision | Choice | Rationale |
| --- | --- | --- |
| Language/build | TypeScript, ESM, `tsc` → `build/` (mirrors `opencode-sdd` layout, `@opencode-ai/plugin` d.ts import) | Plugins are consumed by Bun; no bundler needed (§4.2) |
| Entrypoints | Two per package: opencode plugin (`main`/`exports["."]`) + CLI (`bin`); both thin wrappers over the shared core | §4.2 |
| Packaging | Single npm package, **not** a multi-package workspace | Plugin + CLI must version/publish together; lib boundary enforced by module graph (§4.2) |
| Validation | Ajv with the two vendored JSON schemas | Exact spec fidelity; per-entry validation via `#/$defs/server`; no network |
| Options parsing | Zod | Small, typed; mirrors `@opencode-ai/plugin` `tool.schema` style |
| Filesystem | `node:fs/promises` + `fs.realpath` | Deterministic containment |
| Testing | Vitest unit + integration | Matches sdd test setup |
| Package | `opencode-agent-plugins`, `main: build/index.js`, `files: ["build"]`, default ESM export | Standard opencode npm plugin |

---

## 9. Testing strategy

### 9.1 Empirical verification (proven, 2026-09-09, opencode 1.18.30)

The E2E suite (§9.2.4) was re-run against opencode 1.18.30 in full
(5 scenarios, 21 assertions) and passes; the findings below were first
established on opencode 1.18.25 and remain current.

The core mechanism was **empirically proven** end-to-end: a plugin loaded as
`["/path/to/loader.mjs", { plugins: "<dir>" }]` was run against a real Opencode
inside a throwaway Docker image, with a fake OpenAI-compatible server capturing
the exact request Opencode sends to the model. The proof compared:

- **Hook mode** — components registered by the loader's `config` hook
  (mutating `config.mcp` and `config.skills.paths`), and
- **Static mode** — the identical values written directly in `opencode.json`
  (baseline).

What was proven:

- The `config` hook runs, receives the options (`{ plugins: "<dir>" }`), and its
  mutations are **honored**: the plugin's stdio MCP server is spawned, and its
  tool (`echo_ping`) plus the plugin's skill (`hello`) appear in the captured
  model request — including `<available_skills>` in the system prompt.
- `PLUGIN_ROOT`/`PLUGIN_DATA` are injected: the MCP tool description reported the
  real plugin root and the loader-created per-instance data dir (the PoC used a
  prototype layout `~/.local/share/opencode/agent-plugins/<name>-<hash8>/data`;
  the final layout is §5.8), and the spawned
  server ran with `cwd` = plugin root (spec default honored).
- Hook mode is behaviorally identical to static mode — the config hook is the
  right mechanism and equivalent to native config.

Findings that adjust the design:

1. **Config plugin spec form.** On 1.18.25 the tuple form `["pkg" | "/path.mjs", { options }]`
   works; the V2 object form `{ "package": ..., "options": {...} }` is **rejected**
   by the V1 runtime (`Expected string | array`). Keep the tuple form as documented
   in §3.1. (The public `opencode.ai/config.json` schema matches the tuple form.)
2. **Silent import failures.** A module-level error in the plugin file (e.g. a bad
   import) causes the plugin to be skipped with no visible error in `opencode run`.
   The production loader must import with zero side effects and register/log loudly.
3. **`client.app.log` shape.** Calls must use `client.app.log({ body: {...} })`; the
   schema-less form throws inside the hook.
4. **Skills are advertised in the system prompt.** In this version the
   `<available_skills>` block lives in the model-visible system prompt (not in the
   `skill` tool description); the `skill` tool description only says "skills listed
   in your system prompt". **This contradicts the current skills doc** ("OpenCode
   lists available skills in the `skill` tool description"), so the surface is
   version-dependent: conformance checks must accept the block in *either* the
   system prompt or the tool description, never assert on exactly one.
5. **Placeholder expansion is the client's job.** Opencode passes configured `env`
   values verbatim (a `${PLUGIN_DATA}/echo` value stayed literally `${PLUGIN_DATA}/echo`
   in the spawned server's env), confirming the loader must expand placeholders
   before registration, per §5.5.

### 9.2 Unit tests

1. **Unit tests** per module with spec-derived fixtures:
   - Valid/invalid manifest set from spec §5.2/§5.3/§5.5 examples (both example
     `plugin.json`s, all invalid names).
   - `mcp.json` examples from §7.2.1 (valid + invalid forms, both stdio and remote),
     version mismatch, unknown `$schema`, invalid server entries.
   - Remote URL/header rules (§5.7): userinfo, fragment, non-loopback HTTP,
     case-insensitive duplicate header names → invalid entry.
   - Name collisions and sanitization (§5.7): user entry wins, plugin–plugin
     collision skips the later one, dotted plugin names sanitize to `-`. Skill
     name collisions (§5.6) behave the same way at directory granularity.
   - Nested `SKILL.md` below `skills/<name>/` → discovery warning, not registered.
   - Placeholder expansion: `./`, `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`, escape attempts
     (`../` both pre- and post-expansion), literal unknown placeholders, expansion
     in the wrong fields (command/url must not expand).
   - Source grammar: `#ref`, `#ref:subdir`, `#:subdir`, malformed refs and
     subdirs, subdir slug derivation and truncation (§5.3.4).
   - Failure taxonomy: one test per §6 row asserting the classification and that
     remaining components load.
2. **Integration tests**: run the loader against a minimal fake `Config` object;
   assert `config.mcp`/`config.skills.paths` mutations and `PLUGIN_DATA` creation.
3. **CLI tests**: install/update/remove flows against local git fixtures (a bare
   repo exercised via a `file://` path or a local `git://`/ssh test remote):
   - install validates before registering, preview lists components, `--dry-run`
     writes nothing;
   - update detects drift, swaps atomically, preserves `PLUGIN_DATA`, refuses a
     moved tag;
   - remove deletes the store entry + data dir and edits the config JSONC without
      touching comments;
   - config edits round-trip through the parser and a timestamped backup in
     `backups/` is left on failure;
   - subpath sources: install/update/remove a plugin from a monorepo fixture,
     two subdirs side by side, subdir escapes (`..`, absolute, symlink) rejected
     before anything is written, `--ref` overriding only the ref.
4. **E2E (CI-gating per Opencode release)**: the scenario described in §9.1 — run
   Opencode against a fixture plugin in a clean environment and assert the
   captured model request. This is the only test layer that catches silent
   regressions in the integration itself (import-safety finding §9.1.2, scan
   depth, `<available_skills>` surface, host-delegated conformance items §7), so
   it is a release gate, not an optional extra.
5. **Schema provenance test**: dev script asserts the vendored schemas match
   `agent-plugins.org/schemas/1.0.0/*` byte-for-byte (CI only).

---

## 10. Edge cases & decisions

- **Same plugin source configured twice** → dedupe by resolved root (realpath) for
  paths, by slug for git URLs.
- **Plugin source missing at startup** → reject that entry with an error (path) or
  warn + skip (git URL not installed yet, §5.3.3); other entries still load.
- **`skills/` with nested skill dirs** → only immediate children are considered
  skills (spec §7.1). A `SKILL.md` nested deeper than `skills/<name>/` is *not* a
  skill but may still be exposed by Opencode if its scan is recursive — we detect
  and warn at registration (§5.6); we add only `skills/`, never the plugin root,
  so nothing else outside the spec layout can leak in.
- **`cwd` with `~` or absolute paths** → not allowed by the spec; treat as invalid
  server entry (§7.2.1 form requirements).
- **Windows** → containment must use case-insensitive path comparisons on Windows;
  `command` single-token preservation and args-passing already match Opencode's
  `command: string[]` contract.
- **Anonymous credentials in headers** → we pass them through (visible package
  data); spec forbids secrets, but client-side we do not inject anything.
- **MCP server `enabled` / `timeout`** → not in the portable format; all translated
  servers default to `enabled: true` with Opencode's default timeout. Users tune
  these via the user-config-wins override (§5.7): define `mcp.<name>` themselves
  (an `{ "enabled": false }` stub or a full entry) and the plugin defers; or gate
  tools via the `tools` config as usual.
- **SSH auth for git sources** → the CLI uses the ambient SSH agent/keys (its own
  config); it never embeds or stores credentials, and private repos require the
  user's normal SSH setup.
- **URL vs. slug duplicates** → the same git URL referenced by URL and by slug in
  two config entries resolves to one store entry. Conflicting refs: the **first
  source in config order wins** (deterministic), later conflicting entries are
  skipped with a warning naming the winner.
- **`~` expansion** → only `~/...` expands (to `HOME`); `~user/...` is not
  expanded and is rejected as a source with a clear error, rather than being
  mis-resolved as a literal relative path.
- **scp-like vs. Windows paths** → the scp-like git form requires `user@host:path`
  (an `@` before the colon), so `C:\...` can never be misdetected as a git URL.
- **Malformed git refs and subdirs** (`#ref` with whitespace, empty ref and
  subdir, `..`/absolute/symlink-escaping subdir) → rejected at parse time or
  after the clone, before anything is written.
- **Monorepo subdirs** → each selected subdir is its own store entry with a
  distinct slug and `PLUGIN_DATA`, so two subdirs of one repository install side
  by side (§5.3.4). Subdirs that differ only by case sanitize to the same slug;
  the second install then reports "already installed".
- **Subdir disappears on update** → the staged copy fails validation and the
  previous install is kept (§5.3.4, §5.12.3).
- **`install` on an already-installed slug** → reports "already installed at
  commit …", hints at `update` instead of silently overwriting.

---

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| `config.skills` type lag in `@opencode-ai/plugin` d.ts | Defensive normalization; runtime schema is authoritative; integration test asserts actual behavior |
| Opencode changes to `skills.paths`/`mcp` semantics | E2E smoke test pins behavior on each release |
| Plugin module import failures are silent | Import-safe bundle; failures logged loudly from inside hooks |
| Opencode loads duplicate npm plugin entries only once | Single-entry + `plugins: string[]` is the only documented multi-source form (§3.1); re-verify dedup behavior per release |
| Config hook clobbers user-authored `mcp`/`skills` entries (hook runs after config resolution) | User-config-wins precedence (§3.2, §5.7); plugin registrations never overwrite pre-existing entries |
| Store/config drift (hand-deleted config entries, moved store, crashed swaps) leaves orphans | Nothing auto-deleted at startup; `doctor` reports, `prune` cleans (§5.11) |
| Skills scan depth / `<available_skills>` surface differ between docs and observed behavior | Design robust to both (§5.6 nested-SKILL.md guard); E2E pins actual behavior per release (§9.2) |
| `plugin` config spec form changes (V2 `{package, options}` future) | Document tuple form; re-verify at each release (§9.1) |
| Path containment bypass via symlinked plugin roots | Always `realpath` before validating; containment checks run on resolved paths |
| MCP tool-name collisions across plugins | Warn + `prefix` option |
| Skill name collisions | Warn; Opencode dedupes by name (loader semantics unchanged) |
| Spec evolution (1.1.0 draft) | Canonical-identifier map (§5.9); content diff is currently a no-op |
| Corruption of the Opencode config by the CLI | JSONC-preserving edit, re-parse before write, atomic write + backup in `backups/`, abort on conflict (§5.12.4) |
| Supply chain: a git plugin is code that Opencode will run | Install preview lists declared stdio commands; confirm before install; record resolved commit; encourage `#ref` pins (§5.12.1) |
| Network availability for git sources | Network is only used by CLI commands (`install`/`check`/`update`), never at Opencode startup; failures are per-plugin and non-fatal |
| Git ref drift (branch moved) | `check` reports remote-vs-recorded drift; updates are staged, validated, and atomically swapped (§5.12.3) |
| Half-applied update leaves a broken install | Staging + validate + atomic swap with `.old-*` restore (§5.12.3) |

---

## 12. Future work

- npm registry / `file://` sources.
- Extract the shared core into a standalone core package (and reconsider a
  multi-package workspace, §4.2) if the client core gains consumers beyond this
  repo.
- Hot reload: have the CLI (or a `--reload` flag) ask a running Opencode to
  re-register plugins without a restart — requires Opencode-side plugin reload
  support; until then restart is required (§5.12.4).
- Signed/verified installs (e.g. recording pinned commit hashes in the config so
  `install` can be reproduced exactly; content-addressed plugin archives).
- Fetch-in-place updates (keep `.git` in the store, `git fetch` + reset) instead of
  re-clone + export — trades the pristine-tree property of §5.3.2 for speed.
- `extensions["com.ameshkov.opencode-agent-plugins"]` namespace so plugin authors
  can carry Opencode-specific settings (e.g. per-server `enabled`, `timeout`,
  `prefix`, name overrides, per-agent tool gating) inside a portable plugin.
  (User-side overrides are already covered by the user-config-wins rule, §5.7 —
  this namespace is for *author-shipped* Opencode tuning.)
- File-based client extensions (top-level namespace directories).
- Watch mode for path-sourced plugins (re-register on change).
- Per-instance overrides (`enabled: false`) so users can disable a component
  without editing the plugin package.
- Repository component types when the portable spec adds them.

---

## 13. References

- Agent Plugins specification 1.0.0: <https://agent-plugins.org/specification>
- Client conformance checklist: <https://agent-plugins.org/client-implementers/conformance>
- Spec repo (canonical schemas, 1.1.0 draft): <https://github.com/agentplugins/agent-plugins-spec>
- Agent Skills spec: <https://agentskills.io/specification>
- Opencode plugins doc: <https://opencode.ai/docs/plugins/>
- Opencode MCP servers doc: <https://opencode.ai/docs/mcp-servers/>
- Opencode skills doc: <https://opencode.ai/docs/skills/>
- Opencode config schema: <https://opencode.ai/config.json>
