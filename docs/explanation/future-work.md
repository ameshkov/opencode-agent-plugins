# Future work

This page collects open ideas. Nothing here is a commitment, a plan, or a
constraint on the current behavior. An idea moves out of this page when
someone implements it and the explanation pages are updated to match.

## Sources and store

- **npm registry sources.** Install a plugin directly from an npm
  package instead of a git URL.
- **Fetch-in-place updates.** Keep `.git` in the store and use
  `git fetch` plus a reset, instead of re-cloning and exporting. This
  trades the pristine-tree property for speed.
- **Signed and verified installs.** Record pinned commit hashes in the
  config, or use content-addressed archives, so an install can be
  reproduced and checked.
- **Shared core package.** Extract `src/lib/` into its own package if it
  gains consumers outside this repository.

## Components

- **File-based client extensions.** Support top-level namespace
  directories.
- **Per-instance overrides.** Let users disable one component without
  editing the plugin package.
- **New component types.** Add repository or other component types when
  the portable specification defines them.
- **Watch mode for path sources.** Watch a path-sourced plugin and
  re-register on change. Today an edit is picked up on the next location
  load or after a CLI reload.

## Reload

- **Standalone `reload` command.** Expose the reload as its own command
  for manual use.
- **Explicit server override.** Accept a server URL and password for a
  manually started `opencode serve` that does not write the service
  registration file.
- **Richer reload results.** Report which locations were rebuilt and
  whether skills or MCP servers changed. The endpoint reloads every
  loaded location, so the report is per location.
- **Automatic reload for `prune`.** `prune` currently never reloads
  because it removes only unreferenced entries. If it ever removes a
  referenced entry, it will need the same treatment as `remove`.

## Diagnostics

- **A `doctor` check for a stale reload registration.** Report a
  `service.json` whose PID or version no longer matches a running
  service.
- **Structured machine-readable output.** A `--json` mode for scripts.

## CLI polish batch

These deferred findings are recorded for a follow-up. None of them changes
the current behavior.

- `check` exits 0 for a moved tag while the reference says exit 2.
- `prune` messages name the wrong config or prompt set.
- `update` and `check` on a configured path source silently do nothing.
- Dry-run fidelity: `remove` ignores a corrupted entry, and `install` skips
  the loader-entry warning.
- The runtime-import gate allowlist is a prefix, not an exact match.
- `expandPlaceholders` expands `${PLUGIN_DATA}` again inside an inserted
  root.
- An unreadable `mcp.json` is treated as absent.
- `doctor` and `prune` miss a stale `.old`-only tree and an orphan `meta/`.
- A successful `update` returns `update-available` with the old
  `installedCommit`.
- A relative path source installed with `--config` or `--global` is
  validated against the cwd but registered as-is.
- Docs: the injective-slug claim, the CLI-test coverage claim, and the
  configured path sources in `check`/`update` need correction.
- Config backups and atomic writes lose the file mode.
- `reloadOpenCode` is tagged `@internal` even though `reloadAfter` uses it
  in production.
- `doctor` audits a relative `--config` twice: the selected config and the
  cwd project config resolve to the same file under different paths.

## Packaging

- **A multi-package workspace.** Reconsider it if the core gains
  independent consumers.
- **Smaller published payload.** Split the plugin and CLI build outputs
  if the runtime dependency on `@opencode/client` becomes a problem for
  plugin-only users.
