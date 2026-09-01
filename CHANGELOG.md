# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project scaffold: TypeScript (ESM, `tsc` to `build/`) with a
  base/build/test tsconfig split, Vitest, oxlint, Prettier, Markdownlint,
  Knip, Husky pre-commit, Docker multi-stage quality gate, and a CI
  workflow (`ci`, `docker`, `release` jobs) — mirrored from the
  `opencode-sdd` layout.
- Plugin entry (`src/index.ts`): the `config`-hook-only plugin entry that
  parses options, normalizes `config.skills`, and logs — never throws.
- Options schema (`src/options.ts`): Zod parsing of `plugins` / `prefix` /
  `logLevel` with strict known keys, unknown-key warnings, and defaults.
- Plugin logger (`src/utils/logger.ts`): structured `client.app.log`
  entries with `logLevel` filtering and swallow-on-failure logging.
- CLI entry (`src/cli/index.ts`): `--help` / `--version` plus the command
  skeleton (`install`, `remove`, `check`, `update`, `list`, `doctor`,
  `prune`) per `docs/design.md` §5.11.
- Vendored Agent Plugins schemas (`src/schemas/`) with the dev-only
  `scripts/update-schemas.mjs` fetch/verify/re-vendor helper.
- `scripts/check-runtime-imports.mjs` build gate: fails the build on any
  leaked `@opencode-ai/*` value import in `build/`.

### Changed

- Switched linting from ESLint + typescript-eslint to oxlint
  (`oxlint.config.ts` replaces `eslint.config.mjs`, correctness category
  plus the project's explicit `max-lines` / `max-lines-per-function` /
  `no-unused-vars` / `preserve-caught-error` gates; ESLint, `@eslint/js`
  and `typescript-eslint` removed from `devDependencies`).
- Upgraded TypeScript to 7.0.2 (typescript-eslint does not support TS 7;
  the oxlint switch unblocks the upgrade).
