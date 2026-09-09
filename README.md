# opencode-agent-plugins

[![CI](https://github.com/ameshkov/opencode-agent-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/ameshkov/opencode-agent-plugins/actions/workflows/ci.yml)

An Agent Plugins client for [OpenCode](https://opencode.ai).

## What it is

`opencode-agent-plugins` lets OpenCode load
[Agent Plugins](https://agent-plugins.org/specification) — portable,
self-contained packages that bundle agent capabilities. A plugin package is a
directory containing a `plugin.json` manifest, optionally a `skills/`
directory and an `mcp.json` file.

The package has two parts:

- **An OpenCode plugin** that runs at OpenCode startup. It resolves each
  configured plugin source, validates the package against the Agent Plugins
  specification, and registers its components into OpenCode's live config:
    - **Skills** — registered via `config.skills.paths`, so plugin skills
      appear in the `skill` tool with no file copies.
    - **MCP servers** — translated from the portable `mcp.json` format into
      OpenCode's native `config.mcp` entries (`stdio` becomes a local server,
      remote transports become remote servers).
    - **`PLUGIN_ROOT` / `PLUGIN_DATA`** — provided to stdio subprocess
      environments, with a client-managed persistent data directory per
      plugin instance.
- **A CLI** (`opencode-agent-plugins`) that manages the plugin lifecycle:
  install from a local path or a git URL, remove, check for updates, update,
  list installed plugins, and store hygiene (`doctor` / `prune`).

Key properties:

- **No network access at startup.** Git sources resolve against the local
  client store; installing and updating is exclusively the CLI's job.
- **User config always wins.** A pre-existing `mcp` entry or `skills.paths`
  entry that collides with a plugin registration is left untouched; the
  plugin's registration is skipped and reported. This is also your escape
  hatch: define an entry yourself under the same name to override the plugin.
- **Failure isolation.** A broken plugin never breaks OpenCode startup — the
  offending component is skipped and logged, everything else still loads.

## Getting started

### Prerequisites

- [OpenCode](https://opencode.ai) installed.
- Node.js >= 26 (for running the CLI).
- `git` on the `PATH` — only needed for git-backed CLI commands
  (`install` from a URL, `check`, `update`).

### 1. Install an Agent Plugin

Use the CLI to install a plugin package from a git URL or a local path:

```sh
opencode-agent-plugins install git+https://github.com/org/my-plugin.git#v1.2.0
```

The CLI fetches the source, validates it, previews the skills and MCP servers
that would be registered (including the commands stdio servers will run and
the URLs remote servers will talk to), asks for confirmation, and registers
the source in your OpenCode config.

The CLI also writes the `opencode-agent-plugins` loader entry for you: when
your config has no such entry yet, it warns and asks whether to add it before
registering anything (declining aborts the install; `--yes` auto-adds it
without prompting).

### 2. (Optional) Add the plugin to OpenCode by hand

The CLI handles this on `install` as described above, so this step is only
needed if you prefer to author the config yourself:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-agent-plugins", {
      "plugins": []
    }]
  ]
}
```

Use a single entry with an array of sources — OpenCode loads duplicate npm
packages only once, so a second `opencode-agent-plugins` entry would be
silently ignored.

### 3. (Developer workflow) Point `plugins` at a local directory

Path sources are used in place, so edits to the directory are picked up on
the next OpenCode start:

```jsonc
["opencode-agent-plugins", {
  "plugins": ["./agent-plugins/my-plugin"]
}]
```

The same works per command: `opencode-agent-plugins install ./agent-plugins/my-plugin`
registers the local directory instead of a git URL.

### 4. Restart OpenCode

Registrations are applied at startup. After restarting, plugin skills appear
in the available skills list, and MCP tools are available as
`<server-name>_*` tools (gate them with `tools: { "server-name_*": false }`
or per-agent overrides as usual).

Diagnostics are logged via `client.app.log` with
`service: "opencode-agent-plugins"`; `opencode debug config` shows the final
merged `mcp` / `skills` state.

## Configuration

All options live in the single plugin entry:

```jsonc
["opencode-agent-plugins", {
  "plugins": ["./agent-plugins/my-plugin", "git@github.com:org/other.git"],
  "prefix": false,
  "logLevel": "info"
}]
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `plugins` | `string \| string[]` | — | Plugin source(s): local path, git URL, or an installed plugin name. Required. |
| `prefix` | `boolean` | `false` | Namespace MCP server names as `<plugin-name>-<server>` to avoid cross-plugin collisions. Applies to all sources in this entry. |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Minimum level forwarded to `client.app.log`. |

