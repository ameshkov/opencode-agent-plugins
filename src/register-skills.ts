/**
 * Skills registration for the plugin entry (`docs/design.md` §5.6).
 *
 * Pushes a plugin's `skills/` dir into `config.skills.paths` following the
 * user-config-wins collision rule: a colliding skill name skips the plugin's
 * whole `skills/` dir (registration is directory-granular), mirroring §5.7's
 * MCP collision semantics. Lives in `src/` (not `src/lib/`) because it
 * mutates the opencode `Config` shape; the `src/lib/skills.ts` discovery
 * half stays opencode-free.
 */

import { collectSkillNames } from './lib/skills.js';
import { failure, reportFailure } from './lib/errors.js';
import type { Logger } from './utils/index.js';
import type { RegisterState, RuntimeConfig } from './register-types.js';

/**
 * Registers the plugin's `skills/` dir, skipping it on name collisions.
 *
 * Skill names must be unique across every `config.skills.paths` entry;
 * registration is directory-granular, so a collision drops the whole plugin
 * `skills/` dir (user-config-wins, §3.2). A collision with a path we
 * registered earlier in this same hook run is a plugin–plugin collision
 * (error, the later one is skipped); anything else is user config (warn,
 * ours is skipped).
 *
 * @param config - opencode's live resolved config, mutated in place.
 * @param skillsRoot - The plugin's absolute `skills/` directory.
 * @param names - Skill names the plugin exposes (from discovery).
 * @param pluginName - Plugin name (for reports).
 * @param state - Registration state (registered skills paths this run).
 * @param logger - Plugin logger.
 * @returns The number of skills registered, 0 when skipped on collision.
 */
export async function registerSkills(
  config: RuntimeConfig,
  skillsRoot: string,
  names: string[],
  pluginName: string,
  state: RegisterState,
  logger: Logger,
): Promise<number> {
  let collided = false;
  for (const path of config.skills!.paths) {
    if (path === skillsRoot) {
      continue;
    }
    const found = await collectSkillNames(path);
    for (const name of found) {
      if (names.includes(name)) {
        collided = true;
        await reportSkillCollision(name, pluginName, path, state, logger);
      }
    }
  }
  if (collided) {
    return 0;
  }
  config.skills!.paths.push(skillsRoot);
  state.registeredSkillsPaths.add(skillsRoot);
  return names.length;
}

/** Reports a skills name collision: user config wins (warn) or plugin-plugin (error). */
async function reportSkillCollision(
  name: string,
  pluginName: string,
  path: string,
  state: RegisterState,
  logger: Logger,
): Promise<void> {
  const pluginEntry = state.registeredSkillsPaths.has(path);
  const f = failure(
    'skills-collision',
    pluginEntry
      ? `skill "${name}" from "${pluginName}" collides with the one from a plugin registered earlier in this run`
      : `skill "${name}" from "${pluginName}" collides with the one at "${path}"; user config wins`,
    { plugin: pluginName, skill: name },
  );
  await reportFailure({ ...f, level: pluginEntry ? 'error' : 'warn' }, logger, {
    plugin: pluginName,
  });
}
