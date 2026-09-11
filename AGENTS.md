# AGENTS.md

This file provides guidance to AI agents working on this codebase.

## Project

`opencode-agent-plugins` — an Agent Plugins client for OpenCode. It loads
Agent Plugins packages (a directory with `plugin.json`, optionally `skills/`
and `mcp.json`), validates them against the
[Agent Plugins specification](https://agent-plugins.org/specification) v1.0.0,
and registers their skills and MCP servers into OpenCode. The same npm
package also exposes a CLI that manages the plugin store and the user's
OpenCode config.

The authoritative design is [`docs/design.md`](./docs/design.md) — read the
relevant section before implementing or changing a component. Behavior
described there (failure taxonomy, containment rules, placeholder expansion,
options schema) must match the code; when they diverge, the design is the
contract and the code must be fixed.

## Project Structure

```text
opencode-agent-plugins/
├── src/
│   ├── index.ts            # opencode plugin entry: (input, options) => Hooks
│   ├── options.ts          # Zod schema for the plugin options object
│   ├── register.ts         # plugin pipeline: resolve → validate → register
│   │                         (config-hook logic; talks to the opencode Config shape)
│   ├── register-mcp.ts     # MCP registration: sanitize, collide-skip, config.mcp writes
│   ├── register-skills.ts  # skills registration: collide-skip, config.skills.paths pushes
│   ├── register-types.ts   # shared RuntimeConfig/RegisterState for the register-* modules
│   ├── cli/                # opencode-agent-plugins binary: entry, flag parsing, prompts,
│   │                         output, install/remove/update/inspect commands
│   ├── lib/                # shared core — no @opencode-ai* runtime deps
│   │                         (per docs/design.md §4.1); one module per concern:
│   │   ├── resolve.ts      # source parsing (path | git URL [#fragment]) + store lookup
│   │   ├── git.ts          # git availability, ls-remote, ref resolution
│   │   ├── clone.ts        # clone strategy: shallow-first staging at resolved ref
│   │   ├── install.ts      # install operations (git staging + swap + config edit)
│   │   ├── remove.ts       # remove operations (unregister + store/PLUGIN_DATA delete)
│   │   ├── update.ts       # check/update lifecycle (staging → derive → swap)
│   │   ├── update-status.ts # check/update status records + failure classification
│   │   ├── config-file.ts  # JSONC-preserving edits of the opencode `plugin` array
│   │   ├── store.ts        # store layout, metadata read/write (meta/<slug>.json)
│   │   ├── manifest.ts     # plugin.json validation (Ajv, vendored schema)
│   │   ├── mcp.ts          # mcp.json validation + translation to opencode config
│   │   ├── skills.ts       # skill discovery + validation
│   │   ├── frontmatter.ts  # minimal YAML frontmatter parser for SKILL.md
│   │   ├── paths.ts        # containment + ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion
│   │   ├── data.ts         # PLUGIN_DATA layout + creation
│   │   ├── remote.ts       # remote URL/header rule checks (§5.7)
│   │   ├── doctor.ts       # store/config drift report + prune
│   │   ├── validate.ts     # shared “would register” pipeline (install preview)
│   │   └── errors.ts       # failure taxonomy types + report-to-log mapping
│   ├── schemas/            # vendored Agent Plugins schemas (committed, never fetched)
│   └── utils/              # dependency-free helpers (logger, ...)
├── scripts/                # build/dev gates: check-runtime-imports (no @opencode-ai
│                             runtime imports), check-failure-kinds (§6 kinds),
│                             update-schemas (dev-only schema sync)
├── test/                   # shared test infrastructure (helpers, stub client)
├── test-e2e/               # Docker e2e suite: real opencode + testcontainers, one
│                             scenario file per area (agent-plugins, remote-mcp,
│                             cli-ops, cli-session, negative-behavior) driven by
│                             Dockerfile + bootstrap.mjs and fixtures/
├── vitest.test-e2e.config.ts      # runner config for `pnpm test:e2e`
└── docs/design.md          # the design document
```

The project has **two entry points**, each compiling independently and
importing downward only:

1. **Plugin entry** (`src/index.ts`) — loaded by opencode inside the host
   process. Talks to opencode exclusively through the `config` hook and
   imports `@opencode-ai/plugin` **type-only**.
2. **CLI entry** (`src/cli/index.ts`) — the `opencode-agent-plugins` binary
   run by the user. Runs on Node, outside opencode.

Neither entry imports the other. `src/lib/` imports only `node:*`, Ajv, Zod,
and `jsonc-parser` — never `@opencode-ai/*`, not even for types — so the CLI
installs and runs with no OpenCode dependency, and install-time validation is
byte-identical to load-time validation. This dependency boundary
(`src/lib/` → no `@opencode-ai/*`) is pinned by
`scripts/check-runtime-imports.ts` in `pnpm build`, which fails the build on
any leaked `@opencode-ai/*` value import in the compiled `build/`.

```text
Plugin entry (src/index.ts)
      ↓
options.ts, utils/, lib/ (read-only core)
```

```text
CLI entry (src/cli/index.ts)
      ↓
lib/ (shared core) + node:*, Ajv, Zod, jsonc-parser
      ↓
Plugin store + user opencode config on disk
```

New layers (services, utilities) MUST sit below the entry points. Sibling
layers MUST NOT import from each other arbitrarily; shared logic lives in
`lib/` or `utils/` and is imported by the layer that needs it.

## Plugin Surface

This plugin talks to opencode exclusively through the `config` hook:

- **Registering skills and MCP servers is a config-hook concern.** The
  `config` hook receives opencode's live merged `Config` object and mutates
  it in place: skills under `config.skills.paths`, MCP servers under
  `config.mcp`.
- **Never overwrite existing user configuration — user-authored config
  always wins.** The hook runs after config resolution, so blind mutation
  would clobber user intent (an `mcp: { "name": { "enabled": false } }` stub
  or a user-defined server of the same name). Any pre-existing `config.mcp`
  entry or `skills.paths` entry that collides with a plugin registration is
  left untouched; the plugin's registration is skipped and reported. Skills
  registration is directory-granular, so a colliding skill name skips the
  plugin's whole `skills/` dir (user-config-wins, `docs/design.md` §5.6).
- **No network access at startup.** Git URLs and installed plugin names
  resolve against the client store; sources that cannot be resolved without
  fetching are skipped with a warning. Startup stays fast and offline
  (installing/updating is the CLI's job).
- **Failure isolation.** Every per-plugin failure is caught, mapped through
  the failure taxonomy (`docs/design.md` §6), and logged; the hook never
  throws. Only the narrowest unit is dropped — reject plugin → invalid
  component type → skip skill → invalid server entry → deny path.
- **`config.skills` may be missing from the SDK type.** Normalize
  (`config.skills ??= { paths: [] }`) through a local cast and treat the
  runtime schema (`opencode.ai/config.json`) as authoritative.
- **The plugin must not throw during load.** Keep the `config` hook
  deterministic; if registration of a feature fails, degrade gracefully
  rather than breaking opencode startup. A module-level error in the plugin
  file makes opencode skip the plugin silently — the bundle must have no
  top-level side effects that can throw.

## Code Quality

All code MUST meet documentation and style requirements before merge:

- **Public API documentation**: Exported functions, classes, interfaces,
  and their properties MUST have JSDoc comments describing purpose,
  arguments, return values, and thrown errors (use `@throws` only for
  specific errors).
- **Static analysis gates**: Every change MUST pass TypeScript compilation
  (`pnpm typecheck`), oxlint (`pnpm lint`), and Prettier/Markdownlint
  (`pnpm format:check`) before merge.
- **Do not modify linter or formatter configurations**: Never change
  oxlint, Prettier, Markdownlint, or TypeScript configuration files
  (`oxlint.config.ts`, `.prettierrc`, `.prettierignore`,
  `.markdownlint-cli2.yaml`, `tsconfig.json`, `tsconfig.build.json`)
  to work around lint or formatting errors. Fix the source code instead.
  If the issue cannot be resolved after a few attempts, ask the human for
  help. Legitimate structural edits to these files (for example, the
  base/build/test tsconfig split) are not "workarounds" and are allowed.
- **Error handling strategy**: Prefer throwing errors over returning error
  values. Handle errors at top-level entry points where they can be logged.
- **Secrets and API keys**: Never write credentials (API keys, tokens,
  passwords) into the repository — not in source, scripts, config files,
  fixture data, compose files, or shell-history-prone tooling. When a
  script needs a secret, obtain it at runtime from the environment, a
  file kept OUTSIDE the repo, or a hidden interactive prompt; export it
  into the child process environment without ever echoing it, and never
  pass it via command-line arguments.
- **File naming**: Use kebab-case for all file names. TypeScript source
  files MUST use lower-case kebab-case. Do NOT use PascalCase or camelCase
  file names.
- **ESM import specifiers**: The project targets `module: Node16`. Relative
  imports MUST include the `.js` extension (e.g., `./lib/paths.js`), even
  though the source is `.ts`.
- **Knip unused-export analysis**: The project uses Knip
  (`knip.config.ts`) to detect unused exports. All Knip findings MUST
  be resolved — either remove the unused export or, when the export is
  genuinely needed but not reachable through the public dependency
  graph, mark it with the JSDoc `@internal` tag. The `@internal` tag
  is allowed **only** when a symbol is exported solely for test files
  and is intentionally **not** re-exported from the module barrel.
  Every `@internal` tag MUST include a short explanation of why the
  export is excluded (e.g., "Exported for tests only; not part of the
  public module API"). Do NOT use `@internal` to silence legitimate
  unused-export warnings — remove the export instead.
- **File size limit**: Source files SHOULD stay within 300 lines of code.
  When a file approaches or exceeds this limit — or fails the oxlint
  `max-lines` gate (300 lines) — your FIRST and default response MUST be
  to **split the file into several smaller, cohesive files**, each with a
  single, clear responsibility (extract related functions, types, or
  constants into dedicated modules, and re-export them through the
  barrel). Treat the limit as a signal that the file is doing too much,
  not as a quota to optimize against. You MUST attempt a split before any
  other tactic; only fall back if you can articulate a concrete reason a
  split would hurt clarity. For test files, split a large `*.test.ts`
  into multiple focused `*.test.ts` files grouped by the behavior they
  verify — multiple test files per source module are explicitly allowed.
  **Do NOT** satisfy the limit by making the existing code shorter: no
  condensing tests into table-driven blocks purely to save lines, no
  shortening of identifiers, string literals, or file paths, no merging
  statements onto one line, and no removing blank lines, comments, or
  JSDoc. Formatting is managed by Prettier and must stay uniform —
  readability and clarity always win over line count.
  Exceptions: auto-generated files.
- **Function size limit**: Functions SHOULD stay within 50 lines of code.
  When approaching or exceeding this limit, break the function into
  smaller, named helper functions with single, clear responsibilities.
  **Do NOT** condense logic into dense one-liners, inline multiple
  statements on a single line, or strip whitespace to fit the limit —
  formatting is managed by Prettier and must not be sacrificed for
  brevity.
  Exceptions: auto-generated files.

**Rationale**: Consistent documentation and tooling enforcement prevents
technical debt accumulation and ensures codebase navigability.

## Testing

Every module MUST have test coverage:

- **Test file placement**: Test files are co-located with their source
  files in `src/` and MUST use the `.test.ts` suffix (e.g.,
  `src/options.test.ts` next to `src/options.ts`).
- **Shared test utilities**: Common test infrastructure lives in the
  `test/` directory. These files MUST NOT use the `.test.ts` suffix — they
  are test support code, not test cases.
- **Test verification mandatory**: All changes MUST pass `pnpm test`
  before merge. Tests MUST NOT be deleted or weakened without explicit
  justification.
- **Test cases stay consistent with code**: When a change alters
  behavior, update the affected test cases in the same change. A case left
  asserting stale behavior, or written so it can never pass as-is (wrong
  endpoint, mismatched id, unreachable fixture), is a defect, not
  documentation: fix the case with the code.
- **Prefer real behavior over mocks**: The plugin entry is exercised by
  calling it and asserting on the `config` hook's effect on a `Config`
  object, not by mocking opencode internals. The stub client in
  `test/stub-client.ts` implements only `client.app.log` so log assertions
  stay real.

**Rationale**: Co-locating tests with source keeps related files close,
making it easier to find, update, and maintain them.

## Dependency Management

- **Pin all dependency versions explicitly**: Do not use `^` or `~` in
  `package.json`.
- **Type-only dependencies are devDependencies**: The OpenCode Plugin
  package (`@opencode-ai/plugin`) is imported only for types (erased at
  compile time), so it lives in `devDependencies`. The compiled plugin
  output (`build/`) retains zero runtime `@opencode-ai/*` imports —
  enforced by `scripts/check-runtime-imports.ts` in `pnpm build`, which
  fails the build on any leaked value import (`import type { ... }` is the
  only correct form).
- **Keep the opencode version in sync.** The opencode release is pinned
  in `package.json` (`@opencode-ai/plugin`) and the `OPENCODE_VERSION`
  env in `.github/workflows/ci.yml`; the npm package and the binary MAY
  differ by a patch but MUST stay on the same minor line — the plugin is
  only verified against one opencode release at a time. After any bump,
  run `pnpm typecheck` (API compatibility against the new SDK types),
  `pnpm test`, and the e2e suite before merging.

External dependencies MUST be carefully evaluated before adoption:

- **Prefer vanilla solutions**: Use Node.js built-in APIs and standard
  language features when they adequately solve the problem. Only add a
  dependency when it provides significant value over a vanilla
  implementation.
- **Reputable sources only**: Dependencies MUST come from
  well-established, actively maintained projects. Evaluate by: weekly
  downloads (prefer >100k), GitHub stars, recent commit activity, and
  known maintainers.
- **Avoid unpopular libraries**: Do NOT add niche or obscure packages
  with limited community adoption. These pose security risks and may
  become unmaintained.
- **Minimize dependency count**: Each new dependency increases attack
  surface, bundle size, and maintenance burden. Justify every addition.
- **Use the latest stable version**: When adding a new dependency,
  explicitly check the package registry for the latest stable release and
  use it. Do not copy outdated version numbers from memory, training
  data, or existing lock files of other projects.

**Rationale**: Fewer, well-vetted dependencies reduce security
vulnerabilities, supply chain risks, and long-term maintenance costs.

## Configuration & Documentation

Configuration and documentation MUST stay synchronized with code:

- **Documentation updates required**: Changes to build process, plugin
  surface, or configuration MUST update relevant documentation.
- **Structure tracking**: Changes to project structure MUST update the
  Project Structure section in `AGENTS.md`.
- **TypeScript project structure**: The project uses a base/build/test
  tsconfig split. `tsconfig.json` is the shared base and the config the
  editor keys off; it includes production source and tests and sets
  `types: ["node"]`, so every file (including `*.test.ts`) resolves Node
  built-ins like `node:url` in the editor. `tsconfig.build.json` extends
  the base, adds `outDir`/`rootDir`, and excludes tests for the compiled
  `build/` output. `tsconfig.test.json` extends the base with `noEmit`
  for the typecheck gate. Do NOT exclude `*.test.ts` from `tsconfig.json`:
  doing so makes the editor treat test files as orphans and report false
  `Cannot find name 'node:*'` errors that `pnpm typecheck` does not
  reproduce.

**Rationale**: Stale documentation causes onboarding friction and
operational incidents.

## Markdown Formatting

All Markdown files MUST follow these formatting rules:

- **Line length**: Keep lines at most 80 characters. This is not a hard
  lint gate, but SHOULD be followed for readability. Lines inside fenced
  code blocks are exempt from this limit.
- **Unordered lists**: Use dashes (`-`) for bullet points. Indent nested
  list items by 4 spaces.
- **Continuation lines**: When a list item wraps to the next line, align
  the continuation with the first character of the item text, not the
  list marker. This applies to all list types (ordered and unordered).
- **Emphasis**: Use asterisks (`*`) for emphasis (`*italic*`,
  `**bold**`). Do NOT use underscores.
- **Headings**: Duplicate heading names are allowed only among sibling
  headings (same parent level). Avoid duplicates across different levels.
- **Inline HTML**: Avoid raw HTML in Markdown. The only allowed elements
  are `<a>`, `<p>`, `<details>`, `<summary>`, and `<img>`.
- **Trailing spaces**: Do NOT leave trailing whitespace on any line. Do
  NOT use two-space line breaks — use a blank line instead.
- **Bare URLs**: Bare URLs are permitted and do not need to be wrapped
  in angle brackets.
- **Table formatting**: Align table columns with padding when the table
  fits within 80 characters. If the table exceeds 80 characters or
  triggers an MD060 linter warning, switch to a compact format using
  single spaces only. This applies to the separator row as well — it
  should be written as `| --- |`, not `|--|`.

  Example of correct layout:

  ```markdown
  | Col1 | Col2 |
  | --- | --- |
  | Value1 | Value2 |
  ```

  Do NOT use extra padding or alignment characters beyond single spaces.

**Rationale**: Uniform Markdown formatting improves readability for both
humans and AI agents that consume project documentation.
