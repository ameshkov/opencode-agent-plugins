# Code conventions reference

Full wording of the conventions whose everyday summary lives in
[AGENTS.md](../../AGENTS.md). Read this page when a change touches file
size, exports, casts, or the TypeScript project layout.

## File size limit

Source files SHOULD stay within 300 lines of code. When a file approaches
or exceeds this limit — or fails the oxlint `max-lines` gate (300 lines) —
your FIRST and default response MUST be to **split the file into several
smaller, cohesive files**, each with a single, clear responsibility
(extract related functions, types, or constants into dedicated modules,
and re-export them through the barrel). Treat the limit as a signal that
the file is doing too much, not as a quota to optimize against. You MUST
attempt a split before any other tactic; only fall back if you can
articulate a concrete reason a split would hurt clarity.

For test files, split a large `*.test.ts` into multiple focused
`*.test.ts` files grouped by the behavior they verify — multiple test
files per source module are explicitly allowed.

**Do NOT** satisfy the limit by making the existing code shorter: no
condensing tests into table-driven blocks purely to save lines, no
shortening of identifiers, string literals, or file paths, no merging
statements onto one line, and no removing blank lines, comments, or
JSDoc. Formatting is managed by Prettier and must stay uniform —
readability and clarity always win over line count.

Exceptions: auto-generated files.

## Function size limit

Functions SHOULD stay within 50 lines of code. When approaching or
exceeding this limit, break the function into smaller, named helper
functions with single, clear responsibilities.

**Do NOT** condense logic into dense one-liners, inline multiple
statements on a single line, or strip whitespace to fit the limit —
formatting is managed by Prettier and must not be sacrificed for brevity.

Exceptions: auto-generated files.

## Knip unused-export analysis

The project uses Knip (`knip.config.ts`) to detect unused exports. All
Knip findings MUST be resolved — either remove the unused export or, when
the export is genuinely needed but not reachable through the public
dependency graph, mark it with the JSDoc `@internal` tag.

The `@internal` tag is allowed **only** when a symbol is exported solely
for test files and is intentionally **not** re-exported from the module
barrel. Every `@internal` tag MUST include a short explanation of why the
export is excluded (e.g., "Exported for tests only; not part of the
public module API"). Do NOT use `@internal` to silence legitimate
unused-export warnings — remove the export instead.

## Double casts (`as unknown as`)

Effect brands the `Skill.Info` ids (`Skill.ID`, `Skill.Name`,
`AbsolutePath`), and constructing the brands at runtime would need a
forbidden `@opencode/*` value import, so `as unknown as Skill.Info` is
sanctioned for brand construction. The sanctioned sites are:

- `src/register-skills.ts` — brand construction for skill registration.
- `test/stub-context.ts` — brand construction plus the editor/context
  facades (they structurally implement a subset of the branded SDK
  interfaces).
- `src/index.test.ts` — the stub → `Context` cast (same reason).
- `src/lib/manifest.ts` — the pre-existing `clean as unknown as
  ManifestData` (the value is already Ajv-validated at runtime) is
  grandfathered — do not replicate it.

No new `as unknown as` site without updating this list.

## TypeScript project structure

The project uses a base/build/test tsconfig split:

- `tsconfig.json` is the shared base and the config the editor keys off.
  It includes production source and tests and sets `types: ["node"]`, so
  every file (including `*.test.ts`) resolves Node built-ins like
  `node:url` in the editor.
- `tsconfig.build.json` extends the base, adds `outDir`/`rootDir`, and
  excludes tests for the compiled `build/` output.
- `tsconfig.test.json` extends the base with `noEmit` for the typecheck
  gate.
- `tsconfig.scripts.json` type-checks `scripts/` with
  `erasableSyntaxOnly`.

Do NOT exclude `*.test.ts` from `tsconfig.json`: doing so makes the editor
treat test files as orphans and report false `Cannot find name 'node:*'`
errors that `pnpm typecheck` does not reproduce.
