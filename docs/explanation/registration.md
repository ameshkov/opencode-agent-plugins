# Registration

Registration is the path from a validated package to entries in
OpenCode's runtime registry. It runs inside the plugin's `setup`, once
per location load. The pipeline is resolve, validate, discover, and
register.

## The startup pipeline

1. Parse the plugin options. An invalid options object is logged and the
   pipeline stops. Unknown keys produce warnings and are ignored.
2. For each configured source, resolve it to a plugin root. A source
   that cannot be resolved is reported and skipped.
3. Load and validate `plugin.json`. A fatal manifest error rejects the
   whole plugin. Unknown fields are reported and ignored.
4. Discover skills under `skills/` and servers in `mcp.json`.
5. Register skills first, then MCP servers. An MCP failure cannot
   prevent skills from registering.
6. Log a summary of the attempted registrations.

Each source is isolated. An unexpected error is reported as a
`source-missing` warning and the next source continues. `setup` never
throws.

The summary counters are attempted registrations, not successful ones. A
skill that collides and is skipped is still counted, because the
transform callback may run after the summary is written.

## Options

The options object mirrors the `opencode-agent-plugins` entry in the
`plugins` array of the OpenCode config:

```jsonc
{
  "package": "opencode-agent-plugins",
  "options": {
    "plugins": ["./agent-plugins/my-plugin", "git@github.com:org/third.git"],
    "prefix": false,
    "logLevel": "info"
  }
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `plugins` | `string \| string[]` | — | Sources to load. A single string is normalized to an array. |
| `prefix` | `boolean` | `false` | Namespace MCP server names as `<plugin-name>-<server>`. |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Minimum level written to the console logger. |

Zod validates the object. Unknown keys are reported and stripped.
`plugins` is required. A missing or invalid value throws, and the entry
point catches the error, logs it, and stops.

One entry with an array of sources is deliberate. OpenCode deduplicates
plugin entries by package identity, so a second `opencode-agent-plugins`
entry would be silently ignored. One setup instance owns all
registrations for the location, which keeps collision handling
deterministic.

## Manifest validation

`plugin.json` is validated against the vendored Agent Plugins 1.0.0
schema. The schema is committed under `src/schemas/` and copied into
`build/schemas/` by the build. The plugin never fetches a schema while
loading.

The manifest is a closed schema. The client handles violations in two
groups:

- **Fatal.** A missing or unparsable file, a `plugin.json` that resolves
  outside the package root, an unsupported `$schema`, a missing required
  field, an invalid name, an invalid author shape, or any other schema
  violation rejects the plugin. Nothing from that package is registered.
- **Report and ignore.** Unknown top-level fields are reported and
  stripped before validation. A non-object `extensions` value is
  reported and ignored. An unimplemented extension namespace is ignored
  at debug level.

The order matters. The client strips unknown top-level fields first, then
validates the remainder. A fatal error in a known field is therefore
never hidden by the presence of unknown fields.

The supported schema identifiers are a set, not a version number. Adding
a future spec version means extending that set. The `$schema` value also
drives the version-consistency check for `mcp.json`.

## Skills

Skills live at a fixed location:

```text
<plugin-root>/skills/<name>/SKILL.md
```

Only immediate child directories are considered. The client does not
recurse. A directory without a regular `SKILL.md` is skipped. A missing
`skills/` directory is a valid absence and produces no user-visible
error at the default log level.

Each skill is validated:

- The frontmatter must parse.
- `name` must be a string, match `^[a-z0-9]+(-[a-z0-9]+)*$`, be at most
  64 characters, and equal the directory name. The directory name is
  authoritative; frontmatter cannot rename a skill.
- `description` must be a non-empty string of at most 1024 characters.

An invalid skill is skipped with a warning. Its valid siblings still
register.

The client also checks containment. `skills/`, every skill
subdirectory, and every `SKILL.md` file must resolve, after `realpath`,
inside the resolved plugin root. An escaping `skills/` directory or
skill subdirectory disables the whole `skills/` dir. An escaping
`SKILL.md` file skips only that skill. Registration is
directory-granular, so a partially trusted directory is not exposed.

A nested `SKILL.md`, such as `skills/foo/references/SKILL.md`, is never
registered. The client warns because it is almost always an authoring
mistake. A user-authored config `skills` directory is a different
surface: OpenCode scans that directory recursively and would expose the
nested file.

### The registration object

Each validated skill is added individually:

```ts
editor.add({
  id: skill.name,
  name: skill.name,
  description: skill.description,
  path: skill.skillMd,
  content: skill.content,
});
```

`path` is the absolute path to `SKILL.md`, not the skill directory. This
keeps relative resources beside the file reachable for the host.
`content` is the raw `SKILL.md` source. The client does not copy files.

### Collisions

Skill names must be unique at the location. The collision check runs
inside the transform callback, because the editor is the authoritative
view of earlier registrations and the callback may replay.

- A name registered earlier in the same setup run is a plugin–plugin
  collision. The client reports an error and skips the later plugin's
  whole `skills/` directory.
- A name registered by another OpenCode plugin is visible in the editor.
  The client reports a warning and skips the directory.
- A name used by a user-authored config skill is not visible to
  transforms. The host keeps the config skill over the plugin
  registration. The client cannot see or report this case.

The skip is directory-granular. One collision drops every skill in that
plugin's `skills/` directory, including non-colliding siblings.

## MCP servers

`mcp.json` is a closed format with `$schema` and `mcpServers`. Its
`$schema` must be recognized and must match the `plugin.json` version. A
mismatch disables MCP for that plugin, but skills still load.

Each server entry is validated independently. A bad entry is skipped
with a warning. A bad top-level shape disables MCP for the plugin. A
missing `mcp.json` is a valid absence.

### Translation

The portable format maps to OpenCode's native config:

```ts
// stdio
editor.set(name, {
  type: "local",
  command: [server.command, ...server.args],
  environment: { ...server.env, PLUGIN_ROOT, PLUGIN_DATA },
  cwd: expandedCwd ?? pluginRoot,
});

