// Enforces the project's zero-runtime-imports invariant on the compiled
// output: no compiled module (`build/**`, including the CLI) may import (or
// re-export from) the type-only SDK packages (`@opencode-ai/plugin`,
// `@opencode-ai/sdk`).
//
// These packages are devDependencies used only for types and are erased by
// `tsc` when imported via `import type`. A leaked *value* import surviving
// into `build/` breaks the published plugin at runtime when loaded from npm
// (where the SDK packages are not installed): Node throws
// `ERR_MODULE_NOT_FOUND` during module import — before the plugin's `config`
// hook ever runs, leaving no diagnostic in the log. See AGENTS.md
// ("Dependency Management") for the full rationale.
//
// An optional first CLI argument overrides the build directory so the script
// can be driven against fixture trees in tests (avoids `process.exit(1)`
// killing the test process).
//
// Wired into `pnpm build` after compilation so a leak fails the build
// immediately.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const override = process.argv[2];
const buildDir = override ? resolve(override) : join(root, 'build');

// Matches a runtime (non-erased) reference to any `@opencode-ai/*` package:
//   - `import ... from '@opencode-ai/...'`
//   - `export ... from '@opencode-ai/...'`
//   - side-effect `import '@opencode-ai/...'`
//   - dynamic `import('@opencode-ai/...')`
// `import type` is erased by `tsc` and never appears in `build/`, so any
// match here is a leaked value import. Comments are stripped before scanning
// (see `stripComments`) so prose mentions of these packages in JSDoc do not
// produce false positives.
const SDK_IMPORT_RE = /\b(?:from|import)\s*\(?\s*['"]@opencode-ai\//;

/**
 * Neutralise `//` line comments and `/* ... *&#47;` block comments in compiled
 * source so the import scan only sees real code. Newlines are preserved (block
 * comments are blanked to spaces) so reported line numbers stay accurate.
 * tsc-emitted `.js` does not embed `@opencode-ai` inside string/regex
 * literals, so comment-stripping is safe for leak detection here.
 */
function stripComments(src) {
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
 */
function collectJs(dir) {
  const out = [];
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

const offenders = [];
for (const file of collectJs(buildDir)) {
  // Map stripped offsets back to original 1-based line numbers by scanning
  // whole-file content line-by-line after stripping comments.
  const raw = readFileSync(file, 'utf8');
  const stripped = stripComments(raw);
  const lines = stripped.split('\n');
  lines.forEach((line, i) => {
    if (SDK_IMPORT_RE.test(line)) {
      offenders.push({ file: relative(root, file), line: i + 1, text: line.trim() });
    }
  });
}

if (offenders.length) {
  console.error('check-runtime-imports: leaked @opencode-ai runtime import(s) in build/:');
  for (const { file, line, text } of offenders) {
    console.error(`  ${file}:${line}: ${text}`);
  }
  console.error('');
  console.error('The @opencode-ai/plugin and @opencode-ai/sdk packages are devDependencies');
  console.error('(type-only). Use `import type { ... }` so tsc erases them; a surviving');
  console.error('value import breaks the published plugin at module-load time.');
  process.exit(1);
}

console.log('check-runtime-imports: no @opencode-ai runtime imports in build/');
