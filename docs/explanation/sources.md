# Sources and the store

A source is the string a user puts in the `plugins` option. The client
turns it into an absolute plugin root. Local paths are used in place.
Git sources live in a client-managed store. Nothing is fetched at
OpenCode startup.

## Source grammar

```text
<source>   := <local-path> | <git-url>["#"<fragment>]
<git-url>  := https://... | http://... | git+https://... | ssh://...
            | ssh+git://... | git+ssh://... | git@host:path (scp-like)
            | file://...
<fragment> := <ref> | [<ref>]":"<subdir>
<ref>      := <branch> | <tag> | <commit-sha>
<subdir>   := <segment>("/"<segment>)*
```

A git ref cannot contain `:`, so the fragment splits at the first colon
without ambiguity.

### Local path

A local path is absolute, starts with `~/`, or is relative. A relative
path resolves against `ctx.location.directory`, the workspace directory
the user configured. The path points at the plugin root itself and
carries no fragment. `doctor`, `prune`, `check`, and `update` resolve a
relative path in a config against the same location directory: the
project cwd, or the process cwd with `--global` or `--config`.

Local paths are used in place. The client does not copy them into the
store. Editing the source directory is the point of a path source.
Changes are picked up on the next location load, or immediately after a
CLI reload ([changes and reload](changes-and-reload.md)).

`~/...` expands to `HOME`. `~user/...` is rejected. The scp-like git
form requires an `@` before the colon, so a Windows path such as
`C:\plugins\foo` cannot be mistaken for a git URL.

### Git URL

The client recognizes `https`, `http`, `ssh`, `ssh+git`, `file`, and
scp-like `user@host:path` URLs. A leading `git+` is stripped from any
scheme before the client recognizes it. The optional fragment selects a
ref, a subdirectory, or both:

```text
https://github.com/org/repo.git#v1.2.0
https://github.com/org/repo.git#v1.2.0:packages/linter
https://github.com/org/repo.git#:apps/research
```

Without a ref, the remote's `HEAD` at install time is used. The CLI
records the resolved commit. A malformed ref or subdirectory is rejected
before any network call.

### Installed name

A source can also be the manifest name or store slug of an installed
plugin. This resolves to the copy in the client store.

## Resolution at startup

1. Parse the source string.
2. If it is a local path that exists, resolve its realpath and use it in
   place.
3. Otherwise, treat it as a git source or installed name and look up the
   store entry.
4. If the entry is absent, warn and skip that source. Other sources
   continue.
5. Resolve the plugin root with `fs.realpath()`. Every containment check
   runs against the resolved root.

Startup never fetches. A git source that was configured but never
installed is skipped with a `source-missing` warning. This keeps
startup fast and offline, and it makes a broken remote non-fatal.

Two sources that resolve to the same realpath are duplicates. The first
one in config order wins. A later duplicate is skipped with a warning.

## The client store

Git sources are installed under the OpenCode config directory:

```text
<config-dir>/opencode-agent-plugins/
├── installed/<slug>/   # exported plugin tree, no .git
├── meta/<slug>.json    # source, URL, ref, subdir, commit, version, date
├── data/<key>/         # PLUGIN_DATA
└── backups/            # timestamped config backups
```

`<config-dir>` follows OpenCode's convention: `$OPENCODE_CONFIG_DIR`
when set, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
If the variable points inside a repository, the whole store, including
`backups/`, is written there. A dedicated config directory is safer.

`installed/<slug>` is an exported tree at the pinned commit. The CLI
removes `.git` at install time. Nothing uses an installed `.git`: update
checks use `ls-remote`, and updates re-clone into a staging directory.
Keeping the repository would double disk use and invite confusion about
a dirty working tree.

Metadata lives outside the plugin root in `meta/<slug>.json`:

```json
{
  "source": "https://github.com/org/repo.git#v1.2.0",
  "url": "https://github.com/org/repo.git",
  "ref": "v1.2.0",
  "subdir": "packages/linter",
  "resolvedCommit": "…",
  "manifestVersion": "1.2.0",
  "installedAt": "…"
}
```

