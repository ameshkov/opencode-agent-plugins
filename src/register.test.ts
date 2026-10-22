import { readFile, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logsWithBoundary, runRegistration, stubContext } from '../test/stub-context.js';
import { skillMd, tempDir, tmpPlugin, VALID_PLUGIN_JSON } from '../test/helpers.js';

describe('registerAgentPlugins', () => {
  it('registers a skills dir that ships extra skill resources (registration.md)', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Greets the world.'),
      'skills/hello/references/notes.md': '# Notes\n\nReferenced by the skill.\n',
    });
    try {
      const root = await realpath(plugin.root);
      const stub = stubContext();
      await runRegistration(stub, { plugins: [plugin.root] });

      // The skill is registered with the on-disk SKILL.md path, so resource
      // files beside it stay reachable for the host.
      expect(stub.registeredSkills.get('hello')?.path).toBe(join(root, 'skills/hello/SKILL.md'));
      expect(await readFile(join(root, 'skills/hello/references/notes.md'), 'utf8')).toBe(
        '# Notes\n\nReferenced by the skill.\n',
      );
    } finally {
      await plugin.cleanup();
    }
  });

  it('reports valid absences (missing skills/ and mcp.json) at debug level (failures.md)', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    try {
      const stub = stubContext();
      await runRegistration(stub, { plugins: [plugin.root], logLevel: 'debug' });
      const skillsAbsence = logsWithBoundary(stub, 'skills-missing');
      expect(skillsAbsence).toHaveLength(1);
      expect(skillsAbsence[0]!.level).toBe('debug');
      expect(logsWithBoundary(stub, 'mcp-missing')).toHaveLength(1);
    } finally {
      await plugin.cleanup();
    }
  });

  it('does not forward debug absence reports at the default info threshold', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    try {
      const stub = stubContext();
      await runRegistration(stub, { plugins: [plugin.root] });
      expect(logsWithBoundary(stub, 'skills-missing')).toHaveLength(0);
      expect(logsWithBoundary(stub, 'mcp-missing')).toHaveLength(0);
    } finally {
      await plugin.cleanup();
    }
  });

  it('reports unimplemented extension namespaces at debug level (failures.md)', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': JSON.stringify({
        ...JSON.parse(VALID_PLUGIN_JSON),
        extensions: { 'com.example.foo': { heading: 'x' } },
      }),
      'skills/hello/SKILL.md': skillMd('hello', 'Greets the world.'),
    });
    try {
      const stub = stubContext();
      await runRegistration(stub, { plugins: [plugin.root], logLevel: 'debug' });
      const namespace = logsWithBoundary(stub, 'extension-namespace');
      expect(namespace).toHaveLength(1);
      expect(namespace[0]!.level).toBe('debug');
      expect(namespace[0]!.extra?.['namespace']).toBe('com.example.foo');
    } finally {
      await plugin.cleanup();
    }
  });

  it('denies a skills/ dir that symlinks outside the plugin root (failures.md)', async () => {
    const outside = await tempDir('oap-outside-');
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    try {
      await symlink(outside.root, join(plugin.root, 'skills'));
      const stub = stubContext();
      await runRegistration(stub, { plugins: [plugin.root] });
      expect(stub.registeredSkills.size).toBe(0);
      const escape = logsWithBoundary(stub, 'path-escape');
      expect(escape).toHaveLength(1);
      expect(escape[0]!.level).toBe('warn');
    } finally {
      await plugin.cleanup();
      await outside.cleanup();
    }
  });

  it('skips a plugin with an invalid manifest and continues with others', async () => {
    const bad = await tmpPlugin({
      'plugin.json': JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'bad..name',
      }),
    });
    const good = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
    });
    try {
      const stub = stubContext();
      await runRegistration(stub, { plugins: [bad.root, good.root] });
      expect([...stub.registeredSkills.keys()]).toEqual(['hello']);
      expect(stub.logs.some((entry) => entry.message.includes('invalid plugin.json'))).toBe(true);
    } finally {
      await bad.cleanup();
      await good.cleanup();
    }
  });

  it('warns for git sources that are not installed (no network at startup)', async () => {
    const stub = stubContext();
    await runRegistration(stub, {
      plugins: ['git+https://github.com/org/absent.git#v1.0.0'],
    });
    expect(stub.registeredSkills.size).toBe(0);
    expect(
      stub.logs.some((entry) => entry.message.includes('not installed in the client store')),
    ).toBe(true);
  });

  it('does not throw on a malformed ref and continues with other plugins', async () => {
    const good = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
    });
    try {
      const stub = stubContext();
      await runRegistration(stub, {
        plugins: ['git+https://github.com/org/absent.git#bad ref', good.root],
      });
      expect([...stub.registeredSkills.keys()]).toEqual(['hello']);
      expect(stub.logs.some((entry) => entry.message.includes('invalid git ref'))).toBe(true);
    } finally {
      await good.cleanup();
    }
  });

  it('reports a source configured twice as source-duplicate (failures.md)', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
    });
    try {
      const stub = stubContext();
      await runRegistration(stub, { plugins: [plugin.root, plugin.root] });
      const duplicate = logsWithBoundary(stub, 'source-duplicate');
      expect(duplicate).toHaveLength(1);
      expect(duplicate[0]!.level).toBe('warn');
      expect(duplicate[0]!.message).toContain('already-registered');
    } finally {
      await plugin.cleanup();
    }
  });
});
