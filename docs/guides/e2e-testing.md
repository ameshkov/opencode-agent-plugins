# E2E testing in Docker

The e2e suite in [`test-e2e/`](../../test-e2e) is the release gate from
[`docs/explanation/testing.md`](../explanation/testing.md): it
boots a **real OpenCode V2 binary** and the fixture plugin packages inside
a container, and asserts that the plugin's transform registrations
actually reach the model request.

Everything OpenCode-related runs in Docker — never install or run OpenCode
on the host.

## Run the suite

Requires a working Docker engine.

```sh
pnpm build   # the e2e image embeds the compiled plugin
pnpm test:e2e
```

Run a single scenario file by passing it as a filter:

```sh
pnpm test:e2e test-e2e/cli-session.e2e.test.ts
```

The suite is excluded from `pnpm test` / `pnpm check`; it runs under its
own `vitest.test-e2e.config.ts`, with `fileParallelism: false` and long
per-test timeouts (10 minutes per test, 20 minutes per hook).

### Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENCODE_VERSION` | `2.0.16` | The `@opencode/cli` release under test; must stay on the same minor line as the `@opencode/plugin` and `@opencode/client` pins in `package.json`. |
| `E2E_SERVER_PASSWORD` | random UUID | Basic-auth password for the container's `opencode serve`; set it for deterministic runs. |
| `E2E_IMAGE_REUSE` | unset | `1` trusts an existing image instead of rebuilding it (must have been built from the current `Dockerfile`/`build/`). |
| `E2E_TOP_PLUGINS` | unset | `1` enables the opt-in [top-plugins suite](#real-world-plugins-opt-in). |

## How the suite works

- `test-e2e/Dockerfile` builds an image with the pinned `@opencode/cli`
  release, the plugin compiled from this repository (`build/`), the
  fixture plugins (skills + stdio/remote MCP servers), and a fake
  OpenAI-compatible model server that captures every chat-completions
  request. The image has no shell; `test-e2e/bootstrap.mjs` is the
  entrypoint that writes the OpenCode config for the scenario mode, starts
  the fake model server, and spawns `opencode serve`.
- `test-e2e/global-setup.ts` runs once per `pnpm test:e2e`: it verifies
  Docker is reachable (the gate hard-fails instead of skipping), removes a
  stale image, builds the image once, and records its tag for the test
  files.
- The scenario files drive the container through
  [Testcontainers](https://testcontainers.com/): `opencode serve` runs
  inside the container with its port published and a per-run Basic-auth
  password; the tests connect through the V2 client (`@opencode/client`).
  A session is created with `session.create`, prompted with
  `session.prompt`, and awaited with `session.wait`.
- The fake model's first completion emits an `execute` tool call (V2 wraps
  MCP tools in Code Mode by default), so OpenCode runs the plugin's MCP
  server; the tests assert on the executed tool result (`PLUGIN_ROOT` /
  `PLUGIN_DATA` / `cwd` / the eagerly created data dir), on the `hello`
  skill in `<available_skills>`, and on the pinned per-release behavior.
  The tests read the `CAPTURE:` lines the fake model prints.
- The same assertions run against the `static` baseline — the equivalent
  native V2 config written directly into `opencode.json`.
- `scenario.restart()` restarts the **same** container with its
  filesystem preserved, which is how the suite proves what the next
  OpenCode start sees after a CLI install/update/remove.

## Scenario files

| File | Covers |
| --- | --- |
| `agent-plugins.e2e.test.ts` | Core V2 setup/transform contract: hook mode vs static baseline; `execute` tool calls; `PLUGIN_ROOT`/`PLUGIN_DATA` placeholders. |
| `cli-ops.e2e.test.ts` | CLI lifecycle via `docker exec` (no server): install/update/remove, store/config filesystem, doctor/prune, ref semantics, monorepo subdirs. |
| `cli-session.e2e.test.ts` | CLI → OpenCode chain: install picked up live, update + reload, remove + reload (restart also checked), `list` output, uninstalled git source skipped. |
| `negative-behavior.e2e.test.ts` | Failure-taxonomy rows against real sessions: invalid manifest isolation, `$schema` mismatch, user MCP/skill config wins. |
| `remote-mcp.e2e.test.ts` | Streamable-http registration and host-delegated behavior: header forwarding, redirects, `PATH` bare-command resolution, `sse`/bad-URL skips. |
| `top-plugins.e2e.test.ts` | Opt-in: real-world plugins installed and driven (see below). |

## Writing a scenario

- Use `withScenario()` from `test-e2e/helpers/scenario-run.ts` to get a
  container that is cleaned up even when the scenario fails.
- `test-e2e/helpers/scenario.ts` owns container lifecycle, in-place
  restarts, API readiness, and session create/prompt/wait;
  `test-e2e/helpers/capture.ts` parses and asserts on captured model
  requests; `test-e2e/helpers/constants.ts` holds the in-container paths.
- The driver polls `mcp.list` until a server's state has held past
  OpenCode's debounced tool reconcile — polling for `connected` alone lets
  a prompt land before the server's tools reach the registry. Reuse the
  helper rather than polling manually.
- `scenario.session(..., { expectLoader: false })` is for a session that
  runs after the loader entry was removed; the default waits for the
  loader plugin before prompting.
- Assertions run sequentially (`sequence.concurrent: false`); a scenario
  file is expected to be a `describe` of independent `it`s, each with its
  own container.

## Real-world plugins (opt-in)

`top-plugins.e2e.test.ts` installs ten real Agent Plugins (the
agentpluginsdirectory.com top-10 by repository stars, 2026-09-11
inventory, in `test-e2e/top-plugins.data.ts`) into fresh containers and
records what the client does with each: install preview, store-tree scan,
host-side registration, and what reaches the provider. External network
and third-party servers make it non-hermetic, so it is skipped unless
enabled:

```sh
E2E_TOP_PLUGINS=1 pnpm test:e2e test-e2e/top-plugins.e2e.test.ts
```

Evidence is rewritten to the JSON path printed at the end after every
plugin, so partial results survive a failing scenario.

## Related

- [`docs/explanation/testing.md`](../explanation/testing.md) — testing
  strategy and the empirical findings the suite encodes.
- [Debug the plugin in a live OpenCode](./debugging.md) — the local
  counterpart for quick iteration.
- [Docker checks](./docker-checks.md) — the other container-based lane
  (the quality gate, not tests against a real OpenCode).
