# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Agent Plugins core (`src/lib/`): the shared, opencode-free implementation
  of the spec conformance rules from `docs/design.md` — manifest validation
  (Ajv against the vendored closed schema, unknown-field reclassification),
  skill discovery/validation (frontmatter parsing, nested-`SKILL.md` guard),
  `mcp.json` translation to OpenCode's `local`/`remote` config (stdio env
  injection of `PLUGIN_ROOT`/`PLUGIN_DATA`, remote URL/header rules, `sse`
  skipped), path containment + placeholder expansion, source parsing and
  store resolution, client store layout (`installed`, `meta`, `backups`,
  `data`), the failure taxonomy, and the shared install/update/remove/doctor
  pipeline.
- Plugin registration pipeline (`src/register.ts`): resolve → validate →
  discover → register with user-config-wins collision handling, `prefix`
  option, per-plugin failure isolation, PLUGIN_DATA creation, and structured
  summaries — all through the `config` hook, never throwing.
- CLI commands (`opencode-agent-plugins`): `install` (fetch → validate →
  preview → confirm → register, `--dry-run`, `--no-register`), `remove`,
  `check` (drift via `ls-remote`, tag/SHA semantics), `update` (staging →
  validate → atomic `.old-*` swap), `list`, `doctor`, and `prune` — with
  JSONC-preserving config edits (atomic writes + timestamped backups).
- Unit/integration/CLI tests: spec-derived validation cases, plugin-entry
  integration against the stub client, and end-to-end lifecycle tests against
  a local git fixture (install/check/update/remove).

### Changed

- Build now copies the vendored schemas into `build/schemas/` (loaded via
  `createRequire` at runtime, never fetched).
- `package.json` dependencies: added `ajv` and `jsonc-parser` (pinned).
- Project scaffold (already present from the initial commit): TypeScript
  (ESM, `tsc` to `build/`) with a base/build/test tsconfig split, Vitest,
  oxlint, Prettier, Markdownlint, Knip, Husky pre-commit, Docker
  multi-stage quality gate, and a CI workflow (`ci`, `docker`, `release`
  jobs).
- Switched linting from ESLint + typescript-eslint to oxlint
  (`oxlint.config.ts` replaces `eslint.config.mjs`, correctness category
  plus the project's explicit `max-lines` / `max-lines-per-function` /
  `no-unused-vars` / `preserve-caught-error` gates; ESLint, `@eslint/js`
  and `typescript-eslint` removed from `devDependencies`).
- Upgraded TypeScript to 7.0.2 (typescript-eslint does not support TS 7;
  the oxlint switch unblocks the upgrade).
