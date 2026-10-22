# CI reference

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on every
push to `main`/`master`, on `v*` tags, and on pull requests to
`main`/`master`. Superseded runs on pull requests are cancelled; tag pushes
are never cancelled because they drive releases.

The workflow pins `NODE_VERSION` 26, `PNPM_VERSION` 10.14.0, and
`OPENCODE_VERSION` 2.0.16 — the opencode release the plugin is verified
against. Keep `OPENCODE_VERSION` in sync with the `@opencode/plugin` and
`@opencode/client` pins in `package.json` (see
[AGENTS.md](../../AGENTS.md), Dependency Management).

## Jobs

| Job | Runs | What it does |
| --- | --- | --- |
| `ci` | push, PR | `pnpm install --frozen-lockfile`, then `pnpm check` — the full local gate: format, lint, typecheck, unit tests. |
| `docker` | push, PR | Builds the root [`Dockerfile`](../../Dockerfile) `ci-output` target: the same quality gate, host-tool-free (see the [Docker checks guide](../guides/docker-checks.md)). |
| `e2e` | after `ci` | `pnpm build`, then `pnpm test:e2e` — the Docker e2e suite against `OPENCODE_VERSION` (see the [e2e guide](../guides/e2e-testing.md)). |
| `release` | `v*` tags, after `ci`, `docker`, and `e2e` | Verifies the tag, builds, publishes to npm, and creates the GitHub release. |

## Release pipeline

The `release` job runs only for tags matching `v*`, and waits for `ci`,
`docker`, and `e2e`. It:

1. Fails unless the tag equals `package.json`'s `version` (`v0.2.0` →
   `0.2.0`).
2. Runs `pnpm build`.
3. Publishes with `npm publish --provenance --access public`. No token is
   configured: npm authenticates through OIDC (Trusted Publishers), and
   provenance is generated from the workflow's `id-token: write`
   permission. The package on npmjs.com must be linked to the
   `ameshkov/opencode-agent-plugins` repository and the `ci.yml` workflow
   filename.
4. Packs the tarball (`pnpm pack`) and creates a GitHub release for the
   tag with the tarball attached and a body pointing at
   [CHANGELOG.md](../../CHANGELOG.md).

Publishing a release therefore requires pushing a `v*` tag whose version
matches the bumped `package.json`.
