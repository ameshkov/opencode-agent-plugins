import { describe, expect, it } from 'vitest';
import { logsWithBoundary, runRegistration, skillInfo, stubContext } from '../test/stub-context.js';
import { skillMd, tmpPlugin, VALID_PLUGIN_JSON } from '../test/helpers.js';

describe('skills registration collisions', () => {
  it("skips the plugin skills dir on a collision with another plugin's registration", async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Plugin skill.'),
      'skills/world/SKILL.md': skillMd('world', 'Plugin world.'),
    });
    try {
      // The baseline models another opencode plugin's registration: config
      // skills are invisible to transforms (testing.md), so they cannot be seeded.
      const stub = stubContext({ skills: [skillInfo('hello')] });
      await runRegistration(stub, { plugins: [plugin.root] });

      // The colliding plugin skills dir is NOT registered (registration.md), even though
      // it also holds a non-colliding skill (registration is directory-granular).
      expect(stub.registeredSkills.size).toBe(0);
      const collision = logsWithBoundary(stub, 'skills-collision');
      expect(collision).toHaveLength(1);
      expect(collision[0]!.message).toContain('registered by another opencode plugin');
      expect(collision[0]!.level).toBe('warn');
    } finally {
      await plugin.cleanup();
    }
  });

  it('skips the plugin skills dir when another plugin registers id !== name', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Plugin skill.'),
    });
    try {
      // The editor is keyed by id; a foreign registration can carry an id
      // that differs from its name, so the check must match names too.
      const stub = stubContext({
        skills: [skillInfo('hello', '/skills/hello/SKILL.md', 'other-plugin-id')],
      });
      await runRegistration(stub, { plugins: [plugin.root] });

      expect(stub.registeredSkills.size).toBe(0);
      const collision = logsWithBoundary(stub, 'skills-collision');
      expect(collision).toHaveLength(1);
      expect(collision[0]!.message).toContain('registered by another opencode plugin');
      expect(collision[0]!.level).toBe('warn');
    } finally {
      await plugin.cleanup();
    }
  });

  it('skips the later plugin skills dir on a plugin-plugin collision', async () => {
    const first = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'First.'),
    });
    const second = await tmpPlugin({
      'plugin.json': JSON.stringify({ ...JSON.parse(VALID_PLUGIN_JSON), name: 'second' }),
      'skills/hello/SKILL.md': skillMd('hello', 'Second.'),
    });
    try {
      const stub = stubContext();
      await runRegistration(stub, { plugins: [first.root, second.root] });

      expect([...stub.registeredSkills.keys()]).toEqual(['hello']);
      expect(stub.registeredSkills.get('hello')?.content).toContain('First.');
      const collision = logsWithBoundary(stub, 'skills-collision');
      expect(collision).toHaveLength(1);
      expect(collision[0]!.message).toContain('registered earlier in this run');
      expect(collision[0]!.level).toBe('error');
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});
