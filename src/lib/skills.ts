/**
 * Skill discovery and validation (`docs/explanation/design.md` §5.6).
 *
 * Skills live at the fixed location `skills/<name>/SKILL.md` — immediate
 * children only, no recursion. Missing `skills/` is a valid absence. Each
 * skill is validated against the Agent Skills format requirements that
 * matter for registration (`name`, `description`); invalid skills are skipped
 * with a warning so the rest of the plugin keeps loading.
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import type { Failure } from './errors.js';
import { failure } from './errors.js';
import { isInside } from './paths.js';

/** Valid skill names: lowercase words separated by single dashes. */
/** @internal Exported for tests only; not part of the public module API. */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Maximum length of a skill name. */
const SKILL_NAME_MAX = 64;

/** Maximum length of a skill description (Agent Skills). */
const SKILL_DESCRIPTION_MAX = 1024;

/** A discovered, validated skill. */
export interface SkillInfo {
  /** Skill name, equal to the directory name in `skills/`. */
  name: string;
  /** Absolute path of the skill directory. */
  dir: string;
  /** Skill description from the frontmatter. */
  description: string;
  /** Absolute path of the skill's `SKILL.md` file. */
  skillMd: string;
  /** Raw `SKILL.md` content (registered verbatim in V2). */
  content: string;
}

/** Result of scanning a plugin's `skills/` directory. */
export interface SkillDiscovery {
  /** True when the plugin has no `skills/` directory (valid absence). */
  missing: boolean;
  /** Valid skills found (each to be registered individually). */
  skills: SkillInfo[];
  /** Non-fatal failures: invalid skills and nested `SKILL.md` warnings. */
  failures: Failure[];
}

/**
 * Discovers and validates the skills of a plugin.
 *
 * @param pluginRoot - Absolute plugin root directory.
 * @returns The discovery result; never throws (I/O errors surface as
 * non-fatal failures unless the `skills` entry itself is not a directory,
 * which is a plugin-level problem reported as a skill failure).
 */
export async function discoverSkills(pluginRoot: string): Promise<SkillDiscovery> {
  const skillsRoot = join(pluginRoot, 'skills');
  const sk = await stat(skillsRoot).catch(() => null);
  if (sk === null) {
    return { missing: true, skills: [], failures: [] };
  }
  if (!sk.isDirectory()) {
    return {
      missing: false,
      skills: [],
      failures: [failure('skills-invalid', `skills path ${skillsRoot} is not a directory`)],
    };
  }
  // Realpath containment (§5.5): the plugin root resolves once and is reused
  // for the top-level `skills/` entry and for every skill subdirectory.
  const resolvedRoot = await realpath(pluginRoot).catch(() => null);
  const escape = await skillsEscapeFailure(resolvedRoot, skillsRoot);
  if (escape !== null) {
    return { missing: false, skills: [], failures: [escape] };
  }

  const failureList: Failure[] = [];
  const collected = await collectValidSkills(skillsRoot, resolvedRoot, failureList);
  if (collected.escaped) {
    // Registration stays directory-granular on the client side (§5.6): one
    // escaping subdirectory disables the plugin's whole `skills/` dir, so
    // none of the skills may be registered.
    return { missing: false, skills: [], failures: failureList };
  }

  failureList.push(...(await findNestedSkillFiles(skillsRoot)));

  return {
    missing: false,
    skills: collected.skills,
    failures: failureList,
  };
}

/**
 * Scans the immediate children of `skills/` for valid skill directories.
 *
 * A directory containing a regular `SKILL.md` (immediate child only) is
 * validated; everything else (files, non-directories) is skipped. Invalid
 * skills are recorded in `failures` as `skills-invalid`. A skill subdirectory
 * that resolves (realpath) outside the resolved plugin root is recorded as
 * `path-escape` and sets `escaped`, which disables registration of the whole
 * `skills/` dir (directory-granular, §5.6).
 *
 * @param skillsRoot - Absolute `skills/` directory.
 * @param resolvedRoot - Resolved (realpath) plugin root, or null when it
 * could not be resolved (containment then fails open).
 * @param failures - Array to append per-skill failures to.
 * @returns The valid skills found and whether a subdirectory escaped.
 */
async function collectValidSkills(
  skillsRoot: string,
  resolvedRoot: string | null,
  failures: Failure[],
): Promise<{ skills: SkillInfo[]; escaped: boolean }> {
  const skills: SkillInfo[] = [];
  let escaped = false;
  const entries = await readdir(skillsRoot);
  for (const entry of entries) {
    const dir = join(skillsRoot, entry);
    const st = await stat(dir).catch(() => null);
    if (st === null || !st.isDirectory()) {
      continue;
    }
    const escape = await skillDirEscapeFailure(entry, dir, resolvedRoot);
    if (escape !== null) {
      escaped = true;
      failures.push(escape);
      continue;
    }
    const skillMd = join(dir, 'SKILL.md');
    const file = await stat(skillMd).catch(() => null);
    if (file === null || !file.isFile()) {
      continue;
    }
    const info = await validateSkill(entry, skillMd);
    if (info === null) {
      failures.push(
        failure(
          'skills-invalid',
          `skill "${entry}" is invalid: missing frontmatter or invalid name/description`,
          { skill: entry, section: '§5.6' },
        ),
      );
    } else {
      skills.push(info);
    }
  }
  return { skills, escaped };
}

