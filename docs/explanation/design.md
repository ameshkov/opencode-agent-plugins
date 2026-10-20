# Design: `opencode-agent-plugins`

**Status:** Draft
**Date:** 2026-09-01
**Repo:** `opencode-agent-plugins`
**Target spec:** [Agent Plugins Specification v1.0.0](https://agent-plugins.org/specification) (published), conformance per the [client implementers checklist](https://agent-plugins.org/client-implementers/conformance).

---

## 1. Goal

Build an Opencode V2 plugin, configured as

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "opencode-agent-plugins", "options": { "plugins": "<path-to-plugin>" } }
  ]
}
```

that acts as a **conformant Agent Plugins client** for Opencode: it loads a plugin
package (a directory containing `plugin.json`, optionally `skills/` and `mcp.json`),
validates it against the Agent Plugins specification, and registers its components
into Opencode:

- **Skills** → registered as individual V2 skill definitions through
  `ctx.skill.transform` (id, name, description, absolute `SKILL.md` path,
  content), so plugin skills appear in the available-skills surface with no
  file copies.
- **MCP servers** → translated from the portable `mcp.json` format into native
  V2 `Mcp.ServerConfig` entries through `ctx.mcp.transform` (a `stdio` server
  becomes `type: "local"`, a remote server becomes `type: "remote"`).
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
- No live reload orchestration by the CLI: V2 watches config directories and
  reloads the loader plugin on its own, so a registered source is picked up
  without a restart (§9.1.6); the CLI only prints a restart hint as the
  deterministic path and never talks to a running Opencode process.

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

### 2.2 Opencode integration points (verified against opencode 2.0.16)

| Need | Opencode V2 facility |
| --- | --- |
| Receive config + options | `plugins: [{ package: "opencode-agent-plugins", options: { ... } }]`; the plugin's default definition is `{ id, setup(ctx) }` and the options arrive as `ctx.options` (`PluginOptions = Record<string, any>`). |
| Register components | `setup` registers through context **transforms** (`ctx.skill.transform`, `ctx.mcp.transform`); V2 has no mutable global config object. Transforms are replayable: the callback may run after `transform()` resolves, during a batched registry rebuild (§9.1.3). |
| Register MCP servers | `editor.set(name, config)` with `{ type: "local", command: string[], cwd?, environment?, disabled? }` or `{ type: "remote", url, headers? }`; `timeout` is `{ startup, catalog, execution }`, `enabled` no longer exists (servers are enabled unless `disabled: true`). Code Mode wraps MCP tools by default (`codemode: true`); the client leaves that host default untouched so plugin servers behave exactly like natively-configured ones (§9.1.4). |
| Register skills | per-skill `editor.add({ id, name, description?, path, content })` — no directory registration. The V2 `skills` config array (paths/URLs) remains the *user-config* surface; plugin registrations are individual definitions. Config-discovered skills are not visible to transforms, so the host enforces config precedence on skill-name collisions (§9.1.5). |
| Logging | V2's plugin context has no logging API; the client writes `[opencode-agent-plugins]`-prefixed lines to the console, which `opencode serve --print-logs` captures (verified in E2E). |
| Workspace context | `ctx.location.directory` (workspace dir, used to resolve relative plugin paths) and `ctx.location.project` (`id`, `directory`, `canonical`). |

V2 requires HTTP Basic auth on the server API (username `opencode`, password from
`OPENCODE_SERVER_PASSWORD`); the E2E suite drives the API through
`@opencode/client` with those credentials.

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
  "plugins": [
    {
      "package": "opencode-agent-plugins",
      "options": {
        "plugins": [
          "./agent-plugins/my-plugin",
          "git+https://github.com/org/my-plugin.git#v1.2.0"
        ]
      }
    }
  ]
}
```

> **Why a single entry with an array, and never two `opencode-agent-plugins`
> entries:** Opencode deduplicates plugin entries by package identity, so a
> second entry would be silently ignored — and with two instances there would
> be no defined precedence between their registrations. One setup instance owns
> all plugin registrations for the location, which makes collision handling and
> dedup deterministic (§5.7). This must be re-verified empirically per Opencode
> release (§9.1, §11). A bare package string (`"plugins":
> ["opencode-agent-plugins"]`) is a valid V2 entry too; the CLI recognises it
> and replaces it with the object form on the first write. A legacy V1
> `["opencode-agent-plugins", {…}]` tuple is read and migrated to this object
> form by the next install write (§5.11).

All options in one entry:

```jsonc
{
  "package": "opencode-agent-plugins",
  "options": {
    "plugins": ["./agent-plugins/my-plugin", "git@github.com:org/third.git"],  // string or string[]
    "prefix": false,        // true: MCP server names become "<plugin-name>-<server>" (sanitized, §5.7)
    "logLevel": "info"      // debug | info | warn | error (default: info)
  }
}
```

Options schema (parsed with Zod, unknown keys warn):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `plugins` | `string \| string[]` | — | Plugin source(s): local path, git URL, or an installed plugin name. Required. |
| `prefix` | `boolean` | `false` | Namespace MCP server names to avoid cross-plugin collisions. Applies to all sources in this entry. |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Minimum level written to the plugin's console logger. |

