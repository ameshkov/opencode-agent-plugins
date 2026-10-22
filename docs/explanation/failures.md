# Failures

The client never lets one bad component take down the whole location.
Every failure is mapped to a boundary, a report level, and a behavior.
The taxonomy is a closed set of kinds in `src/lib/errors.ts`, so tests
can assert the exact classification.

## The boundary ladder

The boundaries are narrowest-last:

1. **Plugin** — a bad manifest rejects the package. Nothing from it is
   registered.
2. **Component type** — a bad `mcp.json` disables MCP but leaves skills
   alone.
3. **Entry** — a bad server entry or an invalid skill is skipped while
   its siblings continue.
4. **Path** — a path that escapes the package is denied, and the
   affected component is skipped.

A failure at a wider boundary never hides a narrower one. The client
validates the plugin first, then each component, then each entry.

## The taxonomy

| Kind | Boundary | Behavior | Level |
| --- | --- | --- | --- |
| `plugin-missing` | plugin | Reject the plugin: missing, unparsable, or escaping `plugin.json`. | error |
| `manifest-schema` | plugin | Reject the plugin: unsupported `$schema`. | error |
| `manifest-fatal` | plugin | Reject the plugin: required fields, name, author shape, other schema errors. | error |
| `manifest-unknown-fields` | plugin | Report and ignore the unknown field. | warn |
| `extensions-non-object` | plugin | Report and ignore `extensions`. | warn |
| `extension-namespace` | extension | Ignore an unimplemented namespace. | debug |
| `path-escape` | path | Deny the path; skip the affected skill file or server entry. An escaping `skills/` directory or skill subdirectory disables all skills. | warn |
| `skills-missing` | skills | Valid absence. | debug |
| `skills-invalid` | skill | Skip the invalid skill. An unreadable top-level `skills/` directory is fatal to CLI validation: install and update abort. | warn |
| `skills-collision` | skill | Existing skill wins; skip the directory for editor-visible collisions (not config skills). | warn or error |
| `skills-nested` | skill | Never register a nested `SKILL.md`; warn as an authoring mistake. | warn |
| `mcp-missing` | mcp | Valid absence. | debug |
| `mcp-invalid` | mcp | Disable MCP for the plugin: invalid JSON/shape, or an escaping `mcp.json`; skills still load. | error |
| `server-invalid` | server | Skip the entry. | warn |
| `server-transport` | server | Skip an unsupported transport (`sse`). | warn |
| `server-collision` | server | Existing entry wins; skip ours. | warn or error |
| `source-missing` | source | Skip the source; continue with the others. | warn |
| `source-corrupt` | source | Reject the plugin; continue with the others. | error |
| `source-duplicate` | source | Skip the duplicate. | warn |
| `install-fail` | install, remove, registration | Abort with nothing written, or name leftover paths. In registration, report a failed `PLUGIN_DATA` creation and continue. | error |
| `check-unreachable` | check | Report the status; change nothing. | warn |
| `update-ref` | update | Refuse the update; keep the current tree. | warn |
| `config-edit` | config | Abort; keep the backup; change nothing. | error |

The two collision rows have two levels. A collision with our own earlier
registration in the same setup run is an error. Any other collision is a
warning: the editor cannot tell a user-config entry from another plugin's
registration.

The components differ on user config. For skills, a user-config collision
is invisible to transforms and is not reported by the client. For MCP, an
existing entry that the client did not register earlier in this run is
reported with a neutral warning and the entry is skipped
(`src/register-mcp.ts`). In both cases the host keeps the existing entry.

## Logging

The plugin has no logging API in the V2 context. It writes one console
line per notice:

```text
[opencode-agent-plugins] <level> <message> {"boundary":"…",…}
```

`opencode serve --print-logs` captures those lines. The `boundary` field
is the failure kind, so a consumer can classify a line without parsing
the message. The logger drops levels below the configured `logLevel`.

`skills-missing`, `mcp-missing`, and `extension-namespace` are debug
level. At the default `info` level a plugin without skills or MCP
produces no line for that absence.

The CLI prints its own failures as `error:`, `warn:`, or `note:` lines on
stderr, and results on stdout.

## Path containment

Package paths are checked against the resolved plugin root. File paths
are also resolved with `fs.realpath()` before the check. The checks
cover:

- the plugin root itself,
- `plugin.json` and `mcp.json`,
- the `skills/` directory, each skill subdirectory, and each `SKILL.md`
  file,
- a stdio server's `command` and `cwd`.

`command` is checked textually: it must be a single token, either a bare
executable name or a `./` path that stays inside the root. A `../` token
is an escape, and a token with any other path separator is invalid.
`cwd` may be `./...`, `${PLUGIN_ROOT}`, `${PLUGIN_ROOT}/...`,
`${PLUGIN_DATA}`, or `${PLUGIN_DATA}/...`. The client expands
placeholders, normalizes separators, and checks textual containment
against the right anchor. When the target exists, it also realpaths the
target and checks it against the realpathed anchor. A target that does
not exist yet gets only the textual check.

`args` and `env` values are opaque strings. The client expands
placeholders in them but does not reject a value that points outside the
root. The spec treats those values as data, not paths.

An escaping `plugin.json` is `plugin-missing` because the package is
unusable. An escaping `mcp.json` is `mcp-invalid` and disables MCP. Every
other escaping path is `path-escape`. One escaping skill subdirectory
disables the whole `skills/` directory. An escaping `SKILL.md` file skips
only that skill. The client never registers a path that escapes the root.

Containment protects content integrity, not behavior. An installed plugin
can already run commands through its MCP servers, so the check stops a
package from reading or registering files outside its tree. It does not
sandbox what the plugin does at runtime.

## Isolation

- A fatal manifest error rejects only that plugin.
- A bad `mcp.json` disables only MCP for that plugin.
- A bad server entry is skipped; other servers and all skills continue.
- A bad skill is skipped; its siblings continue.
- An unexpected error in one source is caught and reported as
  `source-missing`; the next source continues.
- `setup` never throws. A throw would make OpenCode skip the plugin, and
  the plugin's own logger would never report the cause.

## How tests pin the taxonomy

`src/lib/errors.test.ts` spot-checks levels and proves the map is
exhaustive. `scripts/check-failure-kinds.ts` runs during the build and
checks that every kind is produced somewhere in `src/`. The unit tests
assert the classification for the exercised rows and that the remaining
components still load. The e2e suite asserts the user-visible behavior for
the cases that depend on the host, such as config-skill precedence.
