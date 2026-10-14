/**
 * Shared constants for the docker e2e suite (docs/explanation/design.md §9.2.4).
 *
 * The paths below are in-container paths: everything opencode-related runs
 * inside the image built from `test-e2e/Dockerfile`, so assertions must use
 * the container's layout, not the host's.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Release under test; overridable, must match the @opencode/plugin pin. */
export const OPENCODE_VERSION = process.env['OPENCODE_VERSION'] ?? '2.0.16';

/** Image name shared by the build and the per-test containers. */
export const IMAGE_NAME = `opencode-agent-plugins-e2e:${OPENCODE_VERSION}`;

/** Where global-setup.ts records the built image tag for the test files. */
export const IMAGE_CACHE_FILE = join(tmpdir(), 'opencode-agent-plugins-e2e-image.json');

/** Port `opencode serve` listens on inside the container. */
export const API_PORT = 4096;

/** Plugin id the loader registers under (V2 plugin id). */
export const PLUGIN_ID = 'opencode-agent-plugins';

/**
 * Basic-auth password the container's `opencode serve` starts with.
 *
 * Generated per run so no credential lives in the repository (AGENTS.md,
 * "Secrets and API keys"); `E2E_SERVER_PASSWORD` overrides it for
 * deterministic runs. The scenario passes it to the container as
 * `E2E_SERVER_PASSWORD` and uses it for the host-side client.
 */
export const SERVER_PASSWORD = process.env['E2E_SERVER_PASSWORD'] ?? randomUUID();

/** Port of the fake OpenAI-compatible model server (in-container). */
export const FAKE_MODEL_PORT = 8787;

/** Plugin name/values the assertions use (see fixtures + §5.7–§5.8). */
export const PLUGIN_ROOT = '/app/fixtures/my-plugin';

/** Store root under the redirect-HOME (opencode convention, §5.8). */
export const STORE_DIR = '/app/opencode-home/.local/share/opencode/agent-plugins';

/** PLUGIN_DATA key prefix of the path-sourced fixture (`<name>-<hash8>`). */
export const DATA_DIR_PREFIX = `${STORE_DIR}/data/hello-`;

/** The handwritten static-mode data dir (never created by the loader). */
export const STATIC_DATA_DIR = '/app/static-data/hello';

/** The git fixture remote and its store slug (derived from the URL). */
export const GIT_FIXTURE_SOURCE = 'file:///app/git-fixtures/remote.git';
export const GIT_FIXTURE_SLUG = 'git-fixtures-remote';

/** Monorepo subpath packages seeded under `packages/` of the git fixture. */
export const GIT_SUBDIR_ALPHA_SOURCE = `${GIT_FIXTURE_SOURCE}#:packages/alpha`;
/**
 * Subdir slug (`<url slug>-<flattened subdir>-<hash8>`, §5.3.4); the hash is
 * the first 8 hex chars of the SHA-256 of the lowercased canonical subdir.
 */
export const GIT_SUBDIR_ALPHA_SLUG = `${GIT_FIXTURE_SLUG}-packages-alpha-922b0764`;
export const GIT_SUBDIR_BETA_SOURCE = `${GIT_FIXTURE_SOURCE}#:packages/beta`;
export const GIT_SUBDIR_BETA_SLUG = `${GIT_FIXTURE_SLUG}-packages-beta-01bea2ef`;

/** In-container paths of the fixture plugins and the git working tree. */
export const GIT_FIXTURE_WORK = '/app/git-fixtures/work';
export const FIXTURES_DIR = '/app/fixtures';

/**
 * V2 exposes MCP tools through Code Mode by default, so the e2e drives them
 * with an `execute` tool call whose code invokes the tool by its Code Mode
 * path (`tools.<server>.<tool>`, normalized server name).
 */
export const CODE_ECHO = "return await tools.echo.echo_ping({ message: 'hello from e2e' })";
export const CODE_REMOTE = "return await tools.http.ping({ message: 'hello from e2e' })";
export const CODE_REDIRECT = "return await tools.redirect.ping({ message: 'hello from e2e' })";
export const CODE_PATH = "return await tools.pathtool.ping({ message: 'hello from e2e' })";