### 3.2 Startup behavior

On every Opencode start (when the location loads) the plugin:

1. Resolves each configured source (§5.3): local paths are used directly (realpath,
   `~`-expanded, or relative to the workspace directory); git URLs and installed
   plugin names are resolved against the client store — **no network access at
   startup** (installing/updating is the CLI's job, §5.12).
2. Validates `plugin.json` (fatal/reject vs. report-and-ignore, per §5).
3. Discovers skills and MCP servers from fixed locations.
4. Registers them through the V2 context transforms (`ctx.skill.transform`,
   `ctx.mcp.transform`), following the **precedence principle: user-authored
   config always wins**. MCP: the transform editor exposes config-defined
   servers, so a colliding name is skipped and reported (user config wins); a
   collision with a server registered earlier in the same setup run is a
   plugin–plugin error. Skills: the host's skill registry keeps a config skill
   over a plugin registration of the same name, and config-discovered skills
   are not visible to transforms, so the client registers its skills
   individually and the host enforces precedence on a name collision
   (§9.1.5). This also gives users an escape hatch the portable format lacks
   (per-server `timeout`, `disabled`, `codemode`, name overrides): define the
   entry yourself under the same name and the plugin defers (§5.7). For
   editor-visible skills collisions, registration stays directory-granular:
   one colliding name means the plugin's whole `skills/` dir is skipped by the
   client (error for our own earlier source, warning for another plugin's
   registration, §5.6).
5. Logs a structured summary of *attempted* registrations: N skills, M servers
   (M-local/remote; transport-skipped entries are warned separately),
   per-plugin status. Collision-skipped components are reported separately and
   are not subtracted from the counters. No startup crashes ever — every
   failure goes through the failure taxonomy (§6).

V2 watches config directories and reloads the loader plugin automatically: a
source installed by the CLI while Opencode is running is picked up by the next
location load without a restart (§9.1.6).

### 3.3 What the user sees

- Skills: appear in the `<available_skills>` block automatically (surface —
  system prompt vs. `skill` tool description — is version-dependent, §9.1).
- MCP tools: available through Code Mode by default (`tools.<server>.<tool>`
  inside `execute`), exactly like natively-configured servers; a user who needs
  the provider's native tool list can pre-define the server with
  `codemode: false` (user config wins) or gate `<server>_*` through permissions.
- Diagnostics: `[opencode-agent-plugins]`-prefixed console lines, captured by
  `opencode serve --print-logs`; `opencode debug config` shows the config state
  (transform registrations live in the registry, not in the config). The
  `opencode mcp list` command lists *configured* servers only — plugin
  registrations are registry entries, visible through the server API
  (`mcp.list`), not through that command.

---

## 4. Architecture

```text
opencode (V2 plugin setup)                CLI (opencode-agent-plugins bin)
   │  ctx (location, options, domains)       │  install | remove | check | update | list
   ▼                                          ▼
┌──────────────────────────────────────────────────────────────────┐
│          shared core: one module per spec concern                │
│  source resolution   install/update lifecycle   client store     │
│  manifest validation skills discovery           mcp translation  │
│  containment + placeholder expansion            PLUGIN_DATA      │
│  failure taxonomy (types shared by both)                         │
└───────────────────┬────────────────────────────┬─────────────────┘
                    ▼                            ▼
        plugin entry (plain { id, setup })   CLI entry (bin)
        wraps core with ctx domains       wraps core with stdio prompts
        ──────────────┴──────────────────────────┴──────────────
                    ▼
        ctx.skill.transform → editor.add({ id, name, path, content })
        ctx.mcp.transform   → editor.set(name, { type: "local"|"remote", ... })
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
│   ├── plugin entry             # plain { id, setup } definition
│   ├── CLI                      # the opencode-agent-plugins binary
│   ├── lib/                     # shared core: one module per spec concern
│   └── schemas/                 # vendored Agent Plugins schemas (committed)
├── scripts/                     # build/dev gates (schema sync, import checks)
├── test/                        # unit/integration test support (helpers, stub context)
└── test-e2e/                    # Docker E2E suite against a real opencode
```

The exact file split is left to the implementation — what is pinned here is
that the shared core is a single module layer below both entrypoints with one
module per spec concern (§4, §6), and that the vendored schemas are committed
artifacts, never fetched at runtime (§5.4).

### 4.2 Technical design: language, entrypoints, packaging

**Language and build.** The tool is written in **TypeScript** (ESM, compiled with
`tsc` to `build/`; no bundler — mirrors the `opencode-sdd`
layout). Target runtimes: **Bun** for the plugin entrypoint (the pinned
opencode 2.0.16 npm distribution is a Bun-compiled binary; V2's host process
imports the plugin directly) and **Node ≥ 26** for the CLI; shared-core code
sticks to the portable intersection (`node:*` builtins only — no runtime-specific
APIs — so both runtimes run the same compiled output).

**Two entrypoints, one package.** The npm package exposes exactly two
entrypoints, both thin wrappers over the shared core:

| # | Entrypoint | Output | Contract | Runtime |
| --- | --- | --- | --- | --- |
| 1 | Opencode plugin | `build/index.js` | Default-exports a V2 plugin definition `{ id, setup }`; only the `skill`/`mcp` transforms are used (§5.1). Zero top-level side effects (§5.1 import-safety note). | Bun (inside Opencode's host process) |
| 2 | CLI | `build/cli/index.js` | Exposed as the `opencode-agent-plugins` bin with a `#!/usr/bin/env node` shebang; command surface in §5.11. | Node ≥ 26 |

```jsonc
// package.json (excerpt)
{
  "name": "opencode-agent-plugins",
  "type": "module",
  "main": "build/index.js",                // entrypoint 1: opencode plugin
  "exports": { ".": { "import": "./build/index.js" } },
  "bin": { "opencode-agent-plugins": "build/cli/index.js" },  // entrypoint 2
  "files": ["build"]
}
```

Dependency boundaries:

- The shared core imports only `node:*`, Ajv, Zod, and `jsonc-parser` —
  **never** `@opencode/*`, so the CLI installs and runs with no Opencode
  dependency.
- The plugin entry uses `@opencode/plugin` as a **type-only** import
  (`import type { Context } from "@opencode/plugin/promise/plugin"`), so it
  stays a devDependency and nothing Opencode-specific ends up in the CLI's
  module graph.
- The default export is a plain definition object rather than
  `Plugin.define(...)`: the V2 host accepts any default definition with an `id`
  and a `setup`, `Plugin.define` is an identity function, and avoiding the
  value import keeps the compiled bundle free of runtime `@opencode/*`
  dependencies (pinned by `scripts/check-runtime-imports.ts` in `pnpm build`).

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
import type { Context } from "@opencode/plugin/promise/plugin";

const agentPlugins = {
  id: "opencode-agent-plugins",
  async setup(context: Context): Promise<void> {
    const parsed = parseOptions(context.options ?? {});
    const logger = createLogger(parsed?.options.logLevel ?? "info");
    await registerAgentPlugins(context, parsed, logger);
  },
};

export default agentPlugins;
```

`setup` is the only entry point we need: registration goes through
`ctx.skill.transform` and `ctx.mcp.transform` (§5.6, §5.7). All per-plugin
failures are caught, mapped through the taxonomy (§6) and logged; `setup` never
throws (a throwing plugin would be reported by Opencode, but we prefer explicit
per-plugin reporting).

Import-safety note: a module-level error in the plugin file makes Opencode skip the
plugin — V2 logs `failed to load plugin` (verified on 2.0.16), but the bundle must
still have no top-level side effects that can throw; all work happens inside
`setup`.

Type note: the type-only `Context` import makes `pnpm typecheck` fail if the V2
context ever stops satisfying the pipeline's structural expectations
(`RegistrationContext` in `src/register-types.ts`).

Transform-timing note: V2 may replay a transform callback *after* `transform()`
resolves (batched registry rebuild), so registration code must not depend on
callback side effects for its return values. Collision checks and reports run
inside the callback (§9.1.3).

### 5.2 Options

Zod-parsed, strict on known keys, warn on unknowns. See §3.1.

### 5.3 Plugin sources & resolution

#### 5.3.1 Source grammar

```text
<source>   := <local-path> | <git-url>["#"<fragment>]
<git-url>  := https://... | git+https://... | ssh://... | git+ssh://... | git@host:path (scp-like) | file://...
<fragment> := <ref> | [<ref>]":"<subdir>
<ref>      := <branch> | <tag> | <commit-sha>   (Git ref names cannot contain ":")
<subdir>   := <segment>("/"<segment>)*          (no empty, "." or ".." segment)
```

- **Local path** — absolute, `~/...` (expand `HOME`), or relative (resolved against
  `ctx.location.directory` — the workspace dir — since that is the cwd the user
  configures from). Used **in place**: edits to a path-sourced plugin are picked up
  on the next location load (§5.12.4; a restart remains the deterministic path);
  this is the developer workflow. A local path always points at the
  plugin root itself; it carries no fragment.
- **Git URL** — https, ssh, or a local `file://` remote (used for test
  fixtures), with an optional `#fragment`: a ref pin
  (`#v1.2.0`, `#main`, `#<sha>`), a subpath selection
  (`#v1.2.0:packages/plugin`, `#:packages/plugin`), or both (§5.3.4). Recognized
  by scheme prefixes or the scp-like `user@host:path` form; a leading `git+` is
  normalized away. Without a ref, the remote's `HEAD` is used (recorded at
  install time).
