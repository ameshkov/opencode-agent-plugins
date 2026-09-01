/**
 * Minimal YAML frontmatter parser for `SKILL.md` files.
 *
 * The Agent Skills format requires `---`-delimited YAML frontmatter with at
 * least `name` and `description`. Full YAML is overkill for the subset used by
 * skill files, and the dependency-free rule for `src/lib/` (only `node:*`,
 * Ajv, Zod, `jsonc-parser` — see AGENTS.md) forbids a YAML library. This
 * parser handles the subset that skills actually use:
 *
 * - `key: value` with optional single/double quotes around the value;
 * - literal (`|`) and folded (`>`) multi-line blocks (the common
 *   `description` shapes);
 * - `#` comment lines;
 * - the YAML scalars `true`, `false`, `null`.
 *
 * Unknown keys and more exotic structures are preserved as raw strings — the
 * parser never throws, so a skill with exotic frontmatter is classified by the
 * `name`/`description` checks rather than crashing discovery.
 */

/** Parsed frontmatter metadata: keys are lowered, values are typed scalars. */
export type Frontmatter = Record<string, unknown>;

/**
 * Parses the `---`-delimited frontmatter block of a text file.
 *
 * @param source - Full file content.
 * @returns The parsed metadata, or null when the file has no frontmatter
 * block or the block is malformed (missing closing delimiter).
 */
export function parseFrontmatter(source: string): Frontmatter | null {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return null;
  }
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line.trim()));
  if (end === -1) {
    return null;
  }
  return parseBlock(lines.slice(1, end));
}

/**
 * Parses the lines between the frontmatter delimiters into a metadata map.
 *
 * @param lines - Frontmatter body lines.
 * @returns The parsed metadata.
 */
function parseBlock(lines: string[]): Frontmatter {
  const result: Frontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line) || isComment(line)) {
      i += 1;
      continue;
    }
    const parsed = parseKeyValue(line);
    if (parsed === null) {
      i += 1;
      continue;
    }
    const { key, value } = parsed;
    if (value === '|' || value === '>') {
      const { text, consumed } = collectBlock(lines, i + 1);
      result[key] = value === '>' ? text.replace(/\n/g, ' ').trim() : text;
      i += consumed;
    } else {
      result[key] = parseScalar(value);
      i += 1;
    }
  }
  return result;
}

/** Checks whether a line is blank (whitespace only). */
function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** Checks whether a line is a YAML comment. */
function isComment(line: string): boolean {
  return line.trimStart().startsWith('#');
}

/**
 * Splits a `key: value` line.
 *
 * @param line - The line to parse.
 * @returns The key and raw value, or null when the line is not a mapping.
 */
function parseKeyValue(line: string): { key: string; value: string } | null {
  const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
  if (match === null) {
    return null;
  }
  return { key: match[1]!.toLowerCase(), value: match[2]!.trim() };
}

/**
 * Collects the lines of a multi-line scalar (`|` or `>`) block.
 *
 * The block ends at the first mapping/comment-ish line (a line starting at
 * column 0 with a `key:` pattern), at a de-indent to nothing, or at the end of
 * the frontmatter body. Common indentation is stripped.
 *
 * @param lines - Remaining frontmatter lines (after the `|`/`>` line).
 * @returns The joined text and the number of consumed lines.
 */
function collectBlock(lines: string[], from: number): { text: string; consumed: number } {
  const body: string[] = [];
  let i = from;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      body.push('');
      i += 1;
      continue;
    }
    if (isComment(line)) {
      i += 1;
      continue;
    }
    // A new mapping entry ends the block. It starts at column 0 with a key.
    if (/^[A-Za-z0-9_-]+:/.test(line)) {
      break;
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      break;
    }
    body.push(line.slice(indent));
    i += 1;
  }
  // Trailing blank lines inside the block carry no meaning.
  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop();
  }
  return { text: body.join('\n'), consumed: i - from };
}

/**
 * Converts a raw scalar string into a typed value.
 *
 * Double-quoted strings get the common escape sequences unquoted; single
 * quotes are taken literally; the YAML boolean/null scalars are converted.
 * Anything else stays a trimmed string.
 *
 * @param raw - The raw scalar text.
 * @returns The typed scalar value.
 */
function parseScalar(raw: string): unknown {
  if (raw === '') {
    return null;
  }
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return unquoteDouble(raw.slice(1, -1));
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (raw === 'null' || raw === '~') {
    return null;
  }
  return raw;
}

/**
 * Unquotes the common double-quoted escape sequences.
 *
 * @param inner - The string between the quotes.
 * @returns The unescaped string.
 */
function unquoteDouble(inner: string): string {
  return inner.replace(/\\(["\\nrt])/g, (_match, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return ch;
    }
  });
}
