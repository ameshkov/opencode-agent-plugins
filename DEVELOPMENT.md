# Development

How to set up the local environment, build the plugin, and run the
checks. Everything else is linked at the end.

## Prerequisites

- **Node.js 26+** — the CLI targets Node >= 26 (`engines.node`). Verify
  with `node --version`.
- **pnpm 10+** — the only supported package manager
  (`packageManager: pnpm@10.14.0`). Enable it with `corepack enable`, or
  install it with `npm install -g pnpm`.
- **git** — required by the CLI's git-backed commands (`install` from a
  URL, `check`, `update`) and by the test fixtures.
- **Docker** — required for `pnpm test:e2e` and the Docker quality gate;
  not needed for `pnpm check`.
- **OpenCode 2** — only for debugging the plugin against a live OpenCode;
  see the [debugging guide](./docs/guides/debugging.md).

No global TypeScript or Vitest install is required; everything is pinned
in `devDependencies`.

## Set up

From the repository root:

```sh
pnpm install
```

No environment variables or `.env` files are required for local
development.

## Commands

All commands are pnpm scripts defined in
[`package.json`](./package.json).

| Command | What it does |
| --- | --- |
| `pnpm build` | Compiles `src/` to `build/`, copies the schemas, and runs the build gates (`check-runtime-imports`, `check-failure-kinds`). |
| `pnpm typecheck` | Type-checks production, test, and scripts code (no emit). |
| `pnpm test` | Runs the unit suite once. |
| `pnpm test:watch` | Runs Vitest in watch mode. |
| `pnpm test:e2e` | Runs the Docker e2e suite (requires Docker and a prior `pnpm build`). |
| `pnpm lint` | Runs oxlint on `src`, `test`, and `scripts`, then Knip. |
| `pnpm lint:fix` | Auto-fixes the oxlint issues that can be fixed. |
| `pnpm format:check` | Checks Prettier and Markdownlint formatting. |
| `pnpm format:fix` | Auto-fixes Prettier and Markdownlint issues. |
| `pnpm check` | The full local gate: `format:check`, `lint`, `typecheck`, `test`. |
| `pnpm clean` | Removes `node_modules/` and `build/`. |

Day-to-day flow:

```sh
pnpm install
pnpm build      # produce build/index.js — OpenCode loads this
pnpm check      # verify everything before commit
```

## Pre-commit hook

The Husky `pre-commit` hook ([`.husky/pre-commit`](./.husky/pre-commit))
runs on every commit and does two things in order, aborting the commit on
any failure:

1. Block staged lines matching `FIXME` or `TODO.*!!` scratch markers.
2. Run `pnpm check` (format + lint + typecheck + unit tests).

Bypass it for a WIP commit with `git commit --no-verify`, but re-run the
full gate before pushing, since CI enforces it anyway. The hook needs
`pnpm` on `PATH`; install Husky's git hooks once with `pnpm prepare`.

## Where to go next

- [Debug the plugin in a live OpenCode](./docs/guides/debugging.md) —
  load a scratch project against the compiled plugin and read the logs.
- [E2E testing in Docker](./docs/guides/e2e-testing.md) — the real-OpenCode
  release gate.
- [Run the quality gate in Docker](./docs/guides/docker-checks.md) —
  reproduce the checks without host tooling.
- [CI reference](./docs/reference/ci.md) — jobs, pins, and the release
  pipeline.
- [AGENTS.md](./AGENTS.md) — code guidelines and project structure.
- [`docs/explanation/design.md`](./docs/explanation/design.md) — the
  authoritative design.