- **Installed name** — an already-installed plugin can be referenced by its
  manifest name or store slug; resolves to the copy in the client store (below).

#### 5.3.2 Client store (managed plugin copies)

```text
<config-dir>/opencode-agent-plugins/
├── installed/<slug>/          # exported plugin root (repo root or subdir, no .git)
├── meta/<slug>.json           # client metadata (git URL, ref, resolved commit, ...)
├── data/<key>/                # PLUGIN_DATA (see §5.8)
└── backups/                   # config-edit .bak files, kept out of the user's repo by default
```

`<config-dir>` follows OpenCode's own config-dir convention:
`$OPENCODE_CONFIG_DIR` when set, else `$XDG_CONFIG_HOME/opencode`, else
`~/.config/opencode` (the same path on every platform, like OpenCode).
When `$OPENCODE_CONFIG_DIR` points inside a repository, the whole store
(including `backups/`) is written there; use a dedicated config directory.

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

#### 5.3.3 Resolution order at startup (plugin setup)

1. Parse the source string (§5.3.1).
2. Local path that exists → use it in place (realpath, then containment as today).
3. Git URL or installed name → look up `installed/<slug>`; if absent, **skip with a
   warning** and continue with other plugins — **never** fetch at startup. (The CLI
   is the only thing that touches network; startup must stay fast and offline.)
