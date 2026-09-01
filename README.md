# opencode-agent-plugins

[![CI](https://github.com/ameshkov/opencode-agent-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/ameshkov/opencode-agent-plugins/actions/workflows/ci.yml)

<p align="center">
    An Agent Plugins client for OpenCode.
</p>

`opencode-agent-plugins` is an [OpenCode](https://opencode.ai) plugin that acts
as a conformant **Agent Plugins client**: it loads a plugin package — a
directory containing `plugin.json`, optionally `skills/` and `mcp.json` —
validates it against the
[Agent Plugins specification](https://agent-plugins.org/specification), and
registers its components into OpenCode:

- **Skills** — registered via `config.skills.paths`, so plugin skills appear
  in the `skill` tool with no file copies.
- **MCP servers** — translated from the portable `mcp.json` format into
  OpenCode's native `config.mcp` entries (`stdio` → local, remote transports
  → remote).
- **`PLUGIN_ROOT` / `PLUGIN_DATA`** — provided to stdio subprocess
  environments, with a client-managed persistent data directory per plugin
  instance.

Beyond the plugin, the package ships a **CLI** (`opencode-agent-plugins`) that
manages the plugin lifecycle: install (from a local path or a git URL),
remove, check for updates, update, list, and store hygiene (`doctor`/`prune`).

> [!NOTE]
> The plugin registers components at **OpenCode startup**: the `config` hook
> resolves each configured source (local paths in place, git sources against
> the client store — never fetching), validates the package against the
> [Agent Plugins specification](https://agent-plugins.org/specification),
> creates `PLUGIN_DATA`, and mutates the live config. User-authored config
> always wins: a pre-existing `mcp` entry or `skills.paths` entry that
> collides with a plugin registration is left untouched. The CLI is the only
> network-touching surface (`install`/`check`/`update`); see
> [`docs/design.md`](./docs/design.md) for the full contract.

## Install

Add the plugin to your `opencode.json` (or `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-agent-plugins", {
      "plugins": [
        "./agent-plugins/my-plugin",
        "git+https://github.com/org/my-plugin.git#v1.2.0"
      ]
    }]
  ]
}
```

Options (all optional except `plugins`):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `plugins` | `string \| string[]` | — | Plugin source(s): local path, git URL, or an installed plugin name. Required. |
| `prefix` | `boolean` | `false` | Namespace MCP server names to avoid cross-plugin collisions. |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Minimum level forwarded to `client.app.log`. |

Restart OpenCode to load the plugin — registrations are applied at startup.

## The CLI

`opencode-agent-plugins` manages installed plugins:

```sh
opencode-agent-plugins install git+https://github.com/org/my-plugin.git#v1.2.0
opencode-agent-plugins list
opencode-agent-plugins update
opencode-agent-plugins doctor
```

Run `opencode-agent-plugins --help` for the full command reference.

## Additional Resources

- [`docs/design.md`](./docs/design.md) — the design document: specification
  conformance requirements, architecture, and the component plan.
- [AGENTS.md](./AGENTS.md) — code guidelines, project structure, and the
  plugin surface contract.
- [DEVELOPMENT.md](./DEVELOPMENT.md) — build and debug guide.
- [CHANGELOG.md](./CHANGELOG.md) — release history.
