# Changes and reload

A running OpenCode does not watch an Agent Plugins package's `skills/` or
`mcp.json` files. It does watch the loaded plugin's files. It learns
about a change in one of two ways: its own config watcher, or an explicit
reload request from the CLI. The two mechanisms overlap, and the CLI
treats the second as best-effort.

## What the host watches

OpenCode V2 watches its config directories and the files of the loaded
plugin. A config edit, a store swap, or a plugin rebuild can therefore
trigger a reload of the location. During that reload OpenCode unloads
the loader plugin, runs `setup` again, rebuilds the skill list, and
reconnects MCP servers.

This is a host feature. The e2e suite verifies the CLI reload path, not
the watcher: no scenario isolates a watcher-only reload, and the watcher
can change between releases. The client does not depend on it for
correctness: the CLI prints a deterministic restart hint whenever a
reload is not confirmed.

The watcher covers:

- a source added to or removed from the config,
- a git store entry swapped by `update`,
- the loader plugin's own files after a rebuild.

It does not cover a path-sourced plugin's `SKILL.md`. A local path is
used in place, so editing a skill file changes the file but not the
registration. The next location load picks it up. A reload triggered by
`install`, `remove`, or `update` picks it up immediately.

## The reload endpoint

OpenCode exposes one location reload operation:

```text
POST /api/location/reload
204 No Content
400 Invalid Request
401 Unauthorized
503 Service Unavailable
```

The `@opencode/client` package wraps it as `location.reload()`. The
request has no body and returns no body. A 204 means the location
reload was accepted. The endpoint acts on every loaded location, not only
the caller's: it shuts down and rebuilds each one. Pending permissions
and forms are cancelled, and running sessions continue with fresh
services at the next step boundary.

## Discovery and authentication

The CLI does not guess a port. It uses the same discovery mechanism as
the official OpenCode clients, from `@opencode/client/service`:

1. `discover()` reads the service registration file. The default path is
   `$XDG_STATE_HOME/opencode/service.json`, or
   `~/.local/state/opencode/service.json` when the variable is unset.
2. The file contains the service `url` and `pid`; `id`, `version`, and
   `password` are optional.
3. `discover()` probes `GET /api/info` on that URL and checks the reported
   PID, plus the version when the file records one. This rejects a stale
   file left by a crashed process.
4. The service is ready when the probe succeeds and the service reports
   a compatible state.

When the file has a password, requests use HTTP Basic authentication
with the username `opencode` and that password. The CLI never reads the
password itself, never prints it, and never stores it. The
`@opencode/client` helper builds the header.

The service file exists for the shared background service that the TUI
and desktop clients use. A manually started `opencode serve` may not
write it. In that case the CLI reports no service and falls back to the
restart hint.

## What the CLI does

After an `install`, a `remove`, or an `update` that applies at least one
change, the CLI:

1. Calls `reloadOpenCode()` unless the command opted out with
   `--no-reload` (or, for `install`, `--no-register`).
2. Calls `discover()`. This only reads the registration file and probes a
   healthy service; the CLI never starts a service.
3. If no service is found, prints the command's restart hint.
4. If a service is found, creates an `@opencode/client` client with the
   service URL and auth header, and calls `location.reload()` with a
   five-second timeout.
5. On success, prints `OpenCode reloaded; the change applies where this
   config is loaded.`
6. On failure, prints a warning with the error message and then the
   restart hint.

A no-op `update` reloads nothing: there is no change to apply.

The exit code does not change. The store and config change already
succeeded; the reload is a convenience, not part of the transaction.

`--dry-run` and `--no-register` never reload. `--dry-run` writes
nothing. `--no-register` does not edit the config, so the running
OpenCode has nothing new to load; the CLI prints the config snippet and
a restart hint.

`check`, `list`, `doctor`, and `prune` never reload. `prune` removes
only entries that no config references.

## Why the reload is best-effort

The service registration file and the HTTP API are host internals, not a
public contract. They can change between OpenCode releases. A hard
failure would turn a successful install into a failed command for a
reason the user cannot fix from the CLI. A warning plus the restart hint
keeps the command honest and gives the user a deterministic fallback.

The reload can also interrupt work. It disposes and rebuilds every
loaded location, so a session that is mid-turn may be affected at its
next step boundary. `--no-reload` is the escape hatch for scripts and
for users who want to choose the moment.

## What a reload re-reads

A reload runs the plugin's `setup` again. That means:

- sources are resolved again from the store or the path,
- `plugin.json` is validated again,
- `skills/` is scanned again, so an edited `SKILL.md` is re-read,
- `mcp.json` is translated again, and servers reconnect.

The transform callbacks are replayed against a rebuilt registry. A
registration that collided before can still collide, and the same
precedence rules apply.

## Failure modes

| Condition | Result |
| --- | --- |
| No `service.json` | No service; print the restart hint. |
| Stale `service.json` (PID or version mismatch) | `discover()` returns nothing; print the hint. |
| Service not ready | `discover()` returns nothing; print the hint. |
| 401 Unauthorized | Warning; print the hint. |
| 503 Service Unavailable | Warning; print the hint. |
| Request timeout | Warning; print the hint. |
| Endpoint missing after an OpenCode change | Warning; print the hint. |

After a failed reload the on-disk change is complete. Only the running
process still uses the old state until a restart; after `remove`, the
plugin stays loaded until then. The restart hint remains the guaranteed
way to apply the change.

## Implementation boundary

`@opencode/client` is a runtime dependency of the CLI. It is not a
dependency of the plugin entry. `src/cli/reload.ts` is the only module
that imports it, and `scripts/check-runtime-imports.ts` allows the import
only under `build/cli/`. The plugin entry and `src/lib/` still reject
every runtime `@opencode/*` import, so the published plugin keeps
loading without a runtime import of `@opencode/plugin`.

The reload module lives in the CLI layer because `src/lib/` must stay
OpenCode-free. The shared core makes no HTTP calls; git-backed commands
use the network through the `git` binary.

## Open ideas

See [Future work](future-work.md) for open ideas, including watch mode for
path-sourced plugins and a standalone `reload` command. Nothing there is
a commitment.
