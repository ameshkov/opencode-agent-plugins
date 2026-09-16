# syntax=docker/dockerfile:1

# E2E image: a real, pinned opencode binary plus the plugin built from this
# repo, the fixture plugin packages, and a fake OpenAI-compatible model server.
# EVERYTHING opencode-related runs inside this container; the vitest host only
# starts/stops containers through testcontainers and asserts on the captured
# model request (docs/explanation/design.md §9.1, §9.2.4).
#
# Build (from the repo root):
#   docker build -f test-e2e/Dockerfile \
#     --build-arg OPENCODE_VERSION=1.18.30 -t opencode-agent-plugins-e2e:1.18.30 .
#
# Run manually:
#   docker run --rm -p 4096:4096 opencode-agent-plugins-e2e:1.18.30 hook

ARG OPENCODE_VERSION=1.18.30

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
# §5.11) and by the git fixture manager that mutates the fixture remote.
# ca-certificates is required for HTTPS remotes (GitHub): the slim base image
# ships no CA bundle, and git fails TLS verification without it (npm works
# because Node bundles its own roots).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The release the plugin is verified against — matches the
# @opencode-ai/plugin devDependency and the OPENCODE_VERSION CI env. The
# OpenAI-compatible provider package used by the fake model endpoint is
# preinstalled so opencode resolves it from the global root at runtime.
RUN npm install --global --no-fund --no-audit "opencode-ai@${OPENCODE_VERSION}" \
  && npm install --global --no-fund --no-audit "@ai-sdk/openai-compatible@3.0.41"

WORKDIR /app

# The plugin, compiled from this repo (build/ output only; the build gate
# already guarantees zero @opencode-ai runtime imports). Copied with its
# package.json so the loader treats build/index.js as ESM, and its runtime
# deps (zod, ajv, jsonc-parser) are installed — without them the plugin
# import fails silently at load (§9.1.2).
WORKDIR /app/plugin
COPY build/ /app/plugin/build/
COPY package.json /app/plugin/package.json
# No lockfile in the image (deps are pinned in package.json) and
# --legacy-peer-deps: the full dev tree (vitest et al.) triggers a known npm
# arborist crash ("Cannot read properties of null (reading 'edgesOut')")
# while walking peer sets; the runtime deps have no peers, so nothing is
# lost here.
RUN npm install --omit=dev --no-fund --no-audit --package-lock=false --legacy-peer-deps

# The same plugin as the npm package `opencode-agent-plugins` — the name the
# CLI registers in the config (§5.11). Installed into the global npm root
# (alongside opencode-ai) AND the workspace project dir, so opencode can
# resolve the package-name plugin entry from either resolution base (an
# unresolvable name is skipped silently at load, finding §9.1.2).
RUN npm install --global --no-fund --no-audit --omit=dev --legacy-peer-deps /app/plugin
RUN mkdir -p /app/workspace \
  && printf '{\n  "name": "e2e-workspace",\n  "private": true\n}\n' > /app/workspace/package.json \
  && cd /app/workspace \
  && npm install --no-save --no-fund --no-audit --omit=dev --legacy-peer-deps --package-lock=false /app/plugin

# Seed opencode's managed plugin package cache: 1.18.x resolves npm-name
# plugin entries through its own `Npm.add` (registry install into
# <cache>/packages/<spec>). `opencode-agent-plugins` is not published
# (registry 404), so we place the package (with its runtime deps) exactly
# where opencode's short-circuit `existsSafe` check looks — under BOTH spec
# spellings the loader may consult (`opencode-agent-plugins` and
# `opencode-agent-plugins@latest`; the checked string depends on the
# release).
RUN set -eux; \
  for spec in opencode-agent-plugins opencode-agent-plugins@latest; do \
    mkdir -p "/app/opencode-home/.cache/opencode/packages/$spec/node_modules"; \
    cp -R /app/plugin "/app/opencode-home/.cache/opencode/packages/$spec/node_modules/opencode-agent-plugins"; \
  done

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
# (the skill-collision scenario; user config wins, §3.2/§5.6).
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