4. `fs.realpath()` the plugin root; all containment checks run against the
   realpath-resolved root (handles symlinks deterministically).

Future sources (explicit enum in the parser, not implemented in v1): npm
package names.

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
  runtime via `createRequire` (never fetched); the dev-only schema-sync
  script (`node scripts/update-schemas.ts`, run manually) re-downloads them
  from `agent-plugins.org/schemas/1.0.0/...` and asserts the closedness
  below (runtime stays offline).
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
- Registration: register each validated skill individually through
  `ctx.skill.transform` with `{ id, name, description, path: <skill>/SKILL.md,
  content }` — no directory registration and no copying. `path` points at the
  real on-disk `SKILL.md`, so relative resources beside it stay reachable for
  the host.
- **Nested `SKILL.md` files.** The spec defines skills as *immediate children
  only* (§7.1: "MUST NOT recursively search deeper"). V2 registers plugin
  skills individually, so a stray `SKILL.md` nested inside a skill dir (e.g.
  `skills/foo/references/SKILL.md`) is never registered; we still warn (naming
  the file) because it is almost always an authoring mistake. A user-authored
  `skills` *directory* is a different surface: V2 scans it recursively and
  would expose the nested file — pinned per release in E2E (§9.1.5).
- Collisions: skill names must be unique at the location. Plugin–plugin
  collisions (our own sources in one setup run) are detected from the transform
  editor and reported as errors, skipping the later plugin's whole `skills/`
  dir. A collision with a registration from another opencode plugin (visible
  in the editor, not ours) is reported as a warning and likewise skips the
  dir; the design does not arbitrate cross-plugin precedence. Config skill
  precedence is enforced by the host: V2's skill registry keeps a config skill
  over a plugin registration of the same name, and config-discovered skills
  are not visible to transforms, so the client cannot see or skip them itself
  (§9.1.5); the E2E asserts the user's skill wins. Registration remains
  directory-granular on the client side, so one detected collision drops the
  plugin's whole `skills/` dir; the report names the skill and uses the
  collision's severity (error for one of this setup run's own earlier sources,
  warning for another opencode plugin's registration), mirroring §5.7's `mcp`
  override semantics.

### 5.7 MCP translation

Portable format → Opencode native mapping (inside `ctx.mcp.transform`):