Keeping metadata out of the tree keeps the tree exactly as published. It
also keeps the metadata out of the plugin's containment surface. An entry
whose metadata is missing, unreadable, or has the wrong shape is reported
as corrupted by `doctor`, `list`, `check`, and a non-dry-run `update`; it
is never treated as healthy. `update --dry-run` previews only actionable
updates, so it does not report a corrupted entry.

Only git-sourced plugins live in the store. Path sources are never
copied.

### Slugs

Without a subdirectory, the slug comes from the last two path segments of
the source URL, sanitized for the filesystem (`src/lib/resolve.ts`). For
an `owner/repo` URL those are the owner and the repository, and the host
is not part of the slug. A URL with a single path segment uses the host
and that segment (`https://example.com/repo.git` becomes
`example-com-repo`). The same repository is therefore installed once.

With a subdirectory, the slug is:

```text
<url-slug>-<flattened-subdir>-<hash8>
```

Subdirectory segments are lowercased, characters outside `[a-z0-9-]`
become `-`, and the segments are joined with `-`. The eight-character
hash of the canonical subdirectory keeps the mapping injective even when
two subdirectories flatten the same way. The whole slug is truncated to
64 characters, keeping the hash suffix.

Two subdirectories of one repository therefore get separate slugs,
roots, and `PLUGIN_DATA` directories. They install side by side. A
subdirectory that differs only by case sanitizes to the same slug, so the
second install reports "already installed".

## `PLUGIN_DATA`

`PLUGIN_DATA` is a persistent directory outside the installed tree, so
it survives updates. The key depends on the source kind:

| Source | Key | Why |
| --- | --- | --- |
| Git | `<slug>` | Stable across manifest renames; matches `installed/<slug>`. |
| Local path | `<manifest-name>-<hash8>` | The root hash identifies the instance; the name is part of the key. |

A path-sourced plugin that renames itself in `plugin.json` changes the
key: the new name starts a fresh data directory, and the old one stays
behind. Both keys end in the same hash, and `doctor` protects both while
the source stays configured, so `prune` never deletes either. Remove the
source from the config to make the old directory prunable.

The directory is created during registration only when the plugin has
at least one valid stdio server. The client sets `PLUGIN_ROOT` to the
realpathed plugin root and `PLUGIN_DATA` to this directory in the
subprocess environment.

`remove` deletes the data directory unless `--keep-data` is given. A
hand-deleted config entry leaves an orphan. Nothing deletes it at
startup. `doctor` lists it and `prune` removes it.

## Store drift

The store and the config can drift apart:

- a config that cannot be read (`config-missing`),
- a config entry with no store entry,
- a store entry referenced by no audited config,
- a corrupted store entry (missing, unreadable, or wrong-shaped metadata),
- an orphaned `PLUGIN_DATA` directory,
- a stale `.old-*` swap directory left by a crash.

Nothing is repaired at startup. `doctor` reports the drift, and `prune`
removes only what is unreferenced. `doctor` audits the selected config, the
global config, and (when the selected config is the global config or a
custom file) the cwd project config as a known file: a store entry or data
directory that any of them references is kept. It does not discover other
project configs. A configured git source protects the data directory named
by its slug even before it is installed.

When the selected config is missing, an existing global or cwd project
config is unreadable or not valid JSONC, or any configured source does not
resolve, the references are incomplete: `prune` refuses to delete anything.
A missing optional config (the global config or the cwd project config) is
not an error. See the [CLI lifecycle](cli-lifecycle.md) for the commands.

## Edge cases

- **Same source twice.** Dedupe by realpath for paths and by slug for
  git sources. The first source in config order wins.
- **Missing source at startup.** A missing local path is rejected as a
  `source-missing` warning. An uninstalled git source is skipped with a
  warning. Other sources still load.
- **Subdirectory disappears on update.** The staged copy fails
  validation and the previous install stays.
- **Store root moves.** A changed config directory or a machine
  migration abandons the old store. Nothing discovers it; remove it by
  hand.
- **SSH authentication.** The CLI uses the ambient SSH agent and keys.
  It never stores credentials. Private repositories need the user's
  normal SSH setup.
