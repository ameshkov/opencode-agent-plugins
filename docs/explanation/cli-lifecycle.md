# CLI lifecycle

The CLI owns the store and the user's OpenCode config. The plugin never
writes either. This page follows the lifecycle from a source string to a
registered, running capability.

## Commands

| Command | Purpose |
| --- | --- |
| `install <source>` | Fetch, validate, preview, confirm, and register a source. |
| `remove <name>` | Unregister a store entry and delete its tree and data. |
| `check [<name>...]` | Read-only update check over the recorded refs. |
| `update [<name>...]` | Apply available updates through a staged swap. |
| `list` | Show the installed plugins and their status. |
| `doctor` | Read-only report of store and config drift. |
| `prune` | Remove what `doctor` reports as unreferenced. |

The CLI runs on Node.js 26 or later. It needs `git` only for git-backed
commands: `install` from a URL, `check`, `update`, and the status column
of `list`. `remove`, `doctor`, `prune`, and a path-sourced `install`
work without `git`. `list` still completes without it and reports
git-sourced plugins as `unreachable`.

## Install

1. Resolve the source. For a git URL, check that `git` is available and
   resolve the ref to a commit with `ls-remote`. Annotated tags are
   dereferenced.
2. Clone into a temporary staging directory at the resolved commit. A
   shallow clone is enough for a branch or tag. A raw commit SHA may
   need a full clone.
3. Select the plugin root: the clone root, or the selected
   subdirectory. Check that it exists, is a directory, contains
   `plugin.json`, and stays inside the clone after `realpath`.
4. Run the full validation pipeline: manifest, skills, and MCP.
5. Print a preview: the manifest name and version, the skills, and the
   MCP servers. For stdio servers the preview shows the command and
   arguments. For remote servers it shows the URL and the configured
   header names, with values redacted. Installing a plugin means
   OpenCode will later run those commands and talk to those endpoints.
6. If the config has no loader entry, warn and, in interactive mode, ask
   whether to add it. Without the entry OpenCode never loads the plugin,
   so the registered source would be inert. `--yes` adds the entry
   automatically with a warning only.
7. Ask for confirmation unless `--yes` is given.
8. For a git source, move the staged tree into `installed/<slug>` and
   write `meta/<slug>.json`. A path source is used in place. Register the
   original source string in the config. The registered value is exactly
   what the user gave: a git URL with its fragment, or a local path.
   Store-internal paths are never registered.
9. Reload a running OpenCode unless `--no-reload` is given. A
   `--no-register` install never reloads because the config did not
   change; it prints the config snippet and a hint to restart after
   adding it.

A failure at any validation step aborts with nothing changed on disk.
The staging directory is removed. If writing metadata or registering the
source fails after the tree moved, the store entry is rolled back.

`--dry-run` stops after the preview and writes nothing. `--no-register`
does not edit the config; it prints the snippet to add manually.

## Remove

1. Resolve the name to a store entry: an exact slug first, then the
   manifest name. If a manifest name matches several entries, refuse and
   list the slugs. The CLI never guesses which instance the user means.
2. Print what will be removed and ask for confirmation.
3. Remove the source from the config. A legacy V1 `plugin` tuple is
   removed too. The loader entry disappears when its last source is
   removed.
4. Delete `installed/<slug>`, `meta/<slug>.json`, and `data/<key>`
   unless `--keep-data` is given. The config edit happens first. The
   three deletions are attempted independently. A later deletion failure
   names the leftover paths. The source is already unregistered, so the
   entry is half-removed until the user deletes those paths.
5. Reload a running OpenCode unless `--no-reload` is given.

`--dry-run` prints the plan — the installed tree, the metadata file, and,
unless `--keep-data` is given, the data directory — and writes nothing.

Path-sourced plugins have no `remove`. The path is the source of truth;
edit the config instead.

## Check and update

`check` is read-only and uses the network. For each git-sourced plugin it
resolves the recorded ref with `ls-remote` and compares the result with
the recorded commit. It reports one status per plugin:

| Status | Meaning |
| --- | --- |
| `up-to-date` | The ref still resolves to the installed commit. |
| `update-available` | A branch or `HEAD` moved. |
| `pinned` | The source is a commit SHA. |
| `moved-tag` | A tag points somewhere else now. |
| `unreachable` | The remote could not be resolved. |
| `corrupted` | The store entry metadata is missing, unreadable, or has the wrong shape. |
| `local-path` | The source is a local path; edit it directly. |

Names match a store slug first, then a manifest name. A name that matches
no store entry (and no configured path source) is an error. `update` never
reports an unknown name as "nothing to update." A genuinely empty store
still prints `nothing to update.` and exits 0.

`check` exits with code 2 when an update is available.