```ts
// stdio → local
editor.set(name, {
  type: "local",
  command: [server.command, ...server.args],   // single token + args preserved
  environment: { ...server.env, PLUGIN_ROOT, PLUGIN_DATA },
  ...(server.cwd ? { cwd: expandedCwd } : { cwd: pluginRoot }),
});

// streamable-http → remote
editor.set(name, { type: "remote", url: server.url, ...(server.headers && { headers: server.headers }) });

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
- **Name collision handling — user config wins.** The transform editor exposes
  config-defined servers and earlier plugin registrations. If `editor.get(name)`
  already exists, the entry is skipped and reported: a name registered earlier
  in this same setup run (tracked in local state, updated from inside the
  callback) is a *plugin–plugin* collision → error; anything else is *user
  config* → warn, leave theirs untouched. With `prefix: true` we register as
  `<plugin-name>-<name>` instead (after sanitization, below) and only
  collide-skip if *that* name is taken. This makes `disabled: true`,
  `timeout`, or a full user-defined entry a supported per-server override
  without any extension namespace.
- **Code Mode is the host default.** V2 wraps MCP tools in Code Mode
  (`codemode: true`), so tools are callable as `tools.<server>.<tool>` inside
  `execute` rather than appearing on the provider's native tool list. The
  client leaves the default untouched, so plugin-registered servers behave
  exactly like natively-configured ones; a user who needs the native list can
  pre-define the server with `codemode: false` (user config wins, above).
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

- Layout: `<config-dir>/opencode-agent-plugins/data/<key>/` (see §5.3.2 for
  `<config-dir>` resolution). The key is chosen per source kind:
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
    - **Orphans:** a hand-deleted config entry leaves a data dir orphaned
    within the current store; nothing auto-deletes it at startup,
    `opencode-agent-plugins doctor` lists it, and `prune` removes it
    (§5.11). If the store root itself moves (config-dir change, machine
    migration), the old tree is abandoned: nothing discovers it, and it
    must be removed manually. Startup stays read-only/fast.
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

- Every notice is written to the console as one `[opencode-agent-plugins]` line
  with the structured metadata as trailing JSON (level, message, extra);
  `opencode serve --print-logs` captures it. V2's plugin context exposes no
  logging API (§2.2).
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
| `remove <name> [--keep-data] [--yes] [--dry-run]` | Unregisters from Opencode config and deletes the store entry **and** its `PLUGIN_DATA` |
| `check [<name>…]` | Read-only update check (network) — resolves the configured ref remotely and compares with the recorded commit; no names = all |
| `update [<name>…] [--yes] [--force] [--dry-run]` | Applies available updates (staging → validate → atomic swap, §5.12.3); `--force` follows a moved tag, `--dry-run` prints the plan without writing |
| `list` | Shows installed plugins: source kind, URL/ref/subdir, resolved commit, manifest version, status (current / update available / pinned) |
| `doctor` | Read-only health report: config entries with no store entry, store entries referenced by no config, orphaned `PLUGIN_DATA` dirs, stale `.old-*` swap leftovers, stale name segments in data-dir keys |
| `prune [--yes]` | Removes what `doctor` lists as orphaned/stale (never anything referenced by a config entry) |

Behavior notes:

- **Interaction**: prompts on stdin for confirmation; `--yes` for scripts/CI.
  `--dry-run` prints the plan (components that would be registered) without
  touching anything.
- **Config registration** (`install`): edits the `plugins` array of the resolved
  Opencode config — the project `opencode.json` by default, `--global` for
  `<config-dir>/opencode.json` (the config directory follows OpenCode:
  `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else
  `~/.config/opencode`), `--config <path>` to pick a file. The V2
  entry is `{ "package": "opencode-agent-plugins", "options": { … } }` (a bare
  package string is recognised and replaced by the object form on the first
  write); a legacy V1 `["opencode-agent-plugins", {…}]` tuple is read, its
  sources and other options merged into the entry (the entry's keys win), and
  the tuple removed on the next `install` write (so V2 never loads the loader
  twice). If both
  `opencode.json` and `opencode.jsonc` exist in the target scope, the `.jsonc`
  file wins and the CLI says so; if neither exists, it creates `opencode.json`.
  The edit is
  **JSONC-preserving** (`jsonc-parser`, same approach as `opencode-sdd`): only
  the plugin arrays (`plugins`, plus a legacy `plugin` tuple when present)
  change; comments/formatting elsewhere stay. Written atomically
  (temp file + rename) with a timestamped backup in the store's `backups/` dir —
  **not** `<config>.bak` next to the config, which would invite accidentally
  committing `opencode.json.bak` into the user's repo — and re-parsed before
  writing to guarantee the result is valid: a CLI can never leave Opencode with a
  corrupt config (§5.12.4).
- **Loader-entry bootstrap** (`install`): registering a source is inert
  unless the config already contains the `{ "package":
  "opencode-agent-plugins", … }` loader entry — without it Opencode never
  loads the loader, so the registered source is never resolved. When the
  resolved config has no loader entry, `install` therefore probes it first
  (read-only, `probeConfig`), warns the user, and — in interactive mode — asks
  whether to add the entry to the opencode config before registering;
  declining aborts the whole install with nothing written (the staged git tree
  is dropped). Under `--yes` the entry is added automatically with the warning
  only (skipping confirmation prompts). Existing configs that already have the
  entry (V2 object or legacy tuple) are never re-prompted; a legacy tuple gets
  a note that it will be migrated.
- **Live reload:** V2 watches config directories and reloads the loader plugin,
  so a source installed while Opencode runs is picked up by the next location
  load without a restart (verified on 2.0.16, §9.1.6). The CLI still prints the
  restart hint, which remains the deterministic path.
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
3. Delete the source from the `plugins` entry (and any legacy `plugin` tuple;
   the entry goes when its last source does) — JSONC-preserving, atomic, backup
   in `backups/` — and remove `installed/<slug>`, `meta/<slug>.json`, **and**
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

**V2 watches config directories and reloads the loader plugin.** A source
installed/removed/updated by the CLI is picked up by the next location load
without a restart (verified on 2.0.16, §9.1.6): MCP servers reconnect and the
skill list rebuilds as part of the reload. V2 also watches the loaded plugin's
files, so a store swap can trigger a reload as well. Because reload behavior is
a host feature that can change between releases, the CLI keeps printing a
deterministic hint:

- `install`, `remove`, and `update` **print — they do not prompt or force — a
  "restart Opencode" message**, which remains the guaranteed way to apply the
  change. (The CLI never talks to a running server.)
- `check`, `list`, and `doctor` are read-only and need **no** restart.

**Can these changes break Opencode?** No hard breakage is expected, and the design
bounds the realistic failure modes:

1. **Plugin load failures are non-fatal by construction.** Opencode reports a
   plugin that fails to import or define itself ("failed to load plugin") and
   continues (verified empirically, §9.1). A plugin with an invalid manifest is
   rejected by *our* loader before anything is registered, and each component
   failure is isolated per §6.
2. **The one real risk is a bad config edit by the CLI** — e.g. an invalid
   `plugins` entry would make Opencode refuse the config at startup. Mitigation:
   JSONC-preserving edits, validity re-parse before write, atomic write +
   timestamped backup in the store's `backups/` dir, and abort-on-conflict
   (never overwrite a config that changed between read and write).
3. **Misbehaving MCP servers are bounded by Opencode**: a stdio server that hangs
   or fails the handshake is dropped after the startup/catalog timeout (§2.2;
   30 s defaults in 2.0.16) and does not block other components. `remove`/`update`
   cannot leave a half-started server behind because registrations only change on
   a location reload.
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
| Server name collides with a config-defined or earlier-plugin server | server | existing entry wins — user config: warn + skip ours; plugin–plugin (same setup run): error + skip the later one | warn / error |
| Skill name collides with an existing registration | skill | existing skill wins — another opencode plugin: warn + skip the plugin's whole `skills/` dir; plugin–plugin (same setup run): error + skip the later plugin's whole `skills/` dir; config skill collisions are enforced by the host's registry (user config wins, not reported by the client — §9.1.5) | warn / error |
| Nested `SKILL.md` deeper than `skills/<name>/` | skill | not a skill per spec §7.1; never registered by the plugin; warned as an authoring mistake. A user-authored config `skills` directory is scanned recursively by the host and would expose it (§9.1.5) | warn |
| Server fails to start/connect/auth (runtime) | server | Opencode drops it; other components unaffected | warn (from Opencode) |
| Git-sourced plugin not installed at startup | source | skip entry, continue — no network fetch | warn |
| Installed store entry corrupted / missing manifest | source | reject plugin, continue with others | error |
| `install`: fetch, clone, validation, subpath resolution, or store write fails; `remove`: store deletion fails | install | abort; install rolls back so nothing is written, remove names the leftover paths | error |
| `check`: remote unreachable / auth failure | check | report status unknown, no changes | warn |
| `update`: moved tag / non-fast-forward ref | update | refuse, keep current tree | warn |
| CLI config edit conflicts, invalid `plugins` shape, or fails re-parse | config | abort, keep timestamped backup in store `backups/`, nothing changed | error |

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
| Never reassign published canonical schema ids | §5.4 (vendored, never fetched) | schema-sync script (manual) |
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
| Language/build | TypeScript, ESM, `tsc` → `build/` (mirrors `opencode-sdd` layout, `@opencode/plugin` type-only d.ts import) | Opencode's Bun host imports the plugin directly; no bundler needed (§4.2) |
| Entrypoints | Two per package: opencode plugin (`main`/`exports["."]`) + CLI (`bin`); both thin wrappers over the shared core | §4.2 |
| Packaging | Single npm package, **not** a multi-package workspace | Plugin + CLI must version/publish together; lib boundary enforced by module graph (§4.2) |
| Validation | Ajv with the two vendored JSON schemas | Exact spec fidelity; per-entry validation via `#/$defs/server`; no network |
| Options parsing | Zod | Small, typed; the plugin's own options schema (the V2 SDK uses Effect Schema internally) |
| Filesystem | `node:fs/promises` + `fs.realpath` | Deterministic containment |
| Testing | Vitest unit + integration | Matches sdd test setup |
| Package | `opencode-agent-plugins`, `main: build/index.js`, `files: ["build"]`, default ESM export of the V2 definition | Standard opencode npm plugin |

---

## 9. Testing strategy

### 9.1 Empirical verification (proven, 2026-09-24, opencode 2.0.16)

The E2E suite (§9.2.4) was re-run against opencode 2.0.16 in full (the
five hermetic scenario files, plus the opt-in top-plugins suite) and
passes. The V1-era findings were first established on opencode
1.18.25/1.18.30; the list below is the V2 result.

The core mechanism is **empirically proven** end-to-end: the loader plugin is
loaded as `{ package: "/app/plugin", options: { plugins: "<dir>" } }` (and, for
the CLI chain, as the npm package name) against a real Opencode inside a
throwaway Docker image, with a fake OpenAI-compatible server capturing the
exact request Opencode sends to the model. The proof compares:

- **Plugin mode** — components registered by the loader's V2 `setup` through
  `ctx.skill.transform` / `ctx.mcp.transform`, and
- **Static mode** — the equivalent native V2 config written directly in
  `opencode.json` (baseline).

What was proven:

- The plugin's `setup` runs, receives `ctx.options`, and its transforms are
  **honored**: the plugin's stdio MCP server connects, its tool (`echo_ping`)
  is callable through Code Mode, and the plugin's skill (`hello`) appears in
  the captured model request's `<available_skills>`.
- `PLUGIN_ROOT`/`PLUGIN_DATA` are injected: the MCP tool result reported the
  real plugin root and the loader-created per-instance data dir (§5.8), and the
  spawned server ran with `cwd` = plugin root (spec default honored).
- Plugin mode and static mode are behaviorally equivalent for the shared
  components; the only deliberate difference is the nested `SKILL.md` case
  (finding 5).

Findings that adjust the design:

1. **V2 plugin definition.** A plain default export `{ id, setup }` loads (no
   `Plugin.define` call needed); a V1 function export fails with "Plugin must
   export a default definition with an id and an effect or setup function".
2. **Local plugin paths are directories.** A configured local entry must be a
   plugin directory; a file path is rejected ("configured plugin path must be
   a directory"). For directory targets, 2.0.16 resolves `<dir>/server.js`
   (the package-root import fallback is rejected for directories), so the E2E
   image ships a `server.js` shim re-exporting the compiled entry. npm-name
   entries resolve through the package `main`.
3. **Transform replay timing.** `ctx.*.transform(cb)` may resolve before `cb`
   runs (the registry rebuild is batched), so counters and cross-source state
   must not depend on callback side effects; collision checks belong inside the
   callback, which sees config-defined and earlier-plugin entries.
4. **Code Mode is the default.** MCP tools are wrapped in Code Mode
   (`tools.<server>.<tool>` inside `execute`) unless the server sets
   `codemode: false`; the client leaves the host default untouched and the E2E
   drives tools through `execute`.
5. **Skills.** V2 registers skills individually (id + content); config skills
   are not visible to plugin transforms, and the host keeps a config skill over
   a plugin registration of the same name (user config wins). A user-authored
   config `skills` *directory* is scanned recursively, so a nested `SKILL.md`
   IS exposed there — the plugin's own registration never exposes it. On
   2.0.16 the `<available_skills>` block is part of the system prompt; some
   releases carry it in the `skill` tool description instead, so conformance
   checks accept either surface (`test-e2e/top-plugins.e2e.test.ts`).
6. **Config reload.** V2 watches config directories and reloads the loader
   plugin: a source installed while Opencode runs is picked up without a
   restart (the V1 "restart required" finding no longer holds).
7. **Logging.** There is no plugin logging API; `[opencode-agent-plugins]`
   console lines appear in `opencode serve --print-logs` output.
8. **Placeholder expansion is the client's job.** Opencode passes configured
   `env` values verbatim (a `${PLUGIN_DATA}/echo` value stayed literal),
   confirming the loader must expand placeholders before registration (§5.5).
9. **MCP readiness is asynchronous, and `connected` precedes the tools.**
   A server reports `pending` before `connected`, and `mcp.list` shows
   `connected` BEFORE the server's tools reach the tool registry: Opencode
   registers them through a debounced reconcile of the `mcp.tools.changed`
   event (100 ms in 2.0.16, `packages/core/src/tool/mcp.ts`), while the Code
   Mode `execute` inventory is a snapshot of that registry. The E2E driver
   therefore polls `mcp.list` until the expected state has held past that
   debounce; polling for `connected` alone lets a prompt land inside the
   window and fail with `Unknown tool '<server>.<tool>'` even though the
   server is connected and reports its tools.
10. **The npm cache is generation-based.** 2.0.16 resolves npm-name plugin
    entries under `<cache>/opencode/npm/<name@spec>/<generation>/node_modules/`
    and reuses the newest generation when the package directory exists — the
    E2E image seeds this path so the unpublished local build is tested.

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
     collisions (§5.6): plugin–plugin collisions are client-detected and skip
     the later plugin's whole `skills/` dir; config collisions are host-enforced
     (assert in E2E, §9.1.5) and invisible to the client.
   - Nested `SKILL.md` below `skills/<name>/` → discovery warning, not registered.
   - Placeholder expansion: `./`, `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`, escape attempts
     (`../` both pre- and post-expansion), literal unknown placeholders, expansion
     in the wrong fields (command/url must not expand).
   - Source grammar: `#ref`, `#ref:subdir`, `#:subdir`, malformed refs and
     subdirs, subdir slug derivation and truncation (§5.3.4).
   - Failure taxonomy: one test per §6 row asserting the classification and that
     remaining components load.
2. **Integration tests**: run the registration pipeline against a stub V2
   context (`test/stub-context.ts`); assert the transform registrations and
   `PLUGIN_DATA` creation.
3. **CLI tests**: install/update/remove flows against local git fixtures (a bare
   repo exercised via a `file://` path):
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
   regressions in the integration itself (import-safety note §5.1, scan
   depth, `<available_skills>` surface, host-delegated conformance items §7), so
   it is a release gate, not an optional extra.
5. **Schema provenance script**: the dev-only
   `scripts/update-schemas.ts` re-downloads the canonical schemas, asserts
   each encodes closedness, and rewrites `src/schemas/` only when the bytes
   changed (run manually; never in CI).
6. **Real-world plugin suite (opt-in)**: `E2E_TOP_PLUGINS=1` installs the
   top-ranked published Agent Plugins into clean containers and records the
   install preview, a validation-pipeline tree scan, host-side registration
   and discovery (`config.get`, `mcp.list`, `skill.list`), and the captured
   provider request. GitHub and third-party MCP endpoints make it
   non-hermetic, so it is skipped unless explicitly opted in; CI runs the
   hermetic scenarios only.

---

## 10. Edge cases & decisions

- **Same plugin source configured twice** → dedupe by resolved root (realpath) for
  paths, by slug for git URLs.
- **Plugin source missing at startup** → reject that entry with an error (path) or
  warn + skip (git URL not installed yet, §5.3.3); other entries still load.
- **`skills/` with nested skill dirs** → only immediate children are considered
  skills (spec §7.1). A `SKILL.md` nested deeper than `skills/<name>/` is *not* a
  skill, and registration is per-skill, so it is never registered — we detect and
  warn about the file as an authoring hint (§5.6). Only a user-authored config
  `skills` directory is scanned recursively by the host (§9.1.5).
- **`cwd` with `~` or absolute paths** → not allowed by the spec; treat as invalid
  server entry (§7.2.1 form requirements).
- **Windows** → containment must use case-insensitive path comparisons on Windows;
  `command` single-token preservation and args-passing already match Opencode's
  `command: string[]` contract.
- **Anonymous credentials in headers** → we pass them through (visible package
  data); spec forbids secrets, but client-side we do not inject anything.
- **MCP server `disabled` / `timeout` / `codemode`** → not in the portable
  format; all translated servers default to enabled with Opencode's defaults
  (Code Mode on). Users tune these via the user-config-wins override (§5.7):
  define `mcp.servers.<name>` themselves (a `{ "disabled": true }` stub or a
  full entry, e.g. with `codemode: false`) and the plugin defers; permissions
  can gate `<server>_*` tools.
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
| V2 `Context` type surface changes | Structural `RegistrationContext` + type-only `Context` import make `pnpm typecheck` fail; E2E pins behavior per release |
| Opencode changes to transform/registry semantics | E2E smoke test pins behavior on each release |
| Plugin load failures | V2 reports them (`failed to load plugin`); import-safe bundle; failures logged loudly from inside `setup` |
| Opencode deduplicates plugin entries by package identity | Single-entry + `options.plugins` is the only documented multi-source form (§3.1); re-verify dedup behavior per release |
| Transform registrations clobber user-authored `mcp`/`skills` entries | User-config-wins precedence (§3.2, §5.6, §5.7): the MCP editor pre-check skips config servers; the host's skill registry enforces config precedence; registrations never overwrite pre-existing entries |
| Store/config drift (hand-deleted config entries, crashed swaps) leaves orphans | Nothing auto-deleted at startup; `doctor` reports and `prune` cleans orphans within the current store (§5.11). A moved store root (config-dir change, machine migration) is abandoned and must be removed manually |
| Store and `PLUGIN_DATA` sit inside OpenCode's recursively watched config directory | OpenCode 2.0.16 watches the global config dir recursively (only `node_modules`/`.git` ignored), so store writes feed the debounced config reload. `Config.reload` deep-equals and early-returns, so there is no reload loop today. Accepted consequence of the chosen location; re-verify the watch behavior per OpenCode release (source-read, not runtime-measured) |
| Skills scan depth / `<available_skills>` surface differ between docs and observed behavior | Design robust to both (§5.6 nested-SKILL.md warning); E2E pins actual behavior per release (§9.2) |
| V2 config spec form changes (e.g. the object entry shape) | Object form documented; E2E pins the form per release (§9.1) |
| Path containment bypass via symlinked plugin roots | Always `realpath` before validating; containment checks run on resolved paths |
| MCP tool-name collisions across plugins | Warn + `prefix` option |
| Skill name collisions | Plugin–plugin: the client errors and skips the later dir; config vs plugin: the host keeps the config skill (§9.1.5) |
| Spec evolution (1.1.0 draft) | Canonical-identifier map (§5.9); content diff is currently a no-op |
| Corruption of the Opencode config by the CLI | JSONC-preserving edit, re-parse before write, atomic write + backup in `backups/`, abort on conflict (§5.12.4) |
| Supply chain: a git plugin is code that Opencode will run | Install preview lists declared stdio commands; confirm before install; record resolved commit; encourage `#ref` pins (§5.12.1) |
| Network availability for git sources | Network is only used by CLI commands (`install`/`check`/`update`), never at Opencode startup; failures are per-plugin and non-fatal |
| Git ref drift (branch moved) | `check` reports remote-vs-recorded drift; updates are staged, validated, and atomically swapped (§5.12.3) |
| Half-applied update leaves a broken install | Staging + validate + atomic swap with `.old-*` restore (§5.12.3) |

---

## 12. Future work

- npm registry sources.
- Extract the shared core into a standalone core package (and reconsider a
  multi-package workspace, §4.2) if the client core gains consumers beyond this
  repo.
- Programmatic reload API: ask a running Opencode to reload after
  install/remove/update instead of relying on the config watcher (§5.12.4).
- Signed/verified installs (e.g. recording pinned commit hashes in the config so
  `install` can be reproduced exactly; content-addressed plugin archives).
- Fetch-in-place updates (keep `.git` in the store, `git fetch` + reset) instead of
  re-clone + export — trades the pristine-tree property of §5.3.2 for speed.
- `extensions["com.ameshkov.opencode-agent-plugins"]` namespace so plugin authors
  can carry Opencode-specific settings (e.g. per-server `disabled`, `timeout`,
  `codemode`, `prefix`, name overrides, per-agent tool gating) inside a portable
  plugin.
  (User-side overrides are already covered by the user-config-wins rule, §5.7 —
  this namespace is for *author-shipped* Opencode tuning.)
- File-based client extensions (top-level namespace directories).
- Watch mode for path-sourced plugins (re-register on change).
- Per-instance overrides (`disabled: true`) so users can disable a component
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
