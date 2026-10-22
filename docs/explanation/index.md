# Explanations

These pages explain how `opencode-agent-plugins` works and why it works
that way. They describe the current state of the code. They are not a
specification and they do not bind future changes.

The source of truth is the code and its tests. The public surface — CLI
flags, configuration keys, statuses, and exit codes — is documented in
the [CLI reference](../reference/cli.md) and the
[configuration reference](../reference/configuration.md). When an
explanation and the code disagree, the code is correct and the page is
stale.

## What the project is

An Agent Plugin is a portable directory with a `plugin.json` manifest
and optional `skills/` and `mcp.json` components. OpenCode does not load
that format directly. `opencode-agent-plugins` is an OpenCode V2 plugin
that resolves configured package sources, validates them against the
Agent Plugins specification, and registers their skills and MCP servers
through OpenCode's plugin context. The same npm package also ships a CLI
that installs, updates, and removes package sources and manages the
client store.

## The pages

| Page | Topic |
| --- | --- |
| [Architecture](architecture.md) | The two entry points, the shared core, dependency rules, and how the plugin talks to OpenCode. |
| [Sources and the store](sources.md) | Source grammar, startup resolution, the client store, subpaths, and `PLUGIN_DATA`. |
| [Registration](registration.md) | Options, manifest validation, skill discovery, MCP translation, and collisions. |
| [CLI lifecycle](cli-lifecycle.md) | Install, remove, check, update, list, doctor, prune, and config edits. |
| [Changes and reload](changes-and-reload.md) | How OpenCode learns about changes, and how the CLI reloads a running server. |
| [Failures](failures.md) | The failure taxonomy, logging, containment, and isolation. |
| [Testing](testing.md) | Unit, integration, and Docker e2e layers, and the verified host behavior. |
| [Future work](future-work.md) | Open ideas. Nothing on that page is a commitment. |

## Related documentation

- [Getting started](../tutorials/getting-started.md) — install a first
  plugin step by step.
- [Configuration reference](../reference/configuration.md) — the plugin
  entry, options, sources, and the store.
- [CLI reference](../reference/cli.md) — commands, flags, statuses, and
  exit codes.
- [Debugging guide](../guides/debugging.md) — run the plugin against a
  live OpenCode.
- [E2E testing guide](../guides/e2e-testing.md) — the Docker suite.
