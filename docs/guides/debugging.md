# Debug the plugin in a live OpenCode

The plugin is not a standalone process: OpenCode imports the compiled
module and calls its default `{ id, setup }` definition, and `setup`
registers skills and MCP servers through the plugin context transforms.
Debugging therefore means: build the plugin, point a scratch OpenCode
project at it, start OpenCode with verbose logging, and inspect the logs.

## Before you start

- A compiled plugin: run `pnpm build` in this repository (see
  [DEVELOPMENT.md](../../DEVELOPMENT.md) for the commands).
- OpenCode 2 installed (the plugin is verified against the release pinned
  in `package.json`).
- A scratch project directory, separate from this repository, so session
  artifacts never pollute the plugin's working tree. The examples below
  use a sibling of this repo:

  ```sh
  mkdir -p ../opencode-plugin-tester && cd ../opencode-plugin-tester
  ```

Two facts shape every debugging workflow:

1. OpenCode V2 watches config directories and the loaded plugin's files
   and reloads the loader plugin, so a rebuild or config change is picked
   up on the next location load. A restart is still the deterministic way
   to reload after a rebuild.
2. The compiled output in `build/` is self-contained: the
   `@opencode/plugin` imports are type-only and erased by `tsc`, so you
   can drop `build/` anywhere OpenCode can resolve it.

## Load the plugin from a scratch project

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
*directory*; V2 2.0.16 resolves `<dir>/server.js` for directory targets,
so create that shim in the repository root first:

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
> ("configured plugin path must be a directory"); use Method 1 for a
> single file, or a directory with the `server.js` shim. npm-name entries
> resolve through the package `main` instead.

## The debug loop

1. In one terminal, keep the compiler running against this repository:

   ```sh
   pnpm exec tsc --watch
   ```

2. In another terminal inside the scratch project, choose how to observe
   logs. Set `"logLevel": "debug"` in the plugin entry to enable the
   plugin's `logger.debug(...)` calls; `--log-level DEBUG` raises
   OpenCode's own log level.

   - **Captured to a file** (recommended for plugin debugging). Run
     OpenCode non-interactively and redirect the log stream into the
     scratch project. `--print-logs` writes to **stderr**, so `2>`
     captures the full stream — including the plugin's DEBUG lines — to a
     file you can grep and scroll:

     ```sh
     opencode run --log-level DEBUG --print-logs \
       "list your tools" 2>./opencode.log
     ```

     All plugin output goes through the plugin's console logger, tagged
     with the `[opencode-agent-plugins]` prefix.

   - **Interactive TUI**. Start OpenCode normally, then tail the on-disk
     log in a third terminal. `--print-logs` does **not** work here: the
     TUI owns the terminal and swallows stderr, so logs only land on disk
     (`~/.local/share/opencode/log/opencode.log`):

     ```sh
     opencode --log-level DEBUG
     tail -F ~/.local/share/opencode/log/opencode.log
     ```

3. Exercise the registered surface to confirm it loaded: configure the
   plugin in the scratch project's `opencode.json`, start OpenCode, and
   inspect the log lines for each configured plugin source.

4. Reload OpenCode after each rebuild. V2 watches the loader plugin's
   files and reloads it on the next location load, but a restart is the
   deterministic way to be sure the new `build/` is what runs.

Keep diagnostics in the plugin's `Logger` (`src/utils/logger.ts`): it
writes `[opencode-agent-plugins]`-prefixed console lines that OpenCode
captures in `--print-logs`, with level filtering and structured metadata.

## Debug without OpenCode (unit level)

Most behavior can be debugged faster in Vitest than through OpenCode. The
suite in `src/*.test.ts` exercises the plugin against a stub V2 context
(`test/stub-context.ts`) that records every transform registration and log
entry, so no running server is needed:

```sh
pnpm test:watch
```

To inspect registration directly, reuse the pattern from
`src/register.test.ts`: build a `stubContext()`, call
`registerAgentPlugins(stub.context, parsed, stub.logger)`, and assert on
the stub's `registeredSkills` / `registeredMcp` maps. The stub editor
mirrors the real one: edits build on the baseline and earlier
registrations; for skills the baseline models other plugins'
registrations only — config skills are invisible to transforms — while
for MCP it also models config-defined servers, which are visible. To
debug interactively, run Vitest with an inspector:

```sh
pnpm exec vitest --inspect-brk
```

## Troubleshooting

- **Plugin logs are missing.** In the TUI, `--print-logs` is swallowed
  and logs only land on disk; tail the on-disk log file instead
  (`~/.local/share/opencode/log/opencode.log`). With `opencode serve
  --print-logs`, the plugin's `[opencode-agent-plugins]` console lines
  appear in the stream.

- **A local plugin entry does not load.** V2 logs a warning ("configured
  plugin path must be a directory") for a configured local *file* path
  and, for directory targets, resolves `<dir>/server.js` (2.0.16) — use
  the `.opencode/plugins/` loader file or add the `server.js` shim
  described above.

- **MCP tools are missing from the provider's tool list.** V2 wraps MCP
  tools in Code Mode by default; they are callable as
  `tools.<server>.<tool>` inside `execute`. Pre-define the server with
  `codemode: false` to expose them natively (user config wins).

- **A plugin's MCP server does not appear in `opencode mcp list`.** That
  command lists servers configured in OpenCode's own config; plugin
  registrations are registry entries and appear only through the server
  API (`mcp.list`) and the plugin's own log lines. Use the tools to
  verify the server.

- **`file://` plugin loading stops working.** A configured directory entry
  depends on V2's local-plugin resolution (2.0.16 needs `<dir>/server.js`);
  if it breaks on a newer OpenCode, fall back to Method 1.

- **TypeScript resolves Node built-ins (`node:url`) with errors in the
  editor but `pnpm typecheck` passes.** The editor is keying off the wrong
  tsconfig; see the "TypeScript project structure" section of the
  [code conventions reference](../reference/code-conventions.md).

- **`pnpm build` fails with TS5033 "Could not write file ... no such file
  or directory".** A stale `tsc --watch` or a leftover build process can
  fight over `build/`. Stop watchers, `pnpm clean`, and re-run
  `pnpm build`.

## Related

- [E2E testing](./e2e-testing.md) — verify behavior against a real
  OpenCode in Docker instead of a local one.
- [`docs/explanation/design.md`](../explanation/design.md) §9 — the
  testing strategy and the empirical findings this workflow relies on.
- [AGENTS.md](../../AGENTS.md) — code guidelines.
