# syntax=docker/dockerfile:1

# Multi-stage Dockerfile that runs the full quality gate (format, lint,
# type-check, unit tests). Each gate is a stage that writes a *-results.txt
# file, and each has a `FROM scratch` collector stage so `--output
# type=local` yields only that result file. Usage:
#
#   docker build --output type=local,dest=./ci-output .                          # all gates
#   docker build --target lint-output      --output type=local,dest=./ci-output .
#   docker build --target unit-test-output --output type=local,dest=./ci-output .
#
# The default (final) stage, `ci-output`, is a scratch image that collects
# every result file.

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

# Use bash with pipefail for every RUN so a failing command piped into `tee`
# (used by the lint/test stages to capture results) propagates its non-zero
# exit status instead of being masked by `tee`, which always exits 0. The
# default /bin/sh on this image is dash, which returns the *last* command's
# status for a pipeline. This SHELL is inherited by every stage built
# `FROM deps` (build, lint, unit-test).
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# pnpm is pinned to the version the project is developed against.
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

WORKDIR /app

# Copy lockfile and manifest first for layer caching.
COPY package.json pnpm-lock.yaml ./

RUN --mount=type=cache,target=/pnpm,id=opencode-agent-plugins-pnpm \
    pnpm install \
    --frozen-lockfile \
    --prefer-offline \
    --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 2: Copy source and compile
# ---------------------------------------------------------------------------
FROM deps AS build

COPY . .

RUN pnpm build

# ---------------------------------------------------------------------------
# Stage 3: Format, lint, and type checks
# ---------------------------------------------------------------------------
FROM build AS lint

RUN pnpm format:check 2>&1 | tee /tmp/lint-results.txt
RUN pnpm lint 2>&1 | tee -a /tmp/lint-results.txt
RUN pnpm typecheck 2>&1 | tee -a /tmp/lint-results.txt

# ---------------------------------------------------------------------------
# Stage 4: Unit tests
# ---------------------------------------------------------------------------
FROM build AS unit-test

RUN pnpm test 2>&1 | tee /tmp/unit-test-results.txt

# ---------------------------------------------------------------------------
# Stage 5: Output collectors
#
# Each gate has its own `FROM scratch` collector so `--output type=local`
# against its target yields ONLY that gate's result file (not the whole app
# tree). The default target (`ci-output`) collects both.
# ---------------------------------------------------------------------------
FROM scratch AS lint-output
COPY --from=lint /tmp/lint-results.txt /lint-results.txt

FROM scratch AS unit-test-output
COPY --from=unit-test /tmp/unit-test-results.txt /unit-test-results.txt

# Default target — all result files.
FROM scratch AS ci-output
COPY --from=lint /tmp/lint-results.txt /lint-results.txt
COPY --from=unit-test /tmp/unit-test-results.txt /unit-test-results.txt