// streamable-http
editor.set(name, { type: "remote", url, headers });

// sse
// skipped: unsupported transport, reported as a warning
```

Details:

- `PLUGIN_ROOT` and `PLUGIN_DATA` are set after the configured
  environment is overlaid. Configured entries for those names are
  invalid anyway.
- `cwd` defaults to the plugin root. The client always passes an
  absolute path, because OpenCode's own default resolves relative to the
  workspace.
- Placeholders expand only in `args`, `env` values, and `cwd`. They are
  `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, replaced once, without
  recursion. Unknown placeholder-like text stays literal. `command`,
  `url`, headers, and env keys are not expanded.
- A `command` is a single executable token. A bare name is allowed, as
  is a `./` path that stays inside the root. A `../` token is an escape,
  and a token with any other path separator is invalid.
- Remote URLs must be absolute HTTP(S), with no user info and no
  fragment. A non-loopback host requires HTTPS. Header names must be
  valid HTTP field names with no case-insensitive duplicates.
- OpenCode's MCP client owns header precedence and redirect behavior.
  The e2e suite verifies those, not the unit tests.

### Name sanitization and collisions

Server names become tool-name prefixes. OpenCode's providers restrict
tool names to `[A-Za-z0-9_-]`. With `prefix: true`, the client
registers `<plugin-name>-<server>`, replacing `.` and other disallowed
characters with `-`. A name that is still invalid after sanitization
makes that entry invalid.

The transform editor exposes config-defined servers and earlier plugin
registrations, but it cannot tell them apart. If the name is already
taken, the client skips the entry and reports:

- a name registered earlier in the same setup run is a plugin–plugin
  collision, reported as an error;
- anything else is treated as an existing entry, reported as a warning
  with neutral wording because its owner is unknown.

The existing entry wins. A user can therefore override a server with a
full entry, a `disabled: true` stub, or a different `timeout`. The client
never overwrites the entry.

### Code Mode

OpenCode wraps MCP tools in Code Mode by default. Plugin servers behave
like natively configured servers: tools are callable as
`tools.<server>.<tool>` inside `execute`. The client leaves the host
default untouched. A user who needs the provider's native tool list can
predefine the server with `codemode: false`; user config wins.

## What the user sees

- Skills appear in the `<available_skills>` block. Some OpenCode
  releases carry that block in the system prompt, others in the `skill`
  tool description. The e2e suite accepts either surface.
- MCP tools appear through Code Mode, like native servers.
- Diagnostics are `[opencode-agent-plugins]`-prefixed console lines.
  `opencode serve --print-logs` captures them.
- `opencode mcp list` lists configured servers only. Plugin
  registrations are registry entries and are visible through the server
  API, not through that command.