/**
 * Verifies the `skills/` dir containment (§5.5).
 *
 * The `skills/` path must resolve (realpath) inside the plugin root — a
 * symlinked `skills/` entry pointing outside the tree would otherwise result
 * in an external directory's contents being registered as plugin skills.
 *
 * @param resolvedRoot - Resolved (realpath) plugin root, or null when it
 * could not be resolved (the check then fails open).
 * @param skillsRoot - Absolute `skills/` directory.
 * @returns A `path-escape` failure when the path leaves the root, else null.
 */
async function skillsEscapeFailure(
  resolvedRoot: string | null,
  skillsRoot: string,
): Promise<Failure | null> {
  const resolvedSkills = await realpath(skillsRoot).catch(() => null);
  if (resolvedRoot !== null && resolvedSkills !== null && !isInside(resolvedRoot, resolvedSkills)) {
    return failure('path-escape', `skills path ${skillsRoot} escapes the plugin root`, {
      section: '§5.5',
    });
  }
  return null;
}

/**
 * Verifies a single skill subdirectory containment (§5.5).
 *
 * `stat`/`readFile` follow symlinks, so a `skills/<name>` entry that is a
 * symlink to a directory outside the plugin root must be caught here — the
 * external `SKILL.md` would otherwise be validated and exposed through the
 * registered `skills/` dir.
 *
 * @param name - The subdirectory name as listed in `skills/`.
 * @param dir - Absolute `skills/<name>` path.
 * @param resolvedRoot - Resolved (realpath) plugin root, or null when it
 * could not be resolved (the check then fails open).
 * @returns A `path-escape` failure when the path leaves the root, else null.
 */
async function skillDirEscapeFailure(
  name: string,
  dir: string,
  resolvedRoot: string | null,
): Promise<Failure | null> {
  const resolvedDir = await realpath(dir).catch(() => null);
  if (resolvedRoot !== null && resolvedDir !== null && !isInside(resolvedRoot, resolvedDir)) {
    return failure('path-escape', `skill "${name}" escapes the plugin root`, {
      skill: name,
      section: '§5.5',
    });
  }
  return null;
}

/**
 * Validates a single `SKILL.md` file against the name/description rules.
 *
 * @param name - The directory name (the spec requires it to equal the skill
 * name) and the frontmatter `name` must match it.
 * @param skillMd - Absolute path of the `SKILL.md` file.
 * @returns The validated skill, or null when validation fails.
 */
async function validateSkill(name: string, skillMd: string): Promise<SkillInfo | null> {
  let source: string;
  try {
    source = await readFile(skillMd, 'utf8');
  } catch {
    return null;
  }
  const fm = parseFrontmatter(source);
  if (fm === null) {
    return null;
  }
  if (!isValidSkillName(name)) {
    return null;
  }
  const fmName = fm.name;
  if (typeof fmName !== 'string' || fmName !== name) {
    return null;
  }
  const description = fm.description;
  if (typeof description !== 'string' || description.trim() === '') {
    return null;
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    return null;
  }
  return { name, dir: dirname(skillMd), description, skillMd, content: source };
}

/** @internal Exported for tests only; not part of the public module API. */
export function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(name);
}

/**
 * Whether a `SKILL.md` path relative to `skills/` is a top-level skill file
 * (`<name>/SKILL.md`, exactly two path segments).
 *
 * Splits on both separators, so a Windows-style relative path (`hello\SKILL.md`)
 * is classified the same as a POSIX one — `path.relative` returns platform
 * separators, and the depth check must not depend on the host OS.
 *
 * @param rel - Path relative to the `skills/` directory.
 * @returns True for an immediate child's `SKILL.md`.
 * @internal Exported for tests only; not part of the public module API.
 */
export function isTopLevelSkillMd(rel: string): boolean {
  return rel.split(/[\\/]/).length === 2;
}

/**
 * Finds `SKILL.md` files nested deeper than `skills/<name>/SKILL.md`.
 *
 * The spec defines skills as immediate children only. V2 registration exposes
 * skills individually (id + content), so a nested file is never registered;
 * it is almost always an authoring mistake, so we still warn (naming the
 * file) without implying the host would expose it.
 *
 * @param skillsRoot - Absolute `skills/` directory.
 * @returns Warnings naming each nested `SKILL.md`.
 */
async function findNestedSkillFiles(skillsRoot: string): Promise<Failure[]> {
  const nested: Failure[] = [];
  const pending = [skillsRoot];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        const rel = relative(skillsRoot, full);
        if (!isTopLevelSkillMd(rel)) {
          nested.push(
            failure(
              'skills-nested',
              `nested SKILL.md ${rel}; skills are registered individually, so it is ignored`,
              { file: rel, section: '§5.6' },
            ),
          );
        }
      }
    }
  }
  return nested;
}