Unknown option keys produce a warning.

### Plugin sources

Each entry in `plugins` is one of:

- **Local path** — absolute, `~/...`, or relative to the workspace directory.
  Used in place; never copied into the store.
- **Git URL** — `https://...`, `git+https://...`, `ssh://...`,
  `git+ssh://...`, or the scp-like `git@host:path` form, with an optional
  `#ref` pin (`#v1.2.0`, `#main`, `#<commit-sha>`). Without a `#ref`, the
  remote's `HEAD` at install time is used. Git sources must be installed with
  the CLI first; at startup they resolve against the local store and are
  skipped with a warning if not installed.
- **Installed name** — the manifest name or store slug of a plugin already
  installed via the CLI.

### The client store

Git-sourced plugins are installed into the client store:

```text
<data-home>/opencode/agent-plugins/
├── installed/<slug>/   # exported plugin tree at the pinned commit (no .git)
├── meta/<slug>.json    # client metadata (URL, ref, resolved commit, ...)
├── data/<key>/         # PLUGIN_DATA directories
└── backups/            # timestamped backups of config edits
```

`<data-home>` follows OpenCode's data-dir convention: `$XDG_DATA_HOME` when
set, else `~/.local/share` on Linux/macOS and `%LOCALAPPDATA%` on Windows.
`PLUGIN_DATA` lives outside the installed tree, so it survives updates.

## CLI reference

```sh
opencode-agent-plugins <command> [options]
```

| Command | What it does |
| --- | --- |
| `install <source> [--ref <ref>] [--global \| --config <path>] [--yes] [--dry-run] [--no-register]` | Fetches, validates, and previews a plugin, then registers it in the OpenCode config. |
| `remove <name> [--keep-data] [--yes]` | Unregisters the plugin from the config and deletes its store entry and `PLUGIN_DATA` (kept with `--keep-data`). |
| `check [<name>...]` | Read-only update check; no names means all installed plugins. |
| `update [<name>...] [--yes] [--force]` | Applies available updates; `--force` follows a moved tag. |
| `list` | Shows installed plugins: source, URL/ref, resolved commit, manifest version, status. |
| `doctor` | Read-only health report: config entries with no store entry, unreferenced store entries, orphaned data dirs, stale swap leftovers. |
| `prune [--yes]` | Removes what `doctor` reports as orphaned or stale. |

Common flags:

- `--yes` — skip confirmation prompts (for scripts and CI). When `install`
  needs to add the `opencode-agent-plugins` loader entry to the config, it is
  added automatically with a warning.
- `--dry-run` — print the plan without changing anything on disk.
- `--global` / `--config <path>` — choose which OpenCode config `install`
  edits: the project `opencode.json` by default, `--global` for
  `~/.config/opencode/opencode.json`, or an explicit file. Edits are
  JSONC-preserving (comments and formatting stay intact), written atomically,
  and backed up in the store's `backups/` directory.
- `--no-register` — install without touching the config; prints the snippet
  to add manually.

Run `opencode-agent-plugins --help` for the full command reference. After
`install`, `update`, or `remove`, restart OpenCode to apply the change.

## Additional resources

- [Agent Plugins specification](https://agent-plugins.org/specification) —
  the package format this client conforms to.
- [`docs/design.md`](./docs/design.md) — the design document: specification
  conformance requirements, architecture, and the full behavior contract.
- [AGENTS.md](./AGENTS.md) — code guidelines, project structure, and the
  plugin surface contract.
- [DEVELOPMENT.md](./DEVELOPMENT.md) — build and debug guide.
- [CHANGELOG.md](./CHANGELOG.md) — release history.
