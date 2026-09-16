# CLI reference

`opencode-agent-plugins` manages the Agent Plugins client store and the
OpenCode configuration. It runs on Node.js >= 26, outside OpenCode, and is
invoked with `npx`:

```sh
npx opencode-agent-plugins <command> [args] [options]
```

## Commands

| Command | Description |
| --- | --- |
| `install <source> [--ref <ref>] [--global \| --config <path>] [--yes] [--dry-run] [--no-register]` | Fetches the source, validates it, previews the skills and MCP servers that would be registered, and registers the source in the OpenCode config. |
| `remove <name> [--keep-data] [--yes] [--dry-run]` | Unregisters the plugin and deletes its store entry and `PLUGIN_DATA`; `--keep-data` keeps the data directory. |
| `check [<name>...]` | Read-only update check over the recorded refs; no names means all installed plugins. Exits with code 2 when an update is available. |
| `update [<name>...] [--yes] [--force] [--dry-run]` | Applies available updates (stage, validate, atomic swap); `--force` follows a moved tag, `--dry-run` prints the plan without writing. |
| `list` | Lists the plugins in the client store: URL, ref/subdir, resolved commit, manifest version, and status. |
| `doctor` | Read-only health report of store/config drift. Exits with code 2 when issues are found. |
| `prune [--yes]` | Removes what `doctor` reports as orphaned or stale; never removes anything referenced by a config entry. |

## Options

| Option | Used by | Description |
| --- | --- | --- |
| `--yes` | `install`, `remove`, `update`, `prune` | Skips confirmation prompts. For `install`, the loader entry is added automatically with a warning when it is missing. |
| `--dry-run` | `install`, `remove`, `update` | Prints the plan without changing anything on disk. |
| `--global` / `--config <path>` | all commands except `list` | Selects the OpenCode config: the project `opencode.json` by default, `--global` for `~/.config/opencode/opencode.json`, or an explicit file. `install` and `remove` edit it; the other commands use it to resolve path sources and store references. |
| `--ref <ref>` | `install` | Installs at the given git ref instead of the source's `#ref` or the remote `HEAD`. |
| `--no-register` | `install` | Installs without editing the config; prints the snippet to add manually. |
| `--keep-data` | `remove` | Keeps `PLUGIN_DATA`. |
| `--force` | `update` | Follows a moved tag. |

## Config edits

`install` and `remove` edit the `plugin` array of the resolved config. The
edit is JSONC-preserving: comments and formatting outside the array stay
intact. If both `opencode.json` and `opencode.jsonc` exist in the target
scope, the `.jsonc` file wins and the CLI says so; if neither exists, it
creates `opencode.json`. Writes are atomic and backed up under `backups/` in
the client store.

## Statuses

`check` and `list` report one of the following per plugin:

| Status | Meaning |
| --- | --- |
| `up-to-date` (shown as `current` in `list`) | The recorded ref still resolves to the installed commit. |
| `update-available` | The recorded branch or `HEAD` ref resolves to a new commit. |
| `pinned` | The plugin is installed from a commit SHA; there is nothing to update. |
| `moved-tag` | The recorded tag was moved; `update` refuses to follow it without `--force`. |
| `unreachable` | The remote ref could not be resolved (network, authentication, or missing `git`). |
| `corrupted` | The store entry is unreadable or missing metadata. |
| `local-path` | `check` reports a path-sourced plugin; update it by editing the source. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command completed successfully. |
| `1` | The command failed, was aborted, or `update` applied no updates. |
| `2` | `check` found an available update, or `doctor` found issues. |
