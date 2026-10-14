# Development Guide

How to build, run, and debug the `opencode-agent-plugins` plugin against a
live opencode instance. For architecture and contribution rules, see
[AGENTS.md](./AGENTS.md); for the user-facing pitch, see
[README.md](./README.md); for the feature plan, see
[docs/explanation/design.md](./docs/explanation/design.md).

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

- **Node.js 26+** — the CLI targets Node ≥ 26; the plugin entrypoint runs
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
development. The `@opencode/plugin` package is type-only and erased by
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
  OpenCode runtime imports leaked into `build/` (the packages are type-only
  devDependencies).
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
module and calls its default `{ id, setup }` definition; `setup` registers
skills and MCP servers through the plugin context transforms. Debugging
therefore means: build the plugin, point a scratch opencode project at it,
start opencode with verbose logging, and inspect the logs.

#### How the plugin loads

Two facts shape every debugging workflow:

1. opencode V2 watches config directories and the loaded plugin's files and
   reloads the loader plugin, so a rebuild or config change is picked up on
   the next location load. A restart is still the deterministic way to
   reload after a rebuild.
2. The compiled output in `build/` is self-contained. The
   `@opencode/plugin` imports are type-only and erased by `tsc`, so the
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

**Method 1 — thin loader in `.opencode/plugins/` (recommended for V2).**
V2 auto-discovers direct `.ts`/`.js` files under `.opencode/plugins/`, and
each file is loaded as its own plugin module. Because `build/` contains
several `index.js` files, do not copy the whole tree — add a single loader
that re-exports the compiled entry:

```sh
mkdir -p .opencode/plugins
```

`.opencode/plugins/agent-plugins.js`:

```js
export { default } from '/absolute/path/to/opencode-agent-plugins/build/index.js';
```

An auto-discovered loader file takes no plugin options; to pass options,
configure the loader as a directory entry instead (Method 2).

**Method 2 — directory entry.** A configured local entry must be a plugin
*directory*; V2 2.0.16 resolves `<dir>/server.js` for directory targets, so
create that shim in the repo root first:

```sh
printf "export { default } from './build/index.js';\n" > server.js
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/opencode-agent-plugins",
      "options": { "plugins": ["./agent-plugins/my-plugin"] }
    }
  ]
}
```

> **Note:** a configured local *file* path is rejected by V2
> ("configured plugin path must be a directory"); use Method 1 for a single
> file, or a directory with the `server.js` shim. npm-name entries resolve
> through the package `main` instead.

Rebuild before reloading:

```sh
pnpm build      # in the opencode-agent-plugins repo
```

#### The debug loop

1. In one terminal, keep the compiler running against this repo:

   ```sh
   pnpm exec tsc --watch
   ```

2. In another terminal inside the scratch project, choose how you want
   to observe logs. Set `"logLevel": "debug"` in the plugin entry to
   enable the plugin's `logger.debug(...)` calls in `src/utils/logger.ts`;
   `--log-level DEBUG` raises OpenCode's own log level.

   - **Captured to a file** (recommended for plugin debugging). Run
     opencode non-interactively and redirect the log stream into the
     scratch project. `--print-logs` writes to **stderr**, so `2>`
     captures the full stream — including the plugin's DEBUG lines — to
     a file you can grep and scroll:

     ```sh
     opencode run --log-level DEBUG --print-logs \
       "list your tools" 2>./opencode.log
     ```

     All plugin output goes through the plugin's console logger (see
     `src/utils/logger.ts`), tagged with the `[opencode-agent-plugins]`
     prefix.

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

4. **Reload opencode** after each rebuild. V2 watches the loader plugin's
   files and reloads it on the next location load, but a restart is the
   deterministic way to be sure the new `build/` is what runs.

Keep diagnostics in the plugin's `Logger` (`src/utils/logger.ts`): it writes
`[opencode-agent-plugins]`-prefixed console lines that opencode captures in
`--print-logs`, with level filtering and structured metadata.

#### Unit debugging without opencode

Most behavior can be debugged faster in Vitest than through opencode.
The suite in `src/*.test.ts` exercises the plugin against a stub V2 context
(`test/stub-context.ts`) that records every transform registration and log
entry, so no running server is needed.

```sh
pnpm test:watch
```

To inspect registration directly, reuse the pattern from
`src/register.test.ts`: build a `stubContext()`, call
`registerAgentPlugins(stub.context, parsed, stub.logger)`, and assert on the
stub's `registeredSkills` / `registeredMcp` maps (the stub editor mirrors the
real one: edits build on the baseline and earlier registrations; for skills
the baseline models other plugins' registrations only — config skills are
invisible to transforms, §9.1.5 — while for MCP it also models config-defined
servers, which are visible). To debug interactively, run Vitest with an
inspector:

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
- `.dockerignore` keeps the build context lean: dependency and tooling
  directories are excluded, while `build/` is kept because the e2e image
  embeds the compiled plugin (the main Dockerfile rebuilds it anyway).
