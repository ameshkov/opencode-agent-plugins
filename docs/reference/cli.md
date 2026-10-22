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
| `install <source> [--ref <ref>] [--global \| --config <path>] [--yes] [--dry-run] [--no-register] [--no-reload]` | Fetches the source, validates it, previews the skills and MCP servers that would be registered, and registers the source in the OpenCode config. |
| `remove <name> [--keep-data] [--yes] [--dry-run] [--no-reload] [--global \| --config <path>]` | Unregisters the plugin and deletes its store entry and `PLUGIN_DATA`; `--keep-data` keeps the data directory. |
| `check [<name>...] [--global \| --config <path>]` | Read-only update check over the recorded refs; no names means all installed plugins. Names match a store slug or manifest name. Exits with code 2 when an update is available. |
| `update [<name>...] [--yes] [--force] [--dry-run] [--no-reload] [--global \| --config <path>]` | Applies available updates (stage, validate, atomic swap); names match a store slug or manifest name. `--force` follows a moved tag, `--dry-run` prints the plan without writing. An unknown name exits with code 1. |
| `list` | Lists the plugins in the client store: manifest name (or slug), URL, ref/subdir, resolved commit, manifest version, and status. An entry with missing, unreadable, or wrong-shaped metadata prints `<slug>  [corrupted: missing metadata]`. |
| `doctor [--global \| --config <path>]` | Read-only health report of store/config drift. Exits with code 2 when issues are found. |
| `prune [--yes] [--global \| --config <path>]` | Removes what `doctor` reports as orphaned or stale; never removes anything referenced by an audited config. Refuses to prune when the selected config, an existing global config, or the cwd project config (with `--global` or `--config`) cannot be read, or a configured source does not resolve. |

## Options

| Option | Used by | Description |
| --- | --- | --- |
| `--yes` | `install`, `remove`, `update`, `prune` | Skips the confirmation prompt for `install`, `remove`, and `prune`. For `update`, suppresses the preview and applies the updates. For `install`, the loader entry is added automatically with a warning when it is missing. |
| `--dry-run` | `install`, `remove`, `update` | Prints the plan without changing anything on disk. For `remove`, the plan lists the installed tree, metadata file, and `PLUGIN_DATA` unless `--keep-data` is given. |
| `--global` / `--config <path>` | all commands except `list` | Selects the OpenCode config: the project `opencode.json` by default, `--global` for the global config (`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`), or an explicit file. `install` and `remove` edit it; the other commands use it to resolve path sources and store references. `doctor` and `prune` also audit the global config and, with `--global` or `--config`, the cwd project config. |
| `--ref <ref>` | `install` | Installs at the given git ref instead of the source's `#ref` or the remote `HEAD`. |
| `--no-register` | `install` | Installs without editing the config; prints the snippet to add manually and a hint to restart after adding it. |
| `--keep-data` | `remove` | Keeps `PLUGIN_DATA`. |
| `--force` | `update` | Follows a moved tag. |
| `--no-reload` | `install`, `remove`, `update` | Does not reload a running OpenCode after the change. The command prints the restart hint instead. |

## Config edits

`install` and `remove` edit the `plugins` array of the resolved config — the
`{ "package": "opencode-agent-plugins", "options": { … } }` entry. A legacy
V1 `["opencode-agent-plugins", {…}]` tuple is read, migrated by `install`,
and removed when its last source is removed. The edit is JSONC-preserving:
comments and formatting outside the plugin arrays stay intact. If both
`opencode.json` and `opencode.jsonc` exist in the target scope, the `.jsonc`
file wins and the CLI says so; if neither exists, it creates
`opencode.json`. Writes are atomic and backed up under `backups/` in the
client store.

## Reload

After an `install`, a `remove`, or an `update` that applies at least one
change, the CLI reloads a running OpenCode through its local service API.
`--no-reload` skips the call. A no-op `update` does not reload. If no
service is found or the call fails, the CLI prints the command's restart
hint. The reload never changes the command's exit code: a mixed `update`
still exits 1 when another selected update failed. `--dry-run` never
reloads. `--no-register` never reloads and prints
`Add the config snippet above, then restart OpenCode to use it.` `check`,
`list`, `doctor`, and `prune` never reload.

The mechanism, discovery, and failure modes are described in
[Changes and reload](../explanation/changes-and-reload.md).

## Doctor and prune

`doctor` audits the selected config and the global config together. When
the selected config is the global config or a custom file, it also audits
the cwd project config as a known file. It does not discover other project
configs. It resolves each source like startup: a local path first (relative
to the location directory, not the config file's directory), then a store
slug, then a manifest name. The location directory is the project cwd; with
`--global` or `--config` it is the process cwd.

A `config-missing` finding means a config that had to be read is missing,
unreadable, or not valid JSONC. The selected config is always required; the
global config and the cwd project config are optional, but an unreadable
one is also reported.

`prune` removes only what no audited config references. When a config
cannot be read or parsed, or a configured source cannot be resolved to a
slug or data key, the references are incomplete: `prune` refuses to delete
anything and exits with code 1. This applies to the selected config, an
existing global config, and the cwd project config audited with `--global`
or `--config`.

## Statuses

`check` and `list` report one of the following per plugin. `list` reports
the store-entry subset; `local-path` is `check`-only.

| Status | Meaning |
| --- | --- |
| `up-to-date` (shown as `current` in `list`) | The recorded ref still resolves to the installed commit. |
| `update-available` | The recorded branch or `HEAD` ref resolves to a new commit. |
| `pinned` | The plugin is installed from a commit SHA; there is nothing to update. |
| `moved-tag` | The recorded tag was moved; `update` refuses to follow it without `--force`. |
| `unreachable` | The remote ref could not be resolved (network, authentication, or missing `git`). |
| `corrupted` | The store entry metadata is missing, unreadable, or has the wrong shape. |
| `local-path` | `check` reports a path-sourced plugin; update it by editing the source. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command completed successfully. `update` also exits 0 when nothing needs an update. |
| `1` | The command failed, was aborted, used an unknown `check` or `update` name, or refused to prune incomplete config references. |
| `2` | `check` found an available update, or `doctor` found issues. |
