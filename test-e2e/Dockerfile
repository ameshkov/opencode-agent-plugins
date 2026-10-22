# syntax=docker/dockerfile:1

# E2E image: a real, pinned opencode binary plus the plugin built from this
# repo, the fixture plugin packages, and a fake OpenAI-compatible model server.
# EVERYTHING opencode-related runs inside this container; the vitest host only
# starts/stops containers through testcontainers and asserts on the captured
# model request (docs/explanation/testing.md).
#
# Build (from the repo root):
#   docker build -f test-e2e/Dockerfile \
#     --build-arg OPENCODE_VERSION=2.0.16 -t opencode-agent-plugins-e2e:2.0.16 .
#
# Run manually (the harness normally supplies E2E_SERVER_PASSWORD):
#   docker run --rm -p 4096:4096 -e E2E_SERVER_PASSWORD=dev-only \
#     opencode-agent-plugins-e2e:2.0.16 hook

ARG OPENCODE_VERSION=2.0.16

FROM node:26-bookworm-slim

# Re-declare the ARG inside the stage (a FROM-level ARG is not in scope here)
# and propagate it to a layer-scoped ENV: buildkit keys RUN-layer cache on
# the instruction text + inherited env, so an ARG only referenced inside the
# command string does NOT invalidate a stale cached layer and the build could
# reuse an image built with a different version. With ENV set, the value is
# part of the cache key and the version is always fresh.
ARG OPENCODE_VERSION
ENV OPENCODE_VERSION=${OPENCODE_VERSION}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# git is required by the CLI's git-backed commands (install/check/update,
# cli-lifecycle.md) and by the git fixture manager that mutates the fixture remote.
# ca-certificates is required for HTTPS remotes (GitHub): the slim base image
# ships no CA bundle, and git fails TLS verification without it (npm works
# because Node bundles its own roots).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The release the plugin is verified against — matches the
# @opencode/plugin and @opencode/client pins and the OPENCODE_VERSION CI
# env. V2 ships as `@opencode/cli` (the legacy `opencode-ai` package is the
# V1 line). The
# OpenAI-compatible provider package used by the fake model endpoint is
# preinstalled so opencode resolves it from the global root at runtime.
RUN npm install --global --no-fund --no-audit "@opencode/cli@${OPENCODE_VERSION}" \
  && npm install --global --no-fund --no-audit "@ai-sdk/openai-compatible@3.0.41"

WORKDIR /app

# The plugin, compiled from this repo (build/ output only; the build gate
# already guarantees zero OpenCode runtime imports). Copied with its
# package.json so the loader treats build/index.js as ESM, and its runtime
# deps (zod, ajv) are installed — without them the plugin import fails at
# load (OpenCode logs `failed to load plugin` and skips it,
# architecture.md). jsonc-parser is CLI-only; the CLI build also needs
# @opencode/client.
WORKDIR /app/plugin
COPY build/ /app/plugin/build/
COPY package.json /app/plugin/package.json
# V2 resolves a configured plugin *directory* through `<dir>/server.js` (the
# package-root ESM import fallback is rejected by Node for directories in
# 2.0.16). A shim that re-exports the compiled entry makes the path form load;
# npm-name entries resolve through package.json `main` instead.
RUN printf "export { default } from './build/index.js';\n" > /app/plugin/server.js
# No lockfile in the image (deps are pinned in package.json) and
# --legacy-peer-deps: the full dev tree (vitest et al.) triggers a known npm
# arborist crash ("Cannot read properties of null (reading 'edgesOut')")
# while walking peer sets; the runtime deps have no peers, so nothing is
# lost here.
RUN npm install --omit=dev --no-fund --no-audit --package-lock=false --legacy-peer-deps

# The same plugin as the npm package `opencode-agent-plugins` — the name the
# CLI registers in the config (cli-lifecycle.md). Installed into the global npm root
# (alongside @opencode/cli) AND the workspace project dir, so opencode can
# resolve the package-name plugin entry from either resolution base (an
# unresolvable name is reported at load and skipped, architecture.md).
RUN npm install --global --no-fund --no-audit --omit=dev --legacy-peer-deps /app/plugin
RUN mkdir -p /app/workspace \
  && printf '{\n  "name": "e2e-workspace",\n  "private": true\n}\n' > /app/workspace/package.json \
  && cd /app/workspace \
  && npm install --no-save --no-fund --no-audit --omit=dev --legacy-peer-deps --package-lock=false /app/plugin