- `ci-output/` is gitignored (see [`.gitignore`](./.gitignore)).

### E2E Tests (Docker)

The e2e suite in [`test-e2e/`](./test-e2e) is the release gate from
`docs/explanation/design.md` §9.1/§9.2.4: it boots a **real opencode V2
binary** and the fixture plugin package inside a container and asserts the
plugin's transform registrations actually reach the model request.

Everything opencode-related runs in Docker — no opencode is installed on
the host:

- `test-e2e/Dockerfile` builds an image with the pinned `@opencode/cli`
  release, the plugin compiled from this repo (`build/`), the fixture
  plugins (skills + stdio/remote MCP servers), and a fake
  OpenAI-compatible model server that captures every chat-completions
  request.
- The scenario files drive the container through
  [Testcontainers](https://testcontainers.com/) (`testcontainers` npm
  package): the image is built once, `opencode serve` runs inside the
  container with its port published and a per-run
  `OPENCODE_SERVER_PASSWORD` (generated unless `E2E_SERVER_PASSWORD` is set),
  and the tests connect through the V2 client
  (`@opencode/client`) with HTTP Basic auth. A session is created with
  `session.create`, prompted with `session.prompt`, and awaited with
  `session.wait`. The fake model's first completion emits an `execute`
  tool call (V2 wraps MCP tools in Code Mode by default), so opencode runs
  the plugin's MCP server; the tests then assert on the executed tool
  result (`PLUGIN_ROOT` / `PLUGIN_DATA` / `cwd` / the eagerly created data
  dir), on the `hello` skill in `<available_skills>`, and on the pinned
  per-release behavior (the fixture contains a stray nested `SKILL.md` on
  purpose). The same assertions run against the `static` baseline — the
  equivalent native V2 config written directly into `opencode.json`.
- `test-e2e/bootstrap.mjs` is the container entrypoint (no shell in the
  image): it writes the opencode config for the mode, starts the fake model
  server in-process, and spawns `opencode serve` with its port published.
  The tests read the `CAPTURE:` lines the fake model prints.

Run it (requires a working Docker engine):

```sh
pnpm build   # the e2e image embeds the compiled plugin
pnpm test:e2e
```

The opencode release under test comes from `OPENCODE_VERSION` (default:
the `@opencode/plugin` pin in `package.json`). The e2e suite is
excluded from `pnpm test` / `pnpm check`; it runs under its own
`vitest.test-e2e.config.ts`.

## Continuous Integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push
to `main`/`master`, on `v*` tags, and on pull requests, with four jobs:

- **ci** — the full local gate (`pnpm check`: format, lint, typecheck,
  unit tests), on Ubuntu.
- **docker** — the entire quality gate built and run through the
  [`Dockerfile`](./Dockerfile) `ci-output` collector on Ubuntu. It guards
  the reproducible, host-tool-free CI path described above ("Running
  Checks in Docker") alongside the native job.
- **e2e** — the docker e2e suite (see "E2E Tests (Docker)") against the
  opencode release pinned by `OPENCODE_VERSION`, on Ubuntu (runners have
  Docker).
- **release** — on `v*` tags, once the other jobs pass, builds the plugin,
  packs it, and publishes a GitHub Release with auto-generated notes and
  the resulting `*.tgz`.

## Troubleshooting

Common issues and their fixes:

- **Plugin logs are missing.** In the TUI, `--print-logs` is swallowed and
  logs only land on disk; tail the on-disk log file instead
  (`~/.local/share/opencode/log/opencode.log`). With `opencode serve
  --print-logs`, the plugin's `[opencode-agent-plugins]` console lines
  appear in the stream.

- **A local plugin entry does not load.** V2 logs a warning ("configured
  plugin path must be a directory") for a configured local *file* path and,
  for directory targets, resolves `<dir>/server.js` (2.0.16) — use the
  `.opencode/plugins/` loader file or add the `server.js` shim described in
  [Load the plugin from a scratch project](#load-the-plugin-from-a-scratch-project).

- **MCP tools are missing from the provider's tool list.** V2 wraps MCP
  tools in Code Mode by default; they are callable as
  `tools.<server>.<tool>` inside `execute`. Pre-define the server with
  `codemode: false` to expose them natively (user config wins).

- **Pre-commit hook fails because pnpm is not found.** Husky runs the
  hook in a stripped environment; make sure the hook is executable
  (`chmod +x .husky/pre-commit`) and that `pnpm` is on PATH when
  committing (or install corepack shims).

- **`file://` plugin loading stops working.** A configured directory entry
  depends on V2's local-plugin resolution (2.0.16 needs `<dir>/server.js`);
  if it breaks on a newer opencode, fall back to Method 1 (thin loader in
  `.opencode/plugins/`) described in
  [Load the plugin from a scratch project](#load-the-plugin-from-a-scratch-project).

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
- [docs/explanation/design.md](./docs/explanation/design.md) — the design
  document: the specification conformance checklist, architecture, and
  component plans.
