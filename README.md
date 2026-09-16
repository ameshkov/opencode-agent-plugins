# opencode-agent-plugins

[![CI](https://github.com/ameshkov/opencode-agent-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/ameshkov/opencode-agent-plugins/actions/workflows/ci.yml)

An Agent Plugins client for [OpenCode](https://opencode.ai): loads, validates,
and registers [Agent Plugins](https://agent-plugins.org/specification)
packages, turning their skills and MCP servers into OpenCode capabilities.

## What it is

An Agent Plugin is a portable, self-contained package that bundles agent
capabilities: a directory with a `plugin.json` manifest, optionally a
`skills/` directory and an `mcp.json` file.

`opencode-agent-plugins` has two parts:

- **An OpenCode plugin** that runs at OpenCode startup: it resolves each
  configured source, validates the package against the specification, and
  registers its skills and MCP servers into OpenCode's live config. `stdio`
  MCP servers receive `PLUGIN_ROOT` and a persistent `PLUGIN_DATA` directory;
  `streamable-http` servers become remote entries; unsupported `sse` servers
  are skipped with a warning.
- **A CLI** that installs, updates, and removes plugin sources and manages
  the client store.

## Getting started

### Prerequisites

- [OpenCode](https://opencode.ai) installed.
- Node.js >= 26 (for the CLI).
- `git` on the `PATH` for the git-backed commands (`install` from a URL,
  `check`, `update`) and for `list`'s status column. `remove`, `doctor`,
  `prune`, and path-sourced `install` work without it, and `list` still
  completes and reports git-sourced plugins as `unreachable`.

### Install the CLI

The CLI ships in the `opencode-agent-plugins` npm package. Run it with
`npx` — no global install is required:

```sh
npx opencode-agent-plugins --help
```

### Install a plugin

This example installs the [Context7](https://github.com/upstash/context7)
plugin from a subpath of its repository:

```sh
npx opencode-agent-plugins install \
  https://github.com/upstash/context7.git#:plugins/agent-plugins/context7
```

The CLI fetches the source, validates it, and previews the skills and MCP
servers that would be registered — including the commands stdio servers will
run and the URLs remote servers will talk to. On confirmation it registers
the source in your OpenCode config, adding the `opencode-agent-plugins`
loader entry first if the config has none (declining aborts the install;
`--yes` auto-adds it without prompting).

### Restart OpenCode

Registrations are applied at startup. After restarting, plugin skills appear
in the available skills list and MCP tools are available as
`<server-name>_*` tools (gate them with `tools: { "server-name_*": false }`
or per-agent overrides as usual). Diagnostics are logged via
`client.app.log` with `service: "opencode-agent-plugins"`.

## Managing plugins

The plugin never fetches at startup; installs, updates, and removals all go
through the CLI. To check for updates:

```sh
npx opencode-agent-plugins check
```

`check` is read-only: it resolves each recorded ref remotely and reports
`up-to-date`, `update-available`, `pinned`, or `unreachable` per plugin. It
exits with code 2 when an update is available, so it also works in scripts.
Apply the updates with:

```sh
npx opencode-agent-plugins update
```

`update` stages each new revision, validates it, swaps it into the store
atomically, and leaves `PLUGIN_DATA` untouched. Add `--dry-run` to print the
plan without writing anything, or `--force` to follow a moved tag. Restart
OpenCode to pick up the change.

Other commands:

- `npx opencode-agent-plugins list` — show installed plugins and their
  status.
- `npx opencode-agent-plugins remove <name>` — unregister and delete a
  plugin.
- `npx opencode-agent-plugins doctor` — read-only store/config health report.
- `npx opencode-agent-plugins prune` — remove what `doctor` reports as
  orphaned.

## Configuration

The plugin entry, options, source syntax, and store layout are documented in
the [configuration reference](./docs/reference/configuration.md).

## Documentation

- [Configuration reference](./docs/reference/configuration.md) — the plugin
  entry, options, sources, and the client store.
- [CLI reference](./docs/reference/cli.md) — commands, flags, statuses, and
  exit codes.
- [`docs/explanation/design.md`](./docs/explanation/design.md) — the design
  document: specification conformance requirements, architecture, and the
  full behavior contract.
- [DEVELOPMENT.md](./DEVELOPMENT.md) — build and debug guide.
- [CHANGELOG.md](./CHANGELOG.md) — release history.
- [AGENTS.md](./AGENTS.md) — code guidelines, project structure, and the
  plugin surface contract.
