# Configuration reference

## Plugin entry

OpenCode loads Agent Plugins through one `opencode-agent-plugins` entry in
the `plugin` array of its config — the project `opencode.json`, or
`~/.config/opencode/opencode.json` when registered globally:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-agent-plugins", {
      "plugins": ["./agent-plugins/my-plugin"]
    }]
  ]
}
```

Use a single entry with an array of sources. OpenCode loads duplicate npm
packages only once, so a second `opencode-agent-plugins` entry is silently
ignored. The `install` command registers sources in this entry and can add
the entry itself when the config has none.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `plugins` | `string \| string[]` | — | Plugin source(s): local path, git URL, or an installed plugin name. Required. |
| `prefix` | `boolean` | `false` | Namespace MCP server names as `<plugin-name>-<server>` to avoid cross-plugin collisions. Applies to all sources in this entry. |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Minimum level forwarded to `client.app.log`. |

Unknown option keys produce a warning and are ignored.

## Plugin sources

Each entry in `plugins` is one of:

- **Local path** — absolute, `~/...`, or relative to the workspace directory.
  Used in place and never copied into the store, so edits to the directory
  are picked up on the next OpenCode start. Install one with
  `npx opencode-agent-plugins install ./agent-plugins/my-plugin`.
- **Git URL** — `https://...`, `git+https://...`, `ssh://...`,
  `git+ssh://...`, or the scp-like `git@host:path` form, with an optional
  `#fragment`: a `#ref` pin (`#v1.2.0`, `#main`, `#<commit-sha>`), a
  monorepo subpath (`#v1.2.0:packages/linter`, `#:apps/research`), or both.
  Without a `#ref`, the remote's `HEAD` at install time is used. Each
  selected subdir gets its own store entry and `PLUGIN_DATA`. Git sources
  must be installed with the CLI first; at startup they resolve against the
  local store and are skipped with a warning if not installed.
- **Installed name** — the manifest name or store slug of a plugin already
  installed via the CLI.

## The client store

Git-sourced plugins are installed into the client store:

```text
<data-home>/opencode/agent-plugins/
├── installed/<slug>/   # exported plugin tree (repo root or subdir, no .git)
├── meta/<slug>.json    # client metadata (URL, ref, subdir, resolved commit, ...)
├── data/<key>/         # PLUGIN_DATA directories
└── backups/            # timestamped backups of config edits
```

`<data-home>` follows OpenCode's data-dir convention: `$XDG_DATA_HOME` when
set, else `~/.local/share` on Linux/macOS and `%LOCALAPPDATA%` on Windows.
`PLUGIN_DATA` lives outside the installed tree, so it survives updates.
A subpath source exports only the selected subdirectory; slug, metadata, and
`PLUGIN_DATA` are per subdir, so two plugins of one monorepo install side by
side.

See the [CLI reference](./cli.md) for installing, updating, and removing
sources.
