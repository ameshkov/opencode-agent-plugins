// Enforces the failure-taxonomy invariant (docs/design.md §6): every kind
// declared in the `FailureKind` union (`src/lib/errors.ts`) must be produced
// by a `failure('<kind>', ...)` literal somewhere in production `src/`, and
// every such literal must refer to a declared kind. This keeps the taxonomy
// contract exercised on both surfaces (plugin load and CLI) — a declared but
// dead kind, or an undeclared literal, fails the build immediately instead of
// silently drifting from the design table.
//
// Wired into `pnpm build` after compilation, next to
// `scripts/check-runtime-imports.ts`. Imported (never executed on import) by
// `scripts/check-failure-kinds.test.ts`; the gate runs only when invoked as
// `node scripts/check-failure-kinds.ts`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'src');

// A `failure('<kind>', ...)` construction, allowing a newline between the
// call and the kind literal (the codebase splits these across lines).
const FAILURE_CALL_RE = /failure\(\s*'([a-z][a-z-]*)'/g;
// A kind literal inside the `FailureKind` union block.
const KIND_RE = /'([a-z][a-z-]*)'/g;

/** Constructs an open lexing state for `stripComments`. */
type ScannerMode = 'code' | 'interp' | 'line' | 'block' | 'single' | 'double' | 'template';

/** One frame of the `stripComments` lexer stack. */
interface ScannerFrame {
  mode: ScannerMode;
  /** `{`/`}` nesting depth inside a template `${...}` interpolation. */
  depth: number;
}

/** One step of the `stripComments` lexer: output and next index. */
interface ScanStep {
  out: string;
  i: number;
}

/**
 * Strips `//` line comments and `/* ... *&#47;` block comments from
 * TypeScript source so comment prose (e.g. `// failure('x')` notes) never
 * counts as production.
 *
 * The scanner is string-aware: `//` or `/*` inside a single-, double- or
 * template-quoted string (e.g. a `https://...` URL literal) is preserved, and
 * template `${...}` interpolations are re-scanned as code, so a
 * `failure('<kind>', ...)` call sharing a line with a URL string is still
 * seen. Newlines are preserved so diagnostics keep accurate line numbers.
 *
 * @param src - TypeScript source text.
 * @returns The source with comments neutralised and strings left untouched.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const frames: ScannerFrame[] = [{ mode: 'code', depth: 0 }];
  while (i < src.length) {
    const step = scanStep(src, out, i, frames);
    out = step.out;
    i = step.i;
  }
  return out;
}

/** Dispatches one lexing step to the handler of the current mode. */
function scanStep(src: string, out: string, i: number, frames: ScannerFrame[]): ScanStep {
  const frame = frames[frames.length - 1];
  if (frame.mode === 'code' || frame.mode === 'interp') {
    return scanCode(src, out, i, frames);
  }
  if (frame.mode === 'line') {
    return scanLine(src, out, i, frames);
  }
  if (frame.mode === 'block') {
    return scanBlock(src, out, i, frames);
  }
  if (frame.mode === 'single' || frame.mode === 'double') {
    return scanQuoted(src, out, i, frame.mode, frames);
  }
  return scanTemplate(src, out, i, frames);
}

/** Advances one token in plain code (or inside a template `${...}`). */
function scanCode(src: string, out: string, i: number, frames: ScannerFrame[]): ScanStep {
  const ch = src[i];
  const next = src[i + 1];
  if (ch === '/' && next === '/') {
    frames.push({ mode: 'line', depth: 0 });
    return { out, i: i + 2 };
  }
  if (ch === '/' && next === '*') {
    frames.push({ mode: 'block', depth: 0 });
    return { out, i: i + 2 };
  }
  if (ch === "'" || ch === '"') {
    frames.push({ mode: ch === "'" ? 'single' : 'double', depth: 0 });
    return { out: out + ch, i: i + 1 };
  }
  if (ch === '`') {
    frames.push({ mode: 'template', depth: 0 });
    return { out: out + ch, i: i + 1 };
  }
  // `{`/`}` at the top level are plain code; inside an interpolation they
  // balance the `${` token and, once the depth returns to zero, close it.
  const frame = frames[frames.length - 1];
  if (ch === '{' && frame.mode === 'interp') {
    frame.depth += 1;
  } else if (ch === '}' && frame.mode === 'interp' && frame.depth > 0) {
    frame.depth -= 1;
  } else if (ch === '}' && frame.mode === 'interp') {
    frames.pop();
  }
  return { out: out + ch, i: i + 1 };
}

/** Advances until the end of a line comment, keeping the newline. */
function scanLine(src: string, out: string, i: number, frames: ScannerFrame[]): ScanStep {
  if (src[i] === '\n') {
    frames.pop();
    return { out: out + '\n', i: i + 1 };
  }
  return { out, i: i + 1 };
}

/** Advances until the end of a block comment, keeping only its newlines. */
function scanBlock(src: string, out: string, i: number, frames: ScannerFrame[]): ScanStep {
  if (src[i] === '*' && src[i + 1] === '/') {
    frames.pop();
    return { out, i: i + 2 };
  }
  const ch = src[i];
  return { out: ch === '\n' ? out + ch : out, i: i + 1 };
}

/** Advances inside a `'...'` or `"..."` string; `\` escapes the next char. */
function scanQuoted(
  src: string,
  out: string,
  i: number,
  quote: 'single' | 'double',
  frames: ScannerFrame[],
): ScanStep {
  const ch = src[i];
  if (ch === '\\' && i + 1 < src.length) {
    return { out: out + ch + src[i + 1], i: i + 2 };
  }
  if ((quote === 'single' && ch === "'") || (quote === 'double' && ch === '"')) {
    frames.pop();
  }
  return { out: out + ch, i: i + 1 };
}

/** Advances inside a template literal; `${` opens a code interpolation. */
function scanTemplate(src: string, out: string, i: number, frames: ScannerFrame[]): ScanStep {
  const ch = src[i];
  const next = src[i + 1];
  if (ch === '\\' && i + 1 < src.length) {
    return { out: out + ch + src[i + 1], i: i + 2 };
  }
  if (ch === '`') {
    frames.pop();
    return { out: out + ch, i: i + 1 };
  }
  if (ch === '$' && next === '{') {
    frames.push({ mode: 'interp', depth: 0 });
    return { out: out + ch + next, i: i + 2 };
  }
  return { out: out + ch, i: i + 1 };
}

/** Recursively collects every production `.ts` file under `dir`. */
function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTs(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 1-based line number of the first occurrence of `needle` in `src`. */
function lineOf(src: string, needle: string): number {
  const lines = src.split('\n');
  const idx = lines.findIndex((line) => line.includes(needle));
  return idx === -1 ? 1 : idx + 1;
}

/** A taxonomy-drift finding against the declared `FailureKind` union. */
interface Offender {
  file: string;
  line: number;
  detail: string;
}

/**
 * Extracts the declared kinds from the `FailureKind` union.
 *
 * Fails closed: an empty `declared` set would make the gate a silent no-op,
 * exactly the drift it is meant to catch (e.g. if the union is refactored
 * away from single-quoted kind literals).
 *
 * @param errorsSource - Raw source of `src/lib/errors.ts`.
 * @returns The declared kind literals.
 */
function declaredKinds(errorsSource: string): string[] {
  const union = /export type FailureKind =([\s\S]*?);/.exec(stripComments(errorsSource));
  if (union === null) {
    console.error('check-failure-kinds: cannot find the FailureKind union in src/lib/errors.ts');
    process.exit(1);
  }
  const declared = [...union[1].matchAll(KIND_RE)].map((match) => match[1]);
  if (declared.length === 0) {
    console.error('check-failure-kinds: no kind literals found in the FailureKind union;');
    console.error(
      'the gate only understands single-quoted kind literals — verify src/lib/errors.ts',
    );
    process.exit(1);
  }
  return declared;
}

/**
 * Finds taxonomy drift: kinds used by a `failure('<kind>', ...)` literal but
 * not declared, and declared kinds never produced in production `src/`.
 *
 * @param declared - The declared kind literals.
 * @param errorsSource - Raw source of `src/lib/errors.ts`.
 * @param errorsPath - Absolute path of `src/lib/errors.ts` (for reporting).
 * @returns The drift findings, empty when the taxonomy is in sync.
 */
function collectOffenders(
  declared: string[],
  errorsSource: string,
  errorsPath: string,
): Offender[] {
  const used = new Set<string>();
  const offenders: Offender[] = [];
  for (const file of collectTs(srcDir)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const match of src.matchAll(FAILURE_CALL_RE)) {
      const kind = match[1];
      used.add(kind);
      if (!declared.includes(kind)) {
        // The literal may sit on the line after `failure(`; report the literal
        // line (the `'<kind>'` string itself).
        offenders.push({
          file: relative(root, file),
          line: lineOf(src, `'${kind}'`),
          detail: `failure('${kind}') uses a kind not declared in the FailureKind union`,
        });
      }
    }
  }
  for (const kind of declared) {
    if (!used.has(kind)) {
      offenders.push({
        file: relative(root, errorsPath),
        line: lineOf(errorsSource, `'${kind}'`),
        detail: `kind '${kind}' is declared but never produced in src/`,
      });
    }
  }
  return offenders;
}

/** Prints the drift findings and fails the build. */
function failWithOffenders(offenders: Offender[]): never {
  console.error('check-failure-kinds: failure taxonomy drift in src/:');
  for (const { file, line, detail } of offenders) {
    console.error(`  ${file}:${line}: ${detail}`);
  }
  console.error('');
  console.error(
    "Every kind in the FailureKind union must be produced by a `failure('<kind>', ...)`",
  );
  console.error(
    'call in production src/ (plugin load or CLI), matching docs/design.md §6 — and every',
  );
  console.error("failure('<kind>') literal must be a declared kind. Add or remove kinds in sync.");
  process.exit(1);
}

/** Runs the gate over production `src/`. */
function main(): void {
  const errorsPath = join(srcDir, 'lib', 'errors.ts');
  const errorsSource = readFileSync(errorsPath, 'utf8');
  const declared = declaredKinds(errorsSource);
  const offenders = collectOffenders(declared, errorsSource, errorsPath);
  if (offenders.length > 0) {
    failWithOffenders(offenders);
  }
  console.log(`check-failure-kinds: all ${declared.length} failure kinds produced in src/`);
}

// The gate runs only when invoked as `node scripts/check-failure-kinds.ts`;
// importing it (from the unit test) must stay side-effect free.
if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main();
}
