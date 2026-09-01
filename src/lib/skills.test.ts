import { describe, expect, it } from 'vitest';
import { discoverSkills, isValidSkillName, SKILL_NAME_RE } from './skills.js';
import { skillMd, tmpPlugin, VALID_PLUGIN_JSON } from '../../test/helpers.js';

describe('isValidSkillName', () => {
  it('accepts dotted-word names', () => {
    expect(isValidSkillName('hello')).toBe(true);
    expect(isValidSkillName('foo-bar-baz')).toBe(true);
  });

  it('rejects invalid names', () => {
    for (const name of ['Hello', 'foo_bar', 'foo..bar', '-foo', 'foo-', '']) {
      expect(isValidSkillName(name)).toBe(false);
    }
  });

  it('enforces the max length', () => {
    expect(isValidSkillName('a'.repeat(64))).toBe(true);
    expect(isValidSkillName('a'.repeat(65))).toBe(false);
  });

  it('matches the documented pattern', () => {
    expect(SKILL_NAME_RE.test('foo-bar')).toBe(true);
  });
});

describe('discoverSkills', () => {
  it('treats a missing skills/ dir as valid absence', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    try {
      const result = await discoverSkills(plugin.root);
      expect(result.missing).toBe(true);
      expect(result.skills).toEqual([]);
      expect(result.root).toBeNull();
    } finally {
      await plugin.cleanup();
    }
  });

  it('discovers immediate-child skills only', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
      'skills/not-a-dir.txt': 'x',
    });
    try {
      const result = await discoverSkills(plugin.root);
      expect(result.skills.map((s) => s.name)).toEqual(['hello']);
      expect(result.root).toContain('/skills');
    } finally {
      await plugin.cleanup();
    }
  });

  it('skips invalid skills with a warning', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/Hello/SKILL.md': skillMd('Hello', 'Bad name'),
      'skills/nodesc/SKILL.md': '---\nname: nodesc\n---\n',
    });
    try {
      const result = await discoverSkills(plugin.root);
      expect(result.skills).toEqual([]);
      expect(result.root).toBeNull();
      expect(result.failures.map((f) => f.kind)).toEqual(['skills-invalid', 'skills-invalid']);
    } finally {
      await plugin.cleanup();
    }
  });

  it('warns about nested SKILL.md files deeper than skills/<name>/', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
      'skills/hello/references/SKILL.md': skillMd('hello', 'Nested'),
    });
    try {
      const result = await discoverSkills(plugin.root);
      expect(result.skills.map((s) => s.name)).toEqual(['hello']);
      expect(result.failures.map((f) => f.kind)).toEqual(['skills-nested']);
      if (result.failures[0]) {
        expect(result.failures[0].message).toContain('references/SKILL.md');
      }
    } finally {
      await plugin.cleanup();
    }
  });

  it('flags a non-directory skills/ entry', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      skills: 'not a dir',
    });
    try {
      const result = await discoverSkills(plugin.root);
      expect(result.failures.map((f) => f.kind)).toEqual(['skills-invalid']);
    } finally {
      await plugin.cleanup();
    }
  });
});
