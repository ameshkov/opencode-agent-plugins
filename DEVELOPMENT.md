# Development Guide

How to build, run, and debug the `opencode-agent-plugins` plugin against a
live opencode instance. For architecture and contribution rules, see
[AGENTS.md](./AGENTS.md); for the user-facing pitch, see
[README.md](./README.md); for the feature plan, see
[docs/design.md](./docs/design.md).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Development Workflow](#development-workflow)
    - [Build Commands](#build-commands)
    - [Debugging with opencode](#debugging-with-opencode)
    - [Running Checks in Docker](#running-checks-in-docker)
- [Continuous Integration](#continuous-integration)
- [Troubleshooting](#troubleshooting)
- [Additional Resources](#additional-resources)

## Prerequisites

- **Node.js 22+** — the CLI targets Node ≥ 22; the plugin entrypoint runs
  inside the opencode host. Verify with `node --version`.
- **pnpm 10+** — the only supported package manager. Verify with
  `pnpm --version`.
- **opencode** — required for end-to-end debugging of the plugin (load it
  into a scratch project and inspect logs). Install separately (for example
  `brew install opencode` on macOS) and verify with `opencode --version`.
- **git** — required by the CLI's git-backed commands (`install` from a
  URL, `check`, `update`); `list`, `remove`, `doctor`, `prune`, and
  path-sourced `install` work without it.

No global TypeScript or Vitest install is required; everything is pinned
in `devDependencies`. After cloning:

```sh
pnpm install
```

No environment variables or `.env` files are required for local
development. The `@opencode-ai/plugin` package is type-only and erased by
the compiler, so the compiled `build/` is self-contained.

## Development Workflow

This section covers the day-to-day loop: building, running the checks,
and debugging against a live opencode server. For code style, lint
rules, and architectural guidelines, see
[AGENTS.md](./AGENTS.md) — this document does not duplicate them.

### Build Commands

All commands run through pnpm scripts defined in
[`package.json`](./package.json). The compiled plugin is emitted to
`build/` and is what opencode loads.

- `pnpm install` — install pinned dependencies.
- `pnpm build` — compile TypeScript to `build/` (`tsc`), then verify no
  `@opencode-ai/*` runtime imports leaked into `build/` (the package is a
  type-only devDependency).
- `pnpm typecheck` — type-check production *and* test code (no emit for
  the test graph).
- `pnpm test` — run the Vitest suite once.
- `pnpm test:watch` — run Vitest in watch mode for iterative TDD.
- `pnpm lint` — run oxlint on `src/` plus Knip unused-export analysis.
- `pnpm lint:fix` — auto-fix the oxlint issues that can be fixed.
- `pnpm knip` — run Knip unused-export analysis on its own.
- `pnpm format:check` — check Prettier *and* Markdownlint formatting.
- `pnpm format:fix` — auto-fix Prettier and Markdownlint issues.
- `pnpm check` — the full local gate: `format:check`, `lint`,
  `typecheck`, and `test`.
- `pnpm clean` — remove `node_modules/` and `build/`.

Day-to-day flow:

```sh
pnpm install
pnpm build      # produce build/index.js — opencode loads this
pnpm check      # verify everything before commit
```

**Pre-commit hook.** The Husky `pre-commit` hook
([`.husky/pre-commit`](./.husky/pre-commit)) runs on every commit and does
two things in order, aborting the commit on any failure:

1. Block staged lines matching `FIXME` or `TODO.*!!` scratch markers.
2. Run `pnpm check` (format + lint + typecheck + unit tests).

To bypass the hook for a WIP commit, use `git commit --no-verify` — but
re-run the full gate before pushing, since CI enforces it anyway. (The
hook needs `pnpm` on PATH; install Husky's git hooks once with
`pnpm prepare`.)

### Debugging with opencode

The plugin is *not* a standalone process. opencode imports the compiled
module, calls its default `Plugin` function, and invokes the `config`
hook at startup. Debugging therefore means: build the plugin, point a
scratch opencode project at it, start opencode with verbose logging, and
inspect the logs.

#### How the plugin loads

Two facts shape every debugging workflow:

1. opencode loads plugins **once at startup**. Any rebuild requires
   restarting opencode to pick up the change.
2. The compiled output in `build/` is self-contained. The
   `@opencode-ai/plugin` imports are type-only and erased by `tsc`, so the
   only runtime imports are the plugin's own relative modules. You can
   drop `build/` anywhere opencode can resolve it.

#### Load the plugin from a scratch project

Keep this repo as the source of truth and load it into a *separate*
scratch project so you never pollute the plugin's working tree with
session artifacts. Create the throwaway directory anywhere you like;
the examples below use a sibling of this repo:

```sh
mkdir -p ../opencode-plugin-tester && cd ../opencode-plugin-tester
```

Pick one of the two methods below.

**Method 1 — reference the local package (recommended).** This respects
the `exports`/`main` field in `package.json`, so opencode resolves
`build/index.js` automatically:

```sh
cat > opencode.json <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["file://$(cd ../opencode-agent-plugins && pwd)"]
}
EOF
```

> [!NOTE]
> `opencode.json` is the project config and lives at the **project
> root**, not under `.opencode/`. The unquoted heredoc (`<<EOF`) lets
> `$(cd ...)` expand to the absolute repo path, while the `\$schema`
> escape keeps the JSON key literal.

opencode installs plugins listed in the `plugin` array at startup and
caches them under its cache directory (`~/.cache/opencode/` on macOS/
Linux). Use the `file:///` form (three slashes): empty host followed by
the absolute path.

> **Note:** the `file:` specifier is not documented in opencode's
> official config schema, which only shows npm package names. It has
> been verified to work against opencode 1.18.x; behavior may differ on
> other versions. If it stops working, fall back to Method 2.

**Method 2 — thin loader in the plugin directory.** Local plugins are
loaded directly from `.opencode/plugins/`, and *each file* there is
treated as a separate plugin module. Because `build/` contains several
`index.js` files, do not copy the whole tree — instead add a single
loader that re-exports the compiled entry:

```sh
mkdir -p .opencode/plugins
```

`.opencode/plugins/agent-plugins.js`:

```js
export { default } from '/absolute/path/to/opencode-agent-plugins/build/index.js';
```

Either way, rebuild before each restart:

```sh
pnpm build      # in the opencode-agent-plugins repo
```

#### The debug loop

1. In one terminal, keep the compiler running against this repo:

   ```sh
   pnpm exec tsc --watch
   ```

2. In another terminal inside the scratch project, choose how you want
   to observe logs. `--log-level DEBUG` enables the plugin's
   `logger.debug(...)` calls in `src/utils/logger.ts`.

   - **Captured to a file** (recommended for plugin debugging). Run
     opencode non-interactively and redirect the log stream into the
     scratch project. `--print-logs` writes to **stderr**, so `2>`
     captures the full stream — including the plugin's DEBUG lines — to
     a file you can grep and scroll:

     ```sh
     opencode run --log-level DEBUG --print-logs \
       "list your tools" 2>./opencode.log
     ```

     All plugin output goes through `client.app.log(...)` (see
     `src/utils/logger.ts`), tagged with `service: 'opencode-agent-plugins'`.

   - **Interactive TUI**. Start opencode normally, then tail the
     on-disk log in a third terminal. `--print-logs` does **not** work
     here: the TUI owns the terminal and swallows stderr, so logs only
     land on disk (`~/.local/share/opencode/log/opencode.log`):

     ```sh
     opencode --log-level DEBUG
     tail -F ~/.local/share/opencode/log/opencode.log
     ```

3. Exercise the registered surface to confirm it loaded: configure the
   plugin in the scratch project's `opencode.json` (see README), start
   opencode, and inspect the log lines for each configured plugin source.

4. **Restart opencode** to reload the plugin after each rebuild.
   Plugins are only read at startup; there is no hot reload.

Do **not** use `console.log` for diagnostics: it is not captured by
opencode's log pipeline and will not appear in the log files. Add
temporary calls through the existing `Logger` instead.

#### Unit debugging without opencode

Most behavior can be debugged faster in Vitest than through opencode.
The suite in `src/*.test.ts` exercises the plugin against a stub SDK
client (`test/stub-client.ts`) that records every `client.app.log`
call, so no running server is needed.

```sh
pnpm test:watch
```

To inspect the effect of the `config` hook directly, reuse the pattern
from `src/index.test.ts`: call the plugin with a `stubClient()`, invoke
the returned `hooks.config(config)` with a plain `Config` object, and
assert on the mutated `config.skills` / `config.mcp` maps. To debug
interactively, run Vitest with an inspector:

```sh
pnpm exec vitest --inspect-brk
```

### Running Checks in Docker

[`Dockerfile`](./Dockerfile) is a multi-stage build that reproduces the
full local gate (`format:check`, `lint`, `typecheck`, `test`) without
needing Node, pnpm, or the `opencode` binary installed on the host. Each
gate is a stage that writes a `*-results.txt` file, and each has a
companion `FROM scratch` collector stage, so BuildKit's
`--output type=local` pulls just that result file into a local directory
instead of producing a tagged image.

Build everything and collect all result files into `./ci-output/`:

```sh
DOCKER_BUILDKIT=1 docker build --output type=local,dest=./ci-output .
```

Or run a single gate and collect only its result file:

```sh
# Lint + format + type-check
DOCKER_BUILDKIT=1 docker build --target lint-output --output type=local,dest=./ci-output .
# Unit tests
DOCKER_BUILDKIT=1 docker build --target unit-test-output --output type=local,dest=./ci-output .
```

`./ci-output/` then contains the matching `*-results.txt` file(s). A
failing gate fails the build: the `bash -o pipefail` shell propagates the
command's exit status through `tee`, so a non-zero `docker build` exit
code means that gate failed.

Notes:

- BuildKit (`# syntax=docker/dockerfile:1`) is required for the pnpm
  cache mounts and for `--output type=local`.
- `.dockerignore` excludes `build/`, `node_modules/`, and tooling
  directories so the image always starts from a clean source tree.
- `ci-output/` is gitignored (see [`.gitignore`](./.gitignore)).

## Continuous Integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push
to `main`/`master`, on `v*` tags, and on pull requests, with three jobs:

- **ci** — the full local gate (`pnpm check`: format, lint, typecheck,
  unit tests), on Ubuntu.
- **docker** — the entire quality gate built and run through the
  [`Dockerfile`](./Dockerfile) `ci-output` collector on Ubuntu. It guards
  the reproducible, host-tool-free CI path described above ("Running
  Checks in Docker") alongside the native job.
- **release** — on `v*` tags, once the other jobs pass, builds the plugin,
  packs it, and publishes a GitHub Release with auto-generated notes and
  the resulting `*.tgz`.

## Troubleshooting

Common issues and their fixes:

- **Plugin logs are empty even with `--log-level DEBUG`.** You are
  almost certainly in the TUI, where `--print-logs` is swallowed and
  logs only land on disk. Tail the on-disk log file instead
  (`~/.local/share/opencode/log/opencode.log`).

- **`console.log` output never appears.** opencode does not capture
  `console.log`. Route diagnostics through the plugin's `Logger`
  (`src/utils/logger.ts`), which writes via `client.app.log(...)`.

- **Pre-commit hook fails because pnpm is not found.** Husky runs the
  hook in a stripped environment; make sure the hook is executable
  (`chmod +x .husky/pre-commit`) and that `pnpm` is on PATH when
  committing (or install corepack shims).

- **`file://` plugin loading stops working.** The `file:` specifier for
  plugins is not in opencode's official config schema and has only been
  verified against opencode 1.18.x. If it breaks on a newer opencode,
  fall back to Method 2 (thin loader in `.opencode/plugins/`) described
  in [Load the plugin from a scratch project](#load-the-plugin-from-a-scratch-project).

- **TypeScript resolves Node built-ins (`node:url`) with errors in the
  editor but `pnpm typecheck` passes.** The editor is keying off the
  wrong tsconfig. Do not exclude `*.test.ts` from `tsconfig.json`; see
  the "TypeScript project structure" note in
  [AGENTS.md](./AGENTS.md#configuration--documentation).

- **Docker build fails on `--output type=local`.** BuildKit is required.
  Prefix the command with `DOCKER_BUILDKIT=1` (see
  [Running Checks in Docker](#running-checks-in-docker)).

- **`pnpm build` fails with TS5033 "Could not write file ... no such
  file or directory".** A stale `tsc --watch` or a leftover build
  process can fight over `build/`. Stop watchers, `pnpm clean`, and
  re-run `pnpm build`.

## Additional Resources

- [AGENTS.md](./AGENTS.md) — code guidelines, project structure, and the
  plugin surface contract.
- [README.md](./README.md) — user-facing pitch and configuration.
- [CHANGELOG.md](./CHANGELOG.md) — release history.
- [docs/design.md](./docs/design.md) — the design document: the
  specification conformance checklist, architecture, and component
  plans.
