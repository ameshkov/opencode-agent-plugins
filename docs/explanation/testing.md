# Testing

The test suite has four layers. Unit tests cover the shared core.
Integration tests drive the registration pipeline against a stub V2
context. CLI tests exercise the lifecycle against real temporary stores
and git fixtures. Docker e2e tests run a real OpenCode binary against a
real plugin and capture the request the model receives.

The layers exist because some behavior only appears in the host. A unit
test can prove that a skill is registered; only the e2e suite can prove
that OpenCode exposes it in the model request.

## Unit tests

Unit tests live next to their modules with the `.test.ts` suffix. They
cover:

- manifest validation against the spec examples, including unknown
  fields and fatal errors;
- `mcp.json` parsing, per-entry validation, remote URL and header rules,
  version mismatches, and unknown schemas;
- placeholder expansion and containment, including pre- and
  post-expansion escapes, Windows-separator `cwd` values, path-like
  `command` tokens, and escaping `plugin.json`/`mcp.json`/`SKILL.md`
  symlinks;
- source grammar, refs, subdirectories, slug derivation, and truncation;
- skill discovery, frontmatter, name rules, nested `SKILL.md`, and
  symlink containment;
- the failure taxonomy: it spot-checks levels and proves the map is
  exhaustive;
- store layout, metadata, and config edits;
- install and update against a local bare repository; remove against
  seeded store entries.

The tests prefer real files and real temporary directories over mocks.
The shared helpers live in `test/` and do not use the `.test.ts` suffix.

## Integration tests

`test/stub-context.ts` implements the subset of the V2 context the
pipeline uses. It records skill and MCP registrations and captures log
lines. A test calls the plugin's `setup` with the stub and asserts:

- the exact registration objects,
- the log entries and their `boundary` metadata,
- that a collision skips the right directory,
- that `PLUGIN_DATA` is created only when a stdio server exists.

The stub's skill editor models other plugins' registrations. It cannot
seed user-authored config skills, because those are invisible to
transforms in the real host. That case belongs to the e2e suite.

## CLI tests

CLI tests call the command functions directly. They use a temporary
config directory, a temporary `XDG_STATE_HOME`, and a local bare git
repository exposed through `file://`. They assert:

- `install` validates before registering, previews components, and
  `--dry-run` writes nothing;
- `update` detects drift, swaps atomically, preserves `PLUGIN_DATA`, and
  refuses a moved tag without `--force`;
- `remove` deletes the store entry and data and edits the config without
  touching comments;
- config edits round-trip and leave a timestamped backup on failure;
- subpath sources install side by side, and `--ref` overrides only the
  ref;
- `src/cli/cli-flags.test.ts` is self-contained: it seeds its own store
  entries and fixtures for `install --dry-run`, `update --dry-run`,
  `remove --dry-run`, `--no-reload`, and `install --no-register`;
- the reload path posts to a stub service and handles a missing service
  and a rejected request; the rejected-request test asserts that the POST
  reached the endpoint.

The reload tests use a real HTTP server and the real
`@opencode/client/service` discovery code. They never start OpenCode.

## Docker e2e tests

The e2e suite runs a real OpenCode binary inside Docker. It builds an
image with the compiled plugin and a fake OpenAI-compatible model
server. The fake server captures the exact request OpenCode sends to the
model.

Scenarios:

- **Hook mode** — the loader plugin is configured with a fixture
  package. The suite asserts that the skill appears in
  `<available_skills>`, that the stdio MCP server connects, and that its
  tool is callable through Code Mode.
- **Static mode** — the same components are written directly in
  `opencode.json` as a baseline.
- **Negative behavior** — invalid components, collisions, and user
  config precedence.
- **CLI chain** — the CLI installs, updates, and removes a git fixture
  while OpenCode runs, and the next session sees the result.
- **Remote MCP** — remote servers, redirects, and header handling.
- **Top plugins** — an opt-in suite that installs published Agent
  Plugins and compares the validation scan with host discovery.

The suite runs in CI for the pinned OpenCode release. Run it again
whenever the pin changes. It is the release gate, not an optional extra.

## What the e2e suite proved on OpenCode 2.0.16

These findings shaped the implementation. They are re-checked when the
pinned OpenCode version changes.

1. **A plain `{ id, setup }` default export loads.** No
   `Plugin.define()` call is needed. A V1 function export fails with
   "Plugin must export a default definition with an id and an effect or
   setup function".
2. **A local plugin entry must be a directory.** OpenCode resolves
   `<dir>/server.js` for a directory target. A file path is rejected.
   The e2e image ships a `server.js` shim for the compiled entry.
3. **Transforms may replay after `transform()` resolves.** The registry
   rebuild is batched. Counters and cross-source state must not depend
   on callback side effects. Collision checks belong inside the
   callback.
4. **Code Mode is the default.** MCP tools are callable as
   `tools.<server>.<tool>` inside `execute` unless the server sets
   `codemode: false`. The client leaves the host default untouched.
5. **Skills are registered individually.** Config skills are invisible
   to plugin transforms, and the host keeps a config skill over a plugin
   registration of the same name. A user-authored config `skills`
   directory is scanned recursively, so a nested `SKILL.md` is exposed
   there; the plugin's own registration never exposes it. On 2.0.16 the
   `<available_skills>` block is part of the system prompt. Some
   releases put it in the `skill` tool description instead, so the suite
   accepts either surface.
6. **The config watcher is a host feature the suite does not isolate.**
   The e2e suite verifies the CLI reload path: after an install while
   OpenCode runs, a new session sees the plugin without a restart. The
   watcher may also reload the loader plugin, but the suite does not
   depend on it, and the watcher can change between releases.
7. **There is no plugin logging API.** Console lines with the
   `[opencode-agent-plugins]` prefix appear in
   `opencode serve --print-logs`.
8. **Placeholder expansion is the client's job.** OpenCode passes
   configured `env` values verbatim, so the client expands
   `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` before registration.
9. **MCP readiness is asynchronous.** A server reports `connected`
   before its tools reach the tool registry. OpenCode registers them
   through a debounced reconcile of `mcp.tools.changed`. The e2e driver
   waits for the state to hold past that debounce; polling for
   `connected` alone can let a prompt land too early.
10. **The npm cache is generation-based.** OpenCode resolves npm-name
    plugin entries under
    `<cache>/opencode/npm/<name@spec>/<generation>/node_modules/` and
    reuses the newest generation when the package directory exists. The
    e2e image seeds that path so the unpublished local build is tested.

## Schema provenance

The Agent Plugins schemas are committed under `src/schemas/`. The build
copies them into `build/schemas/`. The plugin never fetches a schema at
runtime.

`scripts/update-schemas.ts` is a manual, dev-only script. It downloads
the canonical schemas, checks that they encode closedness, and rewrites
the vendored files only when the bytes change. It never runs in CI and
never runs at plugin load.

## Running the suite

- `pnpm test` — unit, integration, and CLI tests.
- `pnpm build && pnpm test:e2e` — Docker e2e suite.
- `pnpm check` — format, lint, typecheck, and unit tests.

The e2e suite needs Docker. The host must not run the OpenCode binary
directly; the Docker image provides the pinned release.
