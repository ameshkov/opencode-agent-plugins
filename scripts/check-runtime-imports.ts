// Enforces the project's runtime-import boundary on the compiled output.
//
// The plugin entry and the shared core (`build/**`, except `build/cli/`) must
// not import (or re-export from) any OpenCode package: `@opencode/plugin` for
// V2 and the legacy `@opencode-ai/*` names are type-only devDependencies, and
// `@opencode/client` is a runtime dependency only the CLI needs. A leaked
// *value* import of a type-only package breaks the published plugin at
// module-load time, before `setup` runs, and OpenCode only reports a generic
// `failed to load plugin` warning.
//
// `build/cli/**` may import `@opencode/client` (and its `/service` export) for
// the reload call. It still may not import `@opencode/plugin` or the legacy
// packages. See AGENTS.md ("Dependency Management") for the full rationale.
//
// An optional first CLI argument overrides the build directory so the script
// can be driven against fixture trees in tests (avoids `process.exit(1)`
// killing the test process).
//
// Wired into `pnpm build` after compilation so a leak fails the build
// immediately.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const override = process.argv[2];
const buildDir = override ? resolve(override) : join(root, 'build');

// Matches a runtime (non-erased) reference to any OpenCode package:
//   - `import ... from '@opencode/...'` / `'@opencode-ai/...'`
//   - `export ... from '@opencode/...'`
//   - side-effect `import '@opencode/...'`
//   - dynamic `import('@opencode/...')`
// `import type` is erased by `tsc` and never appears in `build/`, so any
// match here is a leaked value import. Comments are stripped before scanning
// (see `stripComments`) so prose mentions of these packages in JSDoc do not
// produce false positives.
const SDK_IMPORT_RE = /\b(?:from|import)\s*\(?\s*['"]@opencode(?:-ai)?\//;

/**
 * Removes the one runtime OpenCode import the CLI may use.
 *
 * `@opencode/client` and its `/service` export are allowed only in
 * `build/cli/**`; after removing them, any remaining match is a violation.
 *
 * @param line - A comment-stripped source line.
 * @param isCliFile - True when the file lives under `build/cli/`.
 * @returns The line with allowed client imports removed.
 */
function withoutAllowedClientImports(line: string, isCliFile: boolean): string {
  if (!isCliFile) {
    return line;
  }
  return line.replace(/@opencode\/client(?:\/service)?/g, '');
}

/**
 * Neutralise `//` line comments and `/* ... *&#47;` block comments in compiled
 * source so the import scan only sees real code. Newlines are preserved (block
 * comments are blanked to spaces) so reported line numbers stay accurate.
 * tsc-emitted `.js` does not embed `@opencode-ai` inside string/regex
 * literals, so comment-stripping is safe for leak detection here.
 *
 * @param src - Compiled source text.
 * @returns The source with comments neutralised.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/\/\/.*$/gm, '');
}

if (!statSync(buildDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(
    `check-runtime-imports: build/ not found at ${buildDir}. Run \`pnpm build\` first.`,
  );
  process.exit(1);
}

/**
 * Recursively collect every compiled `.js` file under `dir`.
 *
 * @param dir - Directory to scan.
 * @returns Absolute paths of the compiled files.
 */
function collectJs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectJs(full));
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/** A leaked import found in the compiled output. */
interface Offender {
  file: string;
  line: number;
  text: string;
}

const offenders: Offender[] = [];
for (const file of collectJs(buildDir)) {
  // Map stripped offsets back to original 1-based line numbers by scanning
  // whole-file content line-by-line after stripping comments.
  const raw = readFileSync(file, 'utf8');
  const stripped = stripComments(raw);
  const lines = stripped.split('\n');
  const isCliFile = relative(buildDir, file).split(sep)[0] === 'cli';
  lines.forEach((line, i) => {
    const checked = withoutAllowedClientImports(line, isCliFile);
    if (SDK_IMPORT_RE.test(checked)) {
      offenders.push({ file: relative(root, file), line: i + 1, text: line.trim() });
    }
  });
}

if (offenders.length > 0) {
  console.error('check-runtime-imports: leaked OpenCode runtime import(s) in build/:');
  for (const { file, line, text } of offenders) {
    console.error(`  ${file}:${line}: ${text}`);
  }
  console.error('');
  console.error('The plugin entry and src/lib/ may not import any OpenCode package at');
  console.error('runtime. Use `import type { ... }` for @opencode/plugin so tsc erases it;');
  console.error('a surviving value import breaks the published plugin at module-load time.');
  console.error('Only build/cli/** may import @opencode/client (the reload call).');
  process.exit(1);
}

console.log('check-runtime-imports: no disallowed OpenCode runtime imports in build/');
