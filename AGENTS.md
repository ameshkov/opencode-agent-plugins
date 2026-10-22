# AGENTS.md

This file provides guidance to AI agents working on this codebase.

## Table of Contents

- [Project Overview](#project-overview)
- [Technical Context](#technical-context)
- [Project Structure](#project-structure)
- [Build And Test Commands](#build-and-test-commands)
- [Contribution Instructions](#contribution-instructions)
- [Code Guidelines](#code-guidelines)
    - [System Design](#system-design)
    - [Architecture](#architecture)
    - [Code Quality](#code-quality)
    - [Testing](#testing)
    - [Dependency Management](#dependency-management)
    - [Configuration & Documentation](#configuration--documentation)
    - [Other](#other)

## Project Overview

`opencode-agent-plugins` is an Agent Plugins client for OpenCode. It loads
Agent Plugins packages (a directory with `plugin.json`, optionally
`skills/` and `mcp.json`), validates them against the
[Agent Plugins specification](https://agent-plugins.org/specification)
v1.0.0, and registers their skills and MCP servers into OpenCode. The same
npm package also exposes a CLI that manages the plugin store and the
user's OpenCode config.

The explanation pages under [`docs/explanation/`](./docs/explanation/index.md)
describe how the client works and why. They describe the current state
of the code; they are not a contract and do not bind future changes.
Code and tests define actual behavior. `docs/reference/*` is normative
for the public surface (CLI flags, configuration, statuses, exit codes).

## Technical Context

- **Language/Version**: TypeScript 7.0.2 (strict, ESM,
  `module: Node16`), compiled with `tsc` to `build/`; no bundler.
- **Primary Dependencies**: `ajv` (schema validation), `zod` (options
  parsing), `jsonc-parser` (config edits), `@opencode/client` (the CLI's
  reload call); `@opencode/plugin` is a type-only devDependency.
- **Storage**: the filesystem — the client store under
  `<config-dir>/opencode-agent-plugins/` (the OpenCode config directory:
  `$OPENCODE_CONFIG_DIR`, then `$XDG_CONFIG_HOME/opencode`, then
  `~/.config/opencode`) and the user's OpenCode config (see the
  [configuration reference](./docs/reference/configuration.md)).
- **Testing**: Vitest 4 for unit tests; Testcontainers plus a real
  OpenCode binary in Docker for e2e tests.
- **Target Platform**: the OpenCode host process (plugin entry) and
  Node.js >= 26 (CLI entry).
- **Project Type**: CLI tool + library — one npm package with two entry
  points.
- **Performance Goals**: N/A — startup must stay fast and offline.
- **Constraints**: no network access at startup; everything under
  `build/` must keep zero runtime `@opencode/*` imports, except
  `@opencode/client` under `build/cli/`; the plugin must never throw during
  load.
- **Scale/Scope**: one OpenCode location with a handful of configured
  sources; the CLI manages a single user's store and config.

## Project Structure

```text
opencode-agent-plugins/
├── src/
│   ├── index.ts            # OpenCode V2 plugin entry: plain { id, setup } definition
│   ├── options.ts          # Zod schema for the plugin options object
│   ├── register.ts         # plugin pipeline: resolve → validate → register
│   ├── register-mcp.ts     # MCP registration: sanitize, collide-skip, ctx.mcp.transform
│   ├── register-skills.ts  # skills registration: collide-skip, ctx.skill.transform adds
│   ├── register-types.ts   # shared RegistrationContext/RegisterState types
│   ├── cli/                # `opencode-agent-plugins` binary: entry, flags, prompts,
│   │                         reload, install/remove/update/inspect commands
│   ├── lib/                # shared core — no @opencode/* runtime deps; one module per
│   │                         concern (resolve, git, clone, install, remove, update-*,
│   │                         config-*, store, manifest, mcp, mcp-schema, skills,
│   │                         frontmatter, paths, data, remote, doctor-*, move,
│   │                         validate, errors)
│   ├── schemas/            # vendored Agent Plugins schemas (committed, never fetched)
│   └── utils/              # dependency-free helpers (logger)
├── scripts/                # build/dev gates: check-runtime-imports, check-failure-kinds,
│                             update-schemas (dev-only schema sync)
├── test/                   # shared test infrastructure (helpers, stub context)
├── test-e2e/               # Docker e2e suite: real OpenCode via Testcontainers, one
│                             scenario file per area, fixtures/, Dockerfile
├── docs/                   # documentation, organized by Diátaxis type
│   ├── tutorials/          # getting-started walkthrough
│   ├── guides/             # debugging, e2e testing, Docker checks
│   ├── reference/          # CLI, configuration, CI, code conventions
│   └── explanation/        # architecture, sources, registration, CLI lifecycle,
│                             reload, failures, testing, future work
├── Dockerfile              # host-tool-free quality gate (docs/guides/docker-checks.md)
└── .github/workflows/      # CI and release (docs/reference/ci.md)
```

The project has **two entry points**, each compiling independently and
importing downward only:

1. **Plugin entry** (`src/index.ts`) — loaded by OpenCode inside the host
   process. Talks to OpenCode exclusively through the V2 `setup` context
   transforms and imports `@opencode/plugin` **type-only**.
2. **CLI entry** (`src/cli/index.ts`) — the `opencode-agent-plugins`
   binary, run on Node outside OpenCode.

Neither entry imports the other. `src/lib/` imports only `node:*`, Ajv,
Zod, and `jsonc-parser` — never `@opencode/*`, not even for types — so
the shared core runs with no OpenCode dependency and install-time
validation is byte-identical to load-time validation. The CLI layer may
import `@opencode/client` for the reload call; the plugin entry and
`src/lib/` may not. The boundary is pinned by
`scripts/check-runtime-imports.ts` in `pnpm build`. Layer and packaging
details:
[`docs/explanation/architecture.md`](./docs/explanation/architecture.md).

## Build And Test Commands

- **Build**: `pnpm build` — compiles to `build/`, copies the schemas, and
  runs the build gates.
- **Unit tests**: `pnpm test` (once), `pnpm test:watch` (watch mode).
- **E2E tests**: `pnpm build && pnpm test:e2e` (Docker required; see the
  [e2e guide](./docs/guides/e2e-testing.md)).
- **Type check**: `pnpm typecheck`.
- **Lint**: `pnpm lint`, `pnpm lint:fix`.
- **Format check / fix**: `pnpm format:check`, `pnpm format:fix`.
- **Full gate**: `pnpm check` — format, lint, typecheck, unit tests.
- **Run**: not applicable — OpenCode loads the plugin; for live debugging
  see the [debugging guide](./docs/guides/debugging.md).

## Contribution Instructions

- You MUST verify your work with the linter, formatter, and type checker.

  Use the following commands:
    - `pnpm typecheck` to check for type errors
    - `pnpm lint` to run the linter (oxlint + Knip)
    - `pnpm lint:fix` to fix linting issues automatically
    - `pnpm format:check` to check formatting
    - `pnpm format:fix` to fix formatting issues

- You MUST update the unit tests for changed code.
- You MUST run `pnpm test` and make it pass before considering a task
  done.
- You MUST update the affected documentation when a change affects it:
  `README.md`, `DEVELOPMENT.md`, and the pages under `docs/`.
- When the project structure changes, you MUST update the Project
  Structure section of this file.
- If a prompt asks for a refactoring or improvement, capture the resulting
  rule in the relevant Code Guidelines subsection of this file.
- After completing a task, verify the written code against the Code
  Guidelines in this file.
- Even when the task is to write or update a document, run
  `pnpm format:check` and fix the Markdown formatting.

## Code Guidelines

### System Design

Design for a CLI tool that doubles as a library consumed by OpenCode:

- The CLI runs and exits — no long-lived state, no background daemons.
  Perform the requested work and exit with the documented code (`0`
  success, `1` failure or aborted, `2` `check`/`doctor` found something).
- Write results and plans to stdout, diagnostics and errors to stderr.
- Fail fast with clear messages: validate inputs early, report the first
  error with enough context to fix it, and exit.
- The plugin entry runs inside OpenCode's host process: keep module scope
  side-effect-free, `setup` deterministic, and never let it throw.
- Never touch the network or the filesystem outside the store and config
  paths the CLI is explicitly managing. Git-backed commands (`install`
  from a URL, `check`, `update`) use the network for git. The only
  non-git network call is the local OpenCode reload endpoint
  (`src/cli/reload.ts`); it is best-effort, uses the service registration
  file, and never logs credentials. The plugin entry never fetches.
- After a successful `install`, `remove`, or an `update` that applies at
  least one change, reload a running OpenCode unless `--no-reload` is given.
  A no-op `update` does not reload. `install --no-register` and `--dry-run`
  never reload. A failed reload is a warning, not a command failure.
- Keep startup fast — no heavy initialization at module load.

### Architecture

- **Separation of Concerns** — entry points only wire; logic lives in
  `src/cli/` and `src/lib/` modules.
- **Single Responsibility Principle** — one module per concern in
  `src/lib/` (resolve, install, update, ...).
- **Dependency Direction** — dependencies point downward to `lib/` and
  `utils/`; no lower layer imports an entry point.
- **Explicit Boundaries** — the two entries share `lib/` and never import
  each other.
- **Data Flow Clarity** — resolve → validate → register (plugin);
  stage → validate → swap (CLI lifecycle).
- **Minimize Coupling, Maximize Cohesion** — modules interact through
  narrow exported functions; `lib/` has no OpenCode dependency at all.
- **Make Invalid States Impossible** — Zod validates options, Ajv
  validates manifests, the failure taxonomy is a closed type.
- **Observability Built-in** — every failure goes through the failure
  taxonomy and the `[opencode-agent-plugins]` logger.
- **Keep It Boring** — plain TypeScript, no frameworks, no bundler.

Layers, top to bottom:

```text
plugin entry (src/index.ts)          CLI entry (src/cli/index.ts)
      ↓                                    ↓
register layer (src/register*.ts)    CLI commands (src/cli/)
      ↓                                    ↓
shared core (src/lib/, src/utils/) — no @opencode/* runtime deps
```

New layers (services, utilities) MUST sit below the entry points. Sibling
layers MUST NOT import from each other arbitrarily; shared logic lives in
`lib/` or `utils/` and is imported by the layer that needs it.

**Host contract** — behavioral rules for anything touching registration:

- Register only through `ctx.skill.transform` / `ctx.mcp.transform`;
  collision checks and reports live inside the transform callback, never
  after the `await`.
- User-authored config always wins: a colliding name is skipped and
  never overwritten. An MCP collision with user config is reported as a
  warning; a skill collision with user config is invisible to transforms
  and not reported by the client.
- No network access at startup: sources that cannot be resolved without
  fetching are skipped with a warning.
- `setup` never throws: every per-plugin failure is caught, mapped
  through the failure taxonomy, and logged; only the narrowest unit is
  dropped.
- The entry imports `@opencode/plugin` type-only and default-exports a
  plain `{ id, setup }` object, so the plugin entry keeps zero runtime
  `@opencode/*` imports. `@opencode/client` is allowed only under
  `build/cli/`, for the reload call.
- No new `as unknown as` cast sites: the sanctioned list is in the
  [code conventions reference](./docs/reference/code-conventions.md).

Details: [`docs/explanation/registration.md`](./docs/explanation/registration.md)
(components and precedence),
[`docs/explanation/failures.md`](./docs/explanation/failures.md) (failure
taxonomy), and [`docs/explanation/testing.md`](./docs/explanation/testing.md)
(host findings).

### Code Quality

- Exported functions, classes, interfaces, and their properties MUST have
  JSDoc comments describing purpose, arguments, and return values (use
  `@throws` only for specific errors).
- Never modify linter, formatter, or TypeScript configuration files
  (`oxlint.config.ts`, `.prettierrc`, `.prettierignore`,
  `.markdownlint-cli2.yaml`, `tsconfig*.json`) to work around an error —
  fix the source instead. Legitimate structural edits (for example the
  base/build/test tsconfig split) are allowed.
- Prefer throwing errors over returning error values; handle errors at
  top-level entry points where they can be logged.
- Never write credentials (API keys, tokens, passwords) into the
  repository. Obtain secrets at runtime from the environment, a file kept
  outside the repo, or a hidden prompt; never pass them via command-line
  arguments.
- File names: kebab-case; TypeScript source files lower-case kebab-case.
- Relative imports MUST include the `.js` extension (module: Node16),
  e.g. `./lib/paths.js`.
- Keep files within 300 lines and functions within 50 lines by splitting,
  never by condensing — full rules in the
  [code conventions reference](./docs/reference/code-conventions.md).
- Resolve all Knip findings; `@internal` is only for test-only exports —
  full rules in the
  [code conventions reference](./docs/reference/code-conventions.md).

### Testing

- Every module MUST have test coverage. Test files are co-located with
  their source files and MUST use the `.test.ts` suffix.
- Shared test infrastructure lives in `test/` and MUST NOT use the
  `.test.ts` suffix.
- All changes MUST pass `pnpm test`; never delete or weaken tests without
  explicit justification; update affected cases in the same change as the
  behavior.
- Prefer real behavior over mocks: exercise the plugin entry by calling
  `setup` with `stubContext()` and asserting on the recorded
  registrations and log entries (`test/stub-context.ts`).
- Any test that exercises a real OpenCode binary MUST run inside Docker —
  never install or run OpenCode on the host. The e2e suite lives in
  `test-e2e/` ([guide](./docs/guides/e2e-testing.md)); the testing
  strategy is in
  [`docs/explanation/testing.md`](./docs/explanation/testing.md).
- The reload path MUST be tested without a real OpenCode process: use a
  temporary `XDG_STATE_HOME` and a stub HTTP service, as in
  `src/cli/reload.test.ts`.

### Dependency Management

- Pin all dependency versions explicitly — no `^` or `~`.
- `@opencode/plugin` is a type-only devDependency. `@opencode/client` is
  a runtime dependency used only by the CLI layer for the reload call.
  The plugin entry and `src/lib/` must keep zero runtime `@opencode/*`
  imports; `scripts/check-runtime-imports.ts` in `pnpm build` allows
  `@opencode/client` only under `build/cli/`.
- Keep the OpenCode version in sync across `package.json` and
  `OPENCODE_VERSION` in `.github/workflows/ci.yml`; the npm packages and
  the binary MAY differ by a patch but MUST stay on the same minor line.
  After a bump: `pnpm typecheck`, `pnpm test`, and the e2e suite.
- Prefer vanilla Node.js APIs and standard language features; add a
  dependency only for significant value over a vanilla implementation.
- Dependencies MUST come from well-established, actively maintained
  projects; do NOT add niche or obscure packages.
- Use the latest stable version — check the registry when adding a
  dependency, never copy a version number from memory.

### Configuration & Documentation

- Changes to the build process, plugin surface, configuration, or project
  structure MUST update the affected documents in the same change
  (`README.md`, `DEVELOPMENT.md`, the pages under `docs/`, and the
  Project Structure section above).
- Code and tests define actual behavior. `docs/reference/*` is normative
  for the public surface (CLI, configuration) and MUST be updated in the
  same change.
- Runtime configuration (plugin entry options, CLI flags, store env
  vars) is documented in the
  [configuration reference](./docs/reference/configuration.md) and the
  [CLI reference](./docs/reference/cli.md).
- TypeScript project structure (the base/build/test tsconfig split and
  why `*.test.ts` must stay in `tsconfig.json`): see the
  [code conventions reference](./docs/reference/code-conventions.md).

### Other

Markdown formatting: `pnpm format:check` runs Markdownlint and Prettier
and enforces most rules (see `.markdownlint-cli2.yaml`). The conventions
the linter does not enforce:

- Keep lines at most 80 characters where practical; fenced code blocks
  are exempt.
- Align wrapped list continuation lines with the first character of the
  item text, not the list marker.
- Tables: pad columns when the table fits within 80 characters, otherwise
  use single spaces (`| --- |`, not `|--|`).
