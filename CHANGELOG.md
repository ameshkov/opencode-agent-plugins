# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `install`, `remove`, and an `update` that applies at least one change
  now reload a running OpenCode through the local service API unless
  `--no-reload` is given. A no-op `update` does not reload. `--dry-run`
  and `install --no-register` never reload. A missing service or a failed
  request prints the command's restart hint without changing the exit
  code.

### Changed

- The client store now lives under the OpenCode config directory
  (`<config-dir>/opencode-agent-plugins/`) instead of the data directory.
  The config directory follows OpenCode: `$OPENCODE_CONFIG_DIR`, then
  `$XDG_CONFIG_HOME/opencode`, then `~/.config/opencode`. Existing stores
  under the old data-directory location are not migrated: reinstall each
  source with `install`. To remove a source installed before the move, run
  `install <source>` and then `remove <name>`, or delete its config entry
  manually. `PLUGIN_DATA` under the old location is not migrated: move
  `data/<key>` into the new store to keep it.
- Migrated the plugin to the OpenCode V2 plugin API: the entry is now a
  `{ id, setup }` definition that registers skills through
  `ctx.skill.transform` and MCP servers through `ctx.mcp.transform`, and the
  config entry is `{ "package": "opencode-agent-plugins", "options": { … } }`
  in the `plugins` array.
- The plugin is verified against OpenCode 2.0.16 (`@opencode/plugin` and
  `@opencode/client`); the e2e image installs `@opencode/cli@2.0.16` and
  drives the V2 server API with Basic auth.
- Skill registration now adds each validated skill individually (id, name,
  description, absolute `SKILL.md` path, content) instead of adding the
  plugin's `skills/` directory to `config.skills.paths`.
- MCP registration writes native V2 server entries (`disabled`/`timeout`
  semantics) and leaves the host's Code Mode default untouched, so plugin
  servers behave exactly like natively-configured ones.
- Plugin diagnostics are written as `[opencode-agent-plugins]` console lines,
  captured by `opencode serve --print-logs`, because V2's plugin context
  exposes no logging API.
- The CLI edits the `plugins` array and its `{ package, options }` entry
  (still JSONC-preserving) and migrates a legacy V1
  `["opencode-agent-plugins", {…}]` tuple (sources and other options merged
  into the entry) on the next install write.
- The CLI's loader-entry bootstrap accepts either the V2 entry or a legacy
  tuple and notes the migration when the legacy form is found.
- OpenCode's config watcher may reload the plugin after CLI changes; the
  CLI also reloads a running service and still prints the restart hint
  as the fallback.
- Made `@opencode/client` a runtime dependency used only by the CLI
  reload call; the plugin entry still has no runtime OpenCode import.
- `remove --dry-run` now prints the installed tree and metadata paths it
  would delete, in addition to the source and `PLUGIN_DATA` directory.

### Removed

- Support for OpenCode 1.x plugin implementations: V1 plugins do not run in
  OpenCode 2, so the package no longer targets the V1 `config` hook or the
  `["opencode-agent-plugins", {…}]` config tuple (existing configs are
  migrated on write).

### Fixed

- `update` now removes a stale `.old-<slug>` swap leftover before the swap
  and rolls back only when the live tree moved. A crash leftover can no
  longer replace the live tree with an older copy.
- `prune` now audits the selected config, the global config, and the cwd
  project config (with `--global` or `--config`) together, so a store entry
  or data directory that any of them references is kept. It refuses to prune
  when the selected config is missing, when an existing global or cwd
  project config is unreadable or not valid JSONC, or when any configured
  source does not resolve, instead of treating the store as unreferenced. A
  missing optional config is not an error.
- `doctor` and `prune` now resolve sources like startup: a local path first
  (relative to the location directory), then a store slug, then a manifest
  name. A global relative path resolves against the project cwd, or the
  process cwd with `--global`, not the config file's directory. An
  installed-name source and a relative path source are no longer reported as
  missing and pruned.
- `doctor` and `prune` now keep the `PLUGIN_DATA` directory named by the slug
  of a configured but not yet installed git source.
- `doctor` no longer reports orphaned `PLUGIN_DATA` when any audited config
  has a source that does not resolve, because the data directory of that
  source cannot be identified.
- An unreadable top-level `skills/` directory no longer rejects `install` or
  `update` with a raw stack: discovery reports a fatal `skills-invalid`
  failure, install aborts with nothing written, and update keeps the previous
  install.
- `doctor`, `list`, `check`, and `update` now treat store metadata with the
  wrong shape (`{}`, `[]`, a missing `resolvedCommit`) as corrupted instead
  of crashing or reporting a healthy entry.
- `prune` now attempts each deletion independently and reports every failure
  without a stack; the command exits 1 when any item could not be removed.
- `install` and `update` now fall back to a recursive copy when the staging
  directory and the store are on different filesystems (`EXDEV`), so a
  cross-device store no longer fails the move.
- `list` now prints `<slug>  [corrupted: missing metadata]` for an entry with
  unreadable metadata instead of failing.
- `update <name>` and `check <name>` now resolve a manifest name through the
  store. An unknown name exits with code 1 instead of printing
  `nothing to update.`
- `install ~/...` now expands `~`. A `~user/...` source is rejected with the
  same message as startup.
- A stray nested `SKILL.md` can no longer be exposed through plugin
  registration: V2 registers skills individually, so only validated
  immediate children are ever registered. Discovery still warns about the
  file as an authoring hint.
- The nested-`SKILL.md` discovery warning no longer fires for every valid
  skill on Windows: the depth check splits paths on both separators.
