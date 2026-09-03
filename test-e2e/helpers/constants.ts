/**
 * Shared constants for the docker e2e suite (docs/design.md §9.2.4).
 *
 * The paths below are in-container paths: everything opencode-related runs
 * inside the image built from `test-e2e/Dockerfile`, so assertions must use
 * the container's layout, not the host's.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Release under test; overridable, must match the @opencode-ai/plugin pin. */
export const OPENCODE_VERSION = process.env['OPENCODE_VERSION'] ?? '1.18.25';

/** Image name shared by the build and the per-test containers. */
export const IMAGE_NAME = `opencode-agent-plugins-e2e:${OPENCODE_VERSION}`;

/** Where global-setup.ts records the built image tag for the test files. */
export const IMAGE_CACHE_FILE = join(tmpdir(), 'opencode-agent-plugins-e2e-image.json');

/** Port `opencode serve` listens on inside the container. */
export const API_PORT = 4096;

/** Port of the fake OpenAI-compatible model server (in-container). */
export const FAKE_MODEL_PORT = 8787;

/** Port of the remote streamable-http MCP fixture server (in-container). */
export const REMOTE_MCP_PORT = 3999;

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

/** In-container paths of the fixture plugins and the git working tree. */
export const GIT_FIXTURE_WORK = '/app/git-fixtures/work';
export const FIXTURES_DIR = '/app/fixtures';

/** The fixture's MCP tool names as opencode exposes them (server_tool). */
export const TOOL_ECHO = 'echo_echo_ping';
export const TOOL_REMOTE = 'http_ping';
export const TOOL_REDIRECT = 'redirect_ping';
export const TOOL_PATH = 'pathtool_ping';
