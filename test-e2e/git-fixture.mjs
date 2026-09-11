#!/usr/bin/env node
/**
 * Git fixture manager for the CLI e2e scenarios.
 *
 * Runs INSIDE the container (the docker image has no shell exec of its own —
 * bootstrap.mjs invokes it during `cli` setup, and the tests invoke it via
 * `container.exec` to mutate the fixture remote between CLI operations).
 *
 * Creates a bare fixture repository at `/app/git-fixtures/remote.git` whose
 * default branch is `main`, seeded from `test-e2e/fixtures/git-plugin/` at
 * version 1.0.0 (tag `v1.0.0`) plus the monorepo packages from
 * `test-e2e/fixtures/monorepo/packages/` under `packages/`, and a working
 * clone at `/app/git-fixtures/work` used to author new commits.
 *
 * Subcommands:
 *   init              create the repo (idempotent; no-op when it exists)
 *   push-version V    bump plugin.json to version V, commit, push main
 *   push-subdir-version PKG V  bump packages/PKG/plugin.json, commit, push main
 *   push-broken       commit an invalid plugin.json, push main
 *   move-tag T        move tag T to the current HEAD, force-push it
 *   head              print the current main commit SHA (for assertions)
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BARE = '/app/git-fixtures/remote.git';
const WORK = '/app/git-fixtures/work';
const SRC = '/app/fixtures/git-plugin';
const MONOREPO = '/app/fixtures/monorepo';
const MANIFEST = join(WORK, 'plugin.json');

/** Runs `git` with the given args in the given cwd (fails loudly). */
function git(args, cwd = WORK) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Fails with a message and exit code 1. */
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Creates the bare repo + working clone from the fixture source. */
function init() {
  if (existsSync(BARE)) {
    console.log('GIT_FIXTURE_EXISTS');
    return;
  }
  mkdirSync('/app/git-fixtures', { recursive: true });
  git(['init', '--bare', BARE], '/app/git-fixtures');
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], BARE);
  git(['init', '-b', 'main', WORK], '/app/git-fixtures');
  git(['config', 'user.email', 'e2e@e2e.dev'], WORK);
  git(['config', 'user.name', 'E2E'], WORK);
  cpSync(SRC, WORK, { recursive: true });
  cpSync(join(MONOREPO, 'packages'), join(WORK, 'packages'), { recursive: true });
  git(['add', '-A'], WORK);
  git(['commit', '-m', 'v1.0.0'], WORK);
  git(['remote', 'add', 'origin', BARE], WORK);
  git(['push', '-u', 'origin', 'main'], WORK);
  git(['tag', 'v1.0.0'], WORK);
  git(['push', '--tags'], WORK);
  console.log('GIT_FIXTURE_READY');
}

/** Bumps plugin.json to a version, commits and pushes main. */
function pushVersion(version) {
  if (!existsSync(MANIFEST)) {
    fail('fixture working tree is missing (run init first)');
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  manifest.version = version;
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  git(['add', 'plugin.json']);
  git(['commit', '-m', `v${version}`]);
  git(['push', 'origin', 'main']);
  console.log(`GIT_FIXTURE_PUSHED version=${version}`);
}

/** Bumps packages/<pkg>/plugin.json to a version, commits and pushes main. */
function pushSubdirVersion(pkg, version) {
  const manifestPath = join(WORK, 'packages', pkg, 'plugin.json');
  if (!existsSync(manifestPath)) {
    fail(`unknown monorepo package: ${pkg}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  git(['add', `packages/${pkg}/plugin.json`]);
  git(['commit', '-m', `${pkg} v${version}`]);
  git(['push', 'origin', 'main']);
  console.log(`GIT_FIXTURE_PUSHED subdir=${pkg} version=${version}`);
}

/** Commits an invalid plugin.json and pushes main. */
function pushBroken() {
  writeFileSync(MANIFEST, '{ not valid json\n');
  git(['add', 'plugin.json']);
  git(['commit', '-m', 'break manifest']);
  git(['push', 'origin', 'main']);
  console.log('GIT_FIXTURE_PUSHED broken');
}

/** Moves an existing tag to the current HEAD and force-pushes it. */
function moveTag(tag) {
  git(['tag', '-d', tag]);
  git(['tag', tag]);
  git(['push', '--force', 'origin', tag]);
  console.log(`GIT_FIXTURE_TAG_MOVED ${tag}`);
}

/** Prints the current main commit SHA. */
function head() {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORK }).toString().trim();
  console.log(`GIT_FIXTURE_HEAD ${sha}`);
}

const command = process.argv[2] ?? 'init';
switch (command) {
  case 'init':
    init();
    break;
  case 'push-version':
    if (process.argv[3] === undefined) {
      fail('push-version requires a version argument');
    }
    pushVersion(process.argv[3]);
    break;
  case 'push-subdir-version':
    if (process.argv[3] === undefined || process.argv[4] === undefined) {
      fail('push-subdir-version requires a package and a version argument');
    }
    pushSubdirVersion(process.argv[3], process.argv[4]);
    break;
  case 'push-broken':
    pushBroken();
    break;
  case 'move-tag':
    if (process.argv[3] === undefined) {
      fail('move-tag requires a tag argument');
    }
    moveTag(process.argv[3]);
    break;
  case 'head':
    head();
    break;
  default:
    fail(`unknown command: ${command}`);
}