`update` re-fetches each candidate into a staging directory, derives the
plugin root, validates the new tree, and only then swaps it into
`installed/<slug>`. The old tree is renamed to `.old-<slug>`, the new
tree takes its place, and the metadata is rewritten. On a swap or
metadata failure the previous tree is restored. On success the old tree
is deleted immediately. A `.old-<slug>` left by an earlier crash is
removed before the swap, so it can never replace the live tree. When the
staging directory and the store are on different filesystems, the CLI
copies the tree instead of renaming it (`EXDEV`). The branch itself cannot
be created portably, but the copy fallback is tested directly in
`src/lib/move.test.ts` (relative symlink preservation and failed-copy
cleanup). `PLUGIN_DATA` is untouched.

A moved tag is refused unless `--force` is given. A commit SHA is
immutable and never updates. An unreachable remote, an invalid new
manifest, a disappeared subdirectory, or a swap or metadata failure
keeps the previous install and reports the failure.

After an update that applies at least one change, the CLI reloads a
running OpenCode unless `--no-reload` is given. A no-op update exits 0
and does not reload: there is nothing to apply, and nothing fails.

## List, doctor, and prune

`list` shows each store entry with its manifest name (or its slug when
the manifest is unreadable), URL, ref, subdirectory, resolved commit,
manifest version, and status. An entry with missing, unreadable, or
wrong-shaped metadata prints `<slug>  [corrupted: missing metadata]`
instead. The
status column uses the same classification as `check`. Without `git`,
git-sourced entries show `unreachable`.

`doctor` reports drift without changing anything:

- a config that had to be read but is missing, unreadable, or not valid
  JSONC (`config-missing`),
- config entries with no store entry, including a missing path source and
  a path source whose manifest is unreadable,
- store entries that no audited config entry references,
- corrupted store entries (missing, unreadable, or wrong-shaped metadata),
- orphaned `PLUGIN_DATA` directories. A directory whose key ends in the
  realpath hash of a configured path source is not an orphan, even when
  that source's manifest is unreadable: the hash identifies the instance,
  so `prune` keeps it. A configured git source protects the data
  directory named by its slug even before it is installed,
- stale `.old-*` swap directories.

`doctor` audits the selected config, the global config, and (when the
selected config is the global config or a custom file) the cwd project
config as a known file. It unions their references and resolves each
source like startup: a local path first, relative to the location
directory, then a store slug, then a manifest name. The location
directory is the project cwd; with `--global` or `--config` it is the
process cwd. It does not discover other project configs. When any source does not resolve,
`doctor` does not report orphaned data: the data directory of that source
cannot be identified.

`doctor` exits with code 2 when it finds an issue.

`prune` removes only what `doctor` reports as unreferenced. It never
removes anything an audited config references. When any audited config
cannot be read or parsed, or any configured source does not resolve, the
references are incomplete, so `prune` refuses to delete anything and exits
with code 1. Each removal is attempted independently: a failed deletion is
reported and the command exits 1, while the other items are still removed.

## Config edits

The CLI edits the `plugins` array of the resolved config. The target is
the project `opencode.json` by default, the global config with
`--global`, or an explicit file with `--config`.

The V2 entry is:

```jsonc
{
  "package": "opencode-agent-plugins",
  "options": { "plugins": ["./agent-plugins/my-plugin"] }
}
```

A bare package string is recognized and replaced with the object form on
the first write. A legacy V1 `["opencode-agent-plugins", {…}]` tuple is
read, merged into the object entry, and removed on the next install
write. This prevents V2 from loading the loader twice.

If both `opencode.json` and `opencode.jsonc` exist in the target scope,
the `.jsonc` file wins and the CLI says so. If neither exists, the CLI
creates `opencode.json`.

The edit preserves JSONC. Only the plugin arrays change; comments and
formatting elsewhere stay. The CLI writes atomically through a temporary
file and a rename, and re-parses the result before writing. A timestamped
backup goes to `backups/` in the store, not next to the config, so a
`opencode.json.bak` cannot be committed into the user's repository. If
the config changed between read and write, the CLI aborts instead of
overwriting the other change.

## Reload

`install`, `remove`, and `update` reload a running OpenCode after a
successful change. `--no-reload` skips the call and prints the restart
hint. `--no-register` also skips it and prints the config snippet plus a
hint to restart after adding it. A missing service prints only the
restart hint. A failed request prints a warning
and then the hint. Neither changes the exit code: the change is already
applied.
[Changes and reload](changes-and-reload.md) describes the mechanism.

`check`, `list`, `doctor`, and `prune` do not reload. `prune` removes
only unreferenced entries, so no live location uses them.

## Interaction and exit codes

`install`, `remove`, and `prune` prompt on stdin for confirmation. `--yes`
skips those prompts for scripts and CI. `update` prints a preview and
applies it; `--yes` suppresses the preview. `--dry-run` prints the plan
without writing.

| Code | Meaning |
| --- | --- |
| `0` | The command completed. `update` also exits 0 when nothing needs an update. |
| `1` | The command failed, was aborted, used an unknown `check` or `update` name, or refused to prune incomplete config references. |
| `2` | `check` found an update, or `doctor` found issues. |

Results and plans go to stdout. Diagnostics and errors go to stderr. A
reload failure is a warning on stderr and does not change the exit code.
