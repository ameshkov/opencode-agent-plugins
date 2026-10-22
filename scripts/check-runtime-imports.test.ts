// Unit tests for the runtime-import gate (`scripts/check-runtime-imports.ts`).
//
// The gate calls `process.exit`, so each case runs it in a child process
// against a fixture tree passed as the first argument. The negative cases also
// assert the gate's own error line, so a crash in the child cannot pass as a
// detected leak.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const script = fileURLToPath(new URL('./check-runtime-imports.ts', import.meta.url));

/** A temporary fixture tree plus its cleanup. */
interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

/** Gate result with the captured streams. */
interface GateResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Writes a fixture tree.
 *
 * @param files - Map of relative path → file content.
 * @returns The fixture root and its cleanup.
 */
async function fixture(files: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'oap-imports-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * Reads a child-process error without an unsafe cast.
 *
 * @param error - The rejection value from `execFile`.
 * @returns The exit code and captured output, or the original error.
 */
function resultOf(error: unknown): GateResult {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const record = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof record.code === 'number') {
      return {
        code: record.code,
        stdout: typeof record.stdout === 'string' ? record.stdout : '',
        stderr: typeof record.stderr === 'string' ? record.stderr : '',
      };
    }
  }
  throw error;
}

/**
 * Runs the gate against a fixture build directory.
 *
 * @param buildDir - The fixture build directory.
 * @returns The exit code and captured output.
 */
async function runGate(buildDir: string): Promise<GateResult> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [script, buildDir]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return resultOf(error);
  }
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((created) => created.cleanup()));
});

describe('check-runtime-imports gate', () => {
  it('allows @opencode/client under build/cli/', async () => {
    const created = await fixture({
      'build/cli/foo.js': "import { OpenCode } from '@opencode/client';\n",
    });
    fixtures.push(created);

    const result = await runGate(join(created.root, 'build'));

    expect(result.code).toBe(0);
  });

  it('rejects @opencode/client outside build/cli/', async () => {
    const created = await fixture({
      'build/lib/foo.js': "import { OpenCode } from '@opencode/client';\n",
    });
    fixtures.push(created);

    const result = await runGate(join(created.root, 'build'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('leaked OpenCode runtime import');
  });

  it('rejects @opencode/plugin under build/cli/', async () => {
    const created = await fixture({
      'build/cli/foo.js': "import { Plugin } from '@opencode/plugin';\n",
    });
    fixtures.push(created);

    const result = await runGate(join(created.root, 'build'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('leaked OpenCode runtime import');
  });

  it('rejects a line that mixes the allowed and a forbidden import', async () => {
    const created = await fixture({
      'build/cli/foo.js':
        "import { OpenCode } from '@opencode/client'; import { Plugin } from '@opencode/plugin';\n",
    });
    fixtures.push(created);

    const result = await runGate(join(created.root, 'build'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('leaked OpenCode runtime import');
  });
});
