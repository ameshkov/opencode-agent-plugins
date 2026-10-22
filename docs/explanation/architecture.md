# Architecture

The client has to bridge two different worlds. Agent Plugins are
portable directories with fixed component locations. OpenCode V2 has a
registry that is populated at runtime through plugin transforms. The
architecture keeps that translation in one shared core and gives the
core two thin entry points.

## The two entry points

```text
OpenCode V2 host                         CLI (opencode-agent-plugins)
   │  ctx: location, options, domains        │  install | remove | check
   ▼                                          ▼  update | list | doctor | prune
plugin entry (src/index.ts)          CLI entry (src/cli/index.ts)
plain { id, setup }                  stdio prompts and output
   │                                          │
   └──────────────────┬───────────────────────┘
                      ▼
┌──────────────────────────────────────────────────────────────────┐
│  shared core (src/lib/)                                          │
│  resolve · manifest · skills · mcp · paths · store · install     │
│  update · remove · config edits · failure taxonomy               │
└──────────────────────────────────────────────────────────────────┘
```

The plugin entry emits `ctx.skill.transform → editor.add({ id, name,
path, content })` and `ctx.mcp.transform → editor.set(name, { type:
"local" | "remote" })`.

1. **Plugin entry** (`src/index.ts`) — loaded by OpenCode inside its
   host process. It default-exports a plain `{ id, setup }` object. It
   imports `@opencode/plugin` only for types, so the compiled plugin has
   no runtime OpenCode dependency.
2. **CLI entry** (`src/cli/index.ts`) — the `opencode-agent-plugins`
   binary. It runs on Node.js 26 or later, outside OpenCode, and talks
   to the store and the user's config.

The two entries never import each other. Both import the shared core,
which imports only `node:*`, Ajv, Zod, and `jsonc-parser`.

## Why one package

The plugin and the CLI must validate a package the same way. If
`install` accepted a package that the plugin later rejected, the CLI
would be lying to the user. Shipping both from one `build/` of one
commit makes that guarantee cheap. A multi-package workspace was
considered and rejected: it adds publishing and build-order complexity,
and it invites version skew between the two halves. The module boundary
already provides the separation a workspace would enforce.

The shared core is not a public library. It lives in `src/lib/` and has
no OpenCode imports, not even for types. If it ever gains consumers
outside this repository, it can move to its own package.

## Runtime split

| Entry | Runtime | Output |
| --- | --- | --- |
| Plugin | Bun inside the OpenCode host process | `build/index.js` |
| CLI | Node.js 26 or later | `build/cli/index.js` |

The shared core sticks to portable `node:*` APIs so both runtimes run
the same compiled output. The build uses `tsc` only. There is no
bundler.

## Dependency direction

Dependencies point down:

```text
plugin entry        CLI entry
     ↓                  ↓
register layer     CLI commands
     ↓                  ↓
        shared core
```

The boundary is enforced in two ways:

- `src/lib/` must not import `@opencode/*`. The plugin entry and the
  shared core keep zero runtime `@opencode/*` imports; the CLI layer
  depends on `@opencode/client` only for the reload call. Install-time
  validation must be identical to load-time validation.
- `scripts/check-runtime-imports.ts` scans `build/` during `pnpm build`.
  It rejects any runtime `@opencode/*` import from the plugin entry or
  the shared core. The one exception is `@opencode/client`, which the
  CLI uses for the reload call. The gate allows it only under
  `build/cli/`.

The plugin entry imports `@opencode/plugin` with `import type`. `tsc`
erases the import, so the published plugin loads without
`@opencode/plugin` installed. A leaked value import would fail at module
load, before `setup` runs, and OpenCode would only report a generic
"failed to load plugin" warning.

## How the plugin talks to OpenCode

The plugin talks to OpenCode through two transforms:

```ts
ctx.skill.transform((editor) => { editor.add(skill); });
ctx.mcp.transform((editor) => { editor.set(name, config); });
```

The client currently works this way:

- **Register only through transforms.** V2 has no mutable global config
  object. Registrations live in the registry, not in the config file.
- **Do the collision check inside the callback.** V2 may replay a
  transform callback after `transform()` resolves, during a batched
  registry rebuild. The editor is the authoritative view of earlier
  registrations. Counters returned to the caller are attempted counts,
  not proof that the callback has already run.
- **User-authored config wins.** A colliding name is never overwritten,
  and the host keeps the user entry. An MCP collision with user config
  is reported as a warning and our entry is skipped. A skill collision
  with user config is invisible to transforms, so the client cannot
  report it.
- **Never throw from `setup`.** Each per-plugin failure is caught,
  mapped through the failure taxonomy, and logged. Only the narrowest
  unit is dropped.
- **No network at startup.** Git sources resolve against the local
  store. If a source is not installed, the plugin warns and skips it.
  Installing and updating are CLI jobs.
- **No module-level side effects.** All work happens inside `setup`. A
  module-level throw would make OpenCode skip the plugin before its
  logger exists.

## Packaging

The package exposes two entry points:

```jsonc
{
  "name": "opencode-agent-plugins",
  "type": "module",
  "main": "build/index.js",
  "exports": { ".": { "import": "./build/index.js" } },
  "bin": { "opencode-agent-plugins": "build/cli/index.js" },
  "files": ["build"]
}
```

The vendored JSON schemas are committed under `src/schemas/` and copied
into `build/schemas/` by the build. The plugin never fetches a schema
while loading a package. The dev-only `scripts/update-schemas.ts`
downloads canonical schemas manually, checks that they encode the closed
schema rules, and rewrites the vendored files only when the bytes
change.

## Conformance and delegated duties

The client implements the Agent Plugins 1.0.0 client checklist. Three
duties belong to OpenCode's MCP client and are verified in the e2e
suite, not reimplemented:

- base subprocess environment selection,
- bare-command `PATH` search,
- client-generated header precedence and redirect header handling.

The e2e suite is the tripwire for those behaviors. The [testing
page](testing.md) describes the suite and the findings it pins.

## Trade-offs

- **Single package vs. workspace.** One package keeps validation and
  publishing in lockstep. It also means the CLI's runtime dependency on
  `@opencode/client` ships with the plugin package. The build gate keeps
  that dependency out of the plugin entry.
- **Transforms vs. config writes.** Transforms avoid editing the user's
  config and give the host control over precedence. They also mean
  registrations are runtime state: they disappear when the location
  unloads, and they are rebuilt on the next load.
- **No startup fetch.** Startup stays fast and offline. The cost is
  that a git source must be installed by the CLI before it can load.
