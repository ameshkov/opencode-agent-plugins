# opencode-agent-plugins

[![CI](https://github.com/ameshkov/opencode-agent-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/ameshkov/opencode-agent-plugins/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-agent-plugins)](https://www.npmjs.com/package/opencode-agent-plugins)

An Agent Plugins client for [OpenCode](https://opencode.ai): loads,
validates, and registers [Agent Plugins](https://agent-plugins.org/specification)
packages, turning their skills and MCP servers into OpenCode capabilities.

## Description

An Agent Plugin is a portable, self-contained package that bundles agent
capabilities: a directory with a `plugin.json` manifest, optionally a
`skills/` directory and an `mcp.json` file. `opencode-agent-plugins` lets
OpenCode use such packages as-is, without converting them to OpenCode's
native configuration.

The package has two parts:

- **An OpenCode V2 plugin** that runs at OpenCode startup: it resolves
  each configured source, validates the package against the specification,
  and registers its skills and MCP servers through OpenCode's plugin
  context. `stdio` MCP servers receive `PLUGIN_ROOT` and a persistent
  `PLUGIN_DATA` directory; `streamable-http` servers become remote entries;
  unsupported `sse` servers are skipped with a warning. MCP tools are
  available through Code Mode by default, like natively-configured
  servers. User-authored configuration always wins: a colliding name is
  never overwritten, and the host keeps the user entry. An MCP collision
  is reported as a warning and the plugin's entry is skipped; a skill
  collision with user config is invisible to transforms and is not
  reported by the client.
- **A CLI** that installs, updates, and removes plugin sources and
  manages the client store.

## Installation

The CLI ships in the `opencode-agent-plugins` npm package. Run it with
`npx` — no global install is required:

```sh
npx opencode-agent-plugins --help
```

Requirements: OpenCode 2 (the client is verified against the release
pinned in `package.json`), Node.js >= 26 for the CLI, and `git` for the
git-backed commands (`install` from a URL, `check`, `update`).

## Quick start

This example installs the [Context7](https://github.com/upstash/context7)
plugin from a subpath of its repository:

```sh
npx opencode-agent-plugins install \
  https://github.com/upstash/context7.git#:plugins/agent-plugins/context7
```

The CLI fetches the source, validates it, and previews the skills and MCP
servers that would be registered; on confirmation it registers the source
in your OpenCode config and reloads a running OpenCode. If no service is
running, restart OpenCode and the plugin's skill and MCP server are
available in your sessions.

For the full walkthrough — including what the output looks like and how
to verify the result — see the
[getting-started tutorial](./docs/tutorials/getting-started.md).

## Documentation

- [Getting started tutorial](./docs/tutorials/getting-started.md) —
  install your first plugin, step by step.
- [Configuration reference](./docs/reference/configuration.md) — the
  plugin entry, options, sources, and the client store.
- [CLI reference](./docs/reference/cli.md) — commands, flags, statuses,
  and exit codes.
- [Explanations](./docs/explanation/index.md) — architecture, sources,
  registration, the CLI lifecycle, reload, failures, and testing.
- Guides:
    - [Debug the plugin in a live OpenCode](./docs/guides/debugging.md)
    - [E2E testing in Docker](./docs/guides/e2e-testing.md)
    - [Run the quality gate in Docker](./docs/guides/docker-checks.md)
- [Development](./DEVELOPMENT.md) — local environment, build and test
  commands.
- [Changelog](./CHANGELOG.md) — release history.
- [AGENTS.md](./AGENTS.md) — AI-agent code guidelines and project
  structure.