- Rejected a `plugin.json`, `mcp.json`, or `SKILL.md` that resolves
  outside the plugin root: an escaping manifest is `plugin-missing`, an
  escaping `mcp.json` disables MCP, and an escaping `SKILL.md` skips that
  skill.
- Rejected a stdio `command` token that contains a path separator but
  does not start with `./`.
- Required an existing stdio `cwd` target to realpath inside its anchor,
  and accepted `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` `cwd` values with
  Windows separators.
- `update` now exits 0 when nothing needs an update, and exits 1 when any
  selected entry fails even if another entry updated successfully.
- `update --yes` now prints `nothing to update.` when no store entry is
  selected.
- `update` now restores the previous tree when the metadata write fails
  and reports the failure instead of rejecting the command.
- `doctor` and `prune` now keep the `PLUGIN_DATA` directory of a
  configured path source when its manifest is unreadable.
- Install-time validation and load-time registration now derive the same
  `PLUGIN_DATA` key for a path-sourced plugin, so a `cwd` inside
  `PLUGIN_DATA` validates at install and works at load.

## [0.1.0] - 2026-09-16

### Added

- Initial release of the Agent Plugins client for OpenCode
  (Agent Plugins specification v1.0.0): an OpenCode plugin that validates
  Agent Plugins packages and registers their skills and MCP servers, and
  a CLI that installs, updates, removes, and inspects them.
- Plugin entry for the OpenCode `plugin` array that resolves each
  configured source, validates the package against the specification, and
  registers its capabilities through the `config` hook — with per-plugin
  failure isolation, user-config-wins collision handling, and no network
  access at startup.
- Plugin options: `plugins` (a single source or a list of sources;
  required), `prefix` (namespaces MCP server names as
  `<plugin-name>-<server>`, replacing invalid characters with `-`), and
  `logLevel` (`debug`, `info`, `warn`, `error`; default `info`). Unknown
  keys warn and are ignored.
- Skill registration: discovers `skills/<name>/SKILL.md` (one level, no
  recursion), validates the directory name and frontmatter, and adds the
  plugin's `skills/` directory to `config.skills.paths` without copying
  files (only when at least one valid skill remains). An invalid skill is
  skipped with a warning while the plugin's other skills still register;
  a skill-name collision with user config or another plugin skips the
  plugin's whole `skills/` directory.
- MCP server registration: `mcp.json` `stdio` servers become `local`
  entries with `PLUGIN_ROOT` and a persistent `PLUGIN_DATA` directory
  injected into the environment, `streamable-http` servers become
  `remote` entries, and unsupported `sse` servers are skipped with a
  warning.
- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expansion in stdio `args`,
  environment values, and `cwd`, plus remote MCP server rules: absolute
  HTTP(S) URLs, no userinfo or fragment, HTTPS for non-loopback hosts,
  and case-insensitively unique header names.
- Path containment: the `skills/` tree and stdio `command`/`cwd` values
  are resolved against the plugin root — an escaping skill entry disables
  the plugin's `skills/` registration, and an escaping `command` or `cwd`
  skips that server entry.
- Plugin sources: local paths (absolute, `~/...`, or relative to the
  workspace; used in place and never copied), git URLs (`https://`,
  `git+https://`, `ssh://`, `git+ssh://`, and the scp-like
  `git@host:path`) with optional `#ref` and `#ref:subdir` fragments to
  pin a branch, tag, or commit and select a monorepo subdirectory, and
  installed plugin names.
- CLI commands (`npx opencode-agent-plugins <command>`, Node.js >= 26):
    - `install <source>` — fetch git sources (or use paths in place),
      validate, preview (skills, stdio commands and args, remote URLs and
      redacted header values), confirm, and register, with `--ref`,
      `--global`/`--config`, `--yes`, `--dry-run`, and `--no-register`.
    - `remove <name>` — unregister the plugin and delete its store entry
      and `PLUGIN_DATA` (`--keep-data` keeps the data directory,
      `--dry-run` prints the plan); path-sourced plugins are removed by
      editing the config.
    - `check [<name>...]` — read-only update check over the recorded
      refs, reporting `up-to-date`, `update-available`, `pinned`,
      `moved-tag`, `unreachable`, `corrupted`, or `local-path`; exits
      with code 2 when an update is available.
    - `update [<name>...]` — stage, validate, and swap each update into
      the store, restoring the previous tree on failure and leaving
      `PLUGIN_DATA` untouched; `--dry-run` prints the plan and writes
      nothing, and `--force` follows a moved tag.
    - `list` — list installed plugins with URL, ref/subdir, resolved
      commit, manifest version, and status.
    - `doctor` — read-only store/config drift report; exits with code 2
      when issues are found.
    - `prune` — remove what `doctor` reports as orphaned or stale in the
      selected config (references in another scope's config are not
      checked).
- Client store under `<data-home>/opencode/agent-plugins/`: `installed/`
  trees pinned at the resolved commit, per-plugin `meta/` records,
  persistent `data/` directories for `PLUGIN_DATA`, and `backups/` for
  config edits.
- JSONC-preserving config edits (comments and formatting outside the
  `plugin` array stay intact), with a timestamped backup of the previous
  config under the store's `backups/`; `opencode.jsonc` wins over
  `opencode.json` in the same scope, and `install` offers to add the
  `opencode-agent-plugins` loader entry when the config has none.

[unreleased]: https://github.com/ameshkov/opencode-agent-plugins/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ameshkov/opencode-agent-plugins/releases/tag/v0.1.0
