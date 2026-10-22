/**
 * Skills registration for the plugin entry (`docs/explanation/registration.md`).
 *
 * Registers each validated skill through a V2 `ctx.skill.transform` (id,
 * name, description, path, content). An editor-visible collision skips the
 * plugin's whole `skills/` dir (registration is directory-granular, registration.md):
 * our own earlier registration is an error, another opencode plugin's is a
 * warning. Config skills never reach the editor — the host enforces their
 * precedence (testing.md). Lives in `src/` (not `src/lib/`) because it talks to
 * the V2 plugin context; the `src/lib/skills.ts` discovery half stays
 * opencode-free.
 *
 * Collision detection runs inside the transform callback because V2 replays
 * transforms during a batched registry rebuild: the editor is the
 * authoritative view of earlier registrations, and the callback may run
 * after `transform()` resolves. Counters are therefore *attempted*
 * registrations; collisions are reported separately from the callback.
 */

import type { Skill } from '@opencode/plugin';
import type { SkillInfo } from './lib/skills.js';
import { failure, reportFailure } from './lib/errors.js';
import type { Logger } from './utils/index.js';
import type { RegisterState, RegistrationContext } from './register-types.js';

/**
 * Registers the plugin's validated skills, skipping them on name collisions.
 *
 * Skill names must be unique at the location; registration is
 * directory-granular, so an editor-visible collision drops the whole plugin
 * `skills/` dir (registration.md). A collision with our own earlier registration in this
 * setup run is a plugin–plugin collision (error); a collision with another
 * opencode plugin's registration is a warning. Config skills never reach the
 * editor — the host enforces their precedence (testing.md).
 *
 * @param context - The V2 plugin context (skills domain).
 * @param skills - Validated skills from discovery (name, description, path,
 * content).
 * @param pluginName - Plugin name (for reports).
 * @param state - Registration state (skill names registered this run).
 * @param logger - Plugin logger.
 * @returns The number of skills attempted, 0 when the plugin has none.
 */
export async function registerSkills(
  context: RegistrationContext,
  skills: SkillInfo[],
  pluginName: string,
  state: RegisterState,
  logger: Logger,
): Promise<number> {
  await context.skill.transform((editor) => {
    // The editor is keyed by id; other plugins may choose id !== name, so
    // collide on the name space as well.
    const taken = skills.filter(
      (skill) =>
        editor.get(skill.name) !== undefined ||
        editor.list().some((entry) => String(entry.name) === skill.name),
    );
    if (taken.length > 0) {
      // Fire-and-forget: the callback may replay after setup returns and the
      // logger never rejects.
      for (const skill of taken) {
        void reportSkillCollision(skill.name, pluginName, state, logger);
      }
      return;
    }
    for (const skill of skills) {
      editor.add(skillRegistrationOf(skill));
      state.registeredSkillNames.add(skill.name);
    }
  });
  return skills.length;
}

/**
 * Maps a discovered skill to the V2 registration shape.
 *
 * The SDK's `Skill.Info` uses Effect-branded strings (`Skill.ID`,
 * `Skill.Name`, `AbsolutePath`); the values here are already validated
 * against those formats (name regex, containment-checked absolute paths), so
 * the cast only satisfies the brand, not a missing check.
 *
 * @param skill - The validated skill.
 * @returns The skill definition for `ctx.skill.transform`.
 */
function skillRegistrationOf(skill: SkillInfo): Skill.Info {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description,
    path: skill.skillMd,
    content: skill.content,
  } as unknown as Skill.Info;
}

/**
 * Reports a skills name collision: our own earlier registration is a
 * plugin–plugin error; another opencode plugin's registration is a warning.
 *
 * @param name - Colliding skill name.
 * @param pluginName - Plugin reporting the collision.
 * @param state - Registration state (tells our own skills apart).
 * @param logger - Plugin logger.
 */
async function reportSkillCollision(
  name: string,
  pluginName: string,
  state: RegisterState,
  logger: Logger,
): Promise<void> {
  const pluginEntry = state.registeredSkillNames.has(name);
  const f = failure(
    'skills-collision',
    pluginEntry
      ? `skill "${name}" from "${pluginName}" collides with the one from a plugin registered earlier in this run`
      : `skill "${name}" from "${pluginName}" collides with a skill registered by another opencode plugin`,
    { plugin: pluginName, skill: name },
  );
  await reportFailure({ ...f, level: pluginEntry ? 'error' : 'warn' }, logger, {
    plugin: pluginName,
  });
}
