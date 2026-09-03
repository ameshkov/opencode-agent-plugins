# syntax=docker/dockerfile:1

# E2E image: a real, pinned opencode binary plus the plugin built from this
# repo, the fixture plugin package, and a fake OpenAI-compatible model server.
# EVERYTHING opencode-related runs inside this container; the vitest host only
# starts/stops containers through testcontainers and asserts on the captured
# model request (docs/design.md §9.1, §9.2.4).
#
# Build (from the repo root):
#   docker build -f test-e2e/Dockerfile \
#     --build-arg OPENCODE_VERSION=1.18.25 -t opencode-agent-plugins-e2e:1.18.25 .
#
# Run manually:
#   docker run --rm -p 4096:4096 opencode-agent-plugins-e2e:1.18.25 hook

ARG OPENCODE_VERSION=1.18.25

FROM node:22-bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

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
RUN npm install --omit=dev --no-fund --no-audit

# Fixture plugin: install its MCP SDK dependency, then copy the package
# (exec bit for bin/serve.js is ensured explicitly).
WORKDIR /app/fixtures/my-plugin
COPY test-e2e/fixtures/my-plugin/package.json /app/fixtures/my-plugin/package.json
RUN npm install --no-fund --no-audit
COPY test-e2e/fixtures/my-plugin/ /app/fixtures/my-plugin/
RUN chmod +x /app/fixtures/my-plugin/bin/serve.js

# Container bootstrap: starts the fake model server (in-process), writes the
# config for the mode, and runs `opencode serve` (published port 4096). The
# vitest host drives everything through the server API — no shell involved.
COPY test-e2e/fake-model-server.mjs /app/fake-model-server.mjs
COPY test-e2e/write-config.mjs /app/write-config.mjs
COPY test-e2e/bootstrap.mjs /app/bootstrap.mjs

WORKDIR /app/workspace
ENTRYPOINT ["node", "/app/bootstrap.mjs"]
CMD ["hook"]
