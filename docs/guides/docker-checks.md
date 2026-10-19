# Run the quality gate in Docker

The root [`Dockerfile`](../../Dockerfile) is a multi-stage build that
reproduces the full local gate (`format:check`, `lint`, `typecheck`,
`test`) without needing Node, pnpm, or the OpenCode binary installed on
the host. CI runs the same target in its `docker` job (see the
[CI reference](../reference/ci.md)).

## Run it

Build everything and collect all result files into `./ci-output/`:

```sh
DOCKER_BUILDKIT=1 docker build --output type=local,dest=./ci-output .
```

Or run a single gate and collect only its result file:

```sh
# Lint + format + type-check
DOCKER_BUILDKIT=1 docker build --target lint-output --output type=local,dest=./ci-output .
# Unit tests
DOCKER_BUILDKIT=1 docker build --target unit-test-output --output type=local,dest=./ci-output .
```

`./ci-output/` then contains the matching `*-results.txt` file(s). A
failing gate fails the build: the `bash -o pipefail` shell propagates the
command's exit status through `tee`, so a non-zero `docker build` exit
code means that gate failed.

## How it works

- Each gate is a stage (`lint`, `unit-test`) that writes a
  `*-results.txt` file, and each has a companion `FROM scratch` collector
  stage (`lint-output`, `unit-test-output`), so BuildKit's
  `--output type=local` pulls just that result file into a local directory
  instead of producing a tagged image.
- The default target, `ci-output`, collects every gate's result file —
  this is what CI builds.

## Notes

- BuildKit (`# syntax=docker/dockerfile:1`) is required for the pnpm
  cache mounts and for `--output type=local`.
- [`.dockerignore`](../../.dockerignore) keeps the build context lean:
  dependency and tooling directories are excluded, while `build/` is kept
  because the e2e image embeds the compiled plugin (this Dockerfile
  rebuilds it anyway).
- `ci-output/` is gitignored.

## Related

- [E2E testing in Docker](./e2e-testing.md) — the other container lane,
  which tests against a real OpenCode.
- [CI reference](../reference/ci.md) — how both lanes run in CI.