# Seed opencode's managed npm plugin cache: V2 resolves npm-name plugin
# entries through its npm cache (`<cache>/npm/<name@spec>/<generation>/
# node_modules/<name>`), and reuses the newest generation when the package
# directory already exists. `opencode-agent-plugins` is published as a stale
# V1 release, so we place THIS build (with its runtime deps) in a generation
# directory to make the bare-name entry resolve locally.
RUN set -eux; \
  mkdir -p "/app/opencode-home/.cache/opencode/npm/opencode-agent-plugins@latest/1/node_modules"; \
  cp -R /app/plugin "/app/opencode-home/.cache/opencode/npm/opencode-agent-plugins@latest/1/node_modules/opencode-agent-plugins"

# Stdio fixture plugin: install its MCP SDK dependency, then copy the package
# (exec bit for bin/serve.js is ensured explicitly).
WORKDIR /app/fixtures/my-plugin
COPY test-e2e/fixtures/my-plugin/package.json /app/fixtures/my-plugin/package.json
RUN npm install --no-fund --no-audit
COPY test-e2e/fixtures/my-plugin/ /app/fixtures/my-plugin/
RUN chmod +x /app/fixtures/my-plugin/bin/serve.js

# Remote streamable-http fixture plugin (same SDK, dep-free stdio path tool).
WORKDIR /app/fixtures/remote-plugin
COPY test-e2e/fixtures/remote-plugin/package.json /app/fixtures/remote-plugin/package.json
RUN npm install --no-fund --no-audit
COPY test-e2e/fixtures/remote-plugin/ /app/fixtures/remote-plugin/
RUN chmod +x /app/fixtures/remote-plugin/bin/remote-server.mjs

# Git-sourced fixture source (cloned into the fixture repo by git-fixture.mjs
# during `cli` scenario setup; dependency-free).
COPY test-e2e/fixtures/git-plugin/ /app/fixtures/git-plugin/
RUN chmod +x /app/fixtures/git-plugin/bin/serve.js

# Monorepo fixture packages, seeded under `packages/` of the same git fixture
# repo and installed through subpath sources (`#:packages/alpha`); manifest +
# skill only, dependency-free.
COPY test-e2e/fixtures/monorepo/ /app/fixtures/monorepo/

# Negative-path fixtures (broken manifest; mcp.json $schema version mismatch).
COPY test-e2e/fixtures/broken-plugin/ /app/fixtures/broken-plugin/
COPY test-e2e/fixtures/mismatch-plugin/ /app/fixtures/mismatch-plugin/

# User-authored skills fixture: a `hello` skill colliding with my-plugin's
# (the skill-collision scenario; user config wins, registration.md).
COPY test-e2e/fixtures/user-skills/ /app/fixtures/user-skills/

# Bare-command (PATH-resolved) MCP tool for the remote fixture.
COPY test-e2e/path-bin/e2e-path-tool /app/path-bin/e2e-path-tool
RUN chmod +x /app/path-bin/e2e-path-tool

# Container bootstrap: starts the fake model server (in-process), writes the
# config for the mode, and runs `opencode serve` (published port 4096). The
# vitest host drives everything through the server API — no shell involved.
COPY test-e2e/fake-model-server.mjs /app/fake-model-server.mjs
COPY test-e2e/write-config.mjs /app/write-config.mjs
COPY test-e2e/bootstrap.mjs /app/bootstrap.mjs
COPY test-e2e/git-fixture.mjs /app/git-fixture.mjs

# Diagnostic tree scanner for the opt-in top-plugins suite
# (`E2E_TOP_PLUGINS=1`); imports the compiled validation pipeline, so its
# warnings are identical to install-time/load-time findings.
COPY test-e2e/scan-plugin.mjs /app/scan-plugin.mjs

WORKDIR /app/workspace
ENTRYPOINT ["node", "/app/bootstrap.mjs"]
CMD ["hook"]
