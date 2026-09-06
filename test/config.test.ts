import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.ts';

test('shared configuration resolves file-relative paths and explicit CLI overrides', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-config-'));
  try {
    await mkdir(path.join(root, 'config'));
    await writeFile(path.join(root, 'config/settings.json'), JSON.stringify({ mediaRoots: ['../media'], staticDir: '../web', logsDir: null, port: 5190 }));
    const config = await loadConfig(['--config', 'config/settings.json', '--port', '5191'], 'dev', root);
    assert.deepEqual(config.mediaRoots, [path.join(root, 'media')]);
    assert.equal(config.staticDir, path.join(root, 'web')); assert.equal(config.logsDir, null);
    assert.equal(config.port, 5190); assert.equal(config.devPort, 5191);
    const override = await loadConfig(['--config=config/settings.json', '--folder', 'another', '--port', '5192'], 'production', root);
    assert.deepEqual(override.mediaRoots, [path.join(root, 'another')]); assert.equal(override.port, 5192);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configuration rejects missing values, collisions and unsafe development listeners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-config-'));
  try {
    for (const args of [['--port'], ['--port','NaN'], ['--port','5180'], ['--host','0.0.0.0'], ['--mispelled']]) await assert.rejects(loadConfig(args, 'dev', root));
    await assert.rejects(loadConfig([], 'production', root), /mediaRoots/);
    await assert.rejects(loadConfig(['--config','missing.json'], 'dev', root));
    await writeFile(path.join(root, 'voidplayer.config.json'), '{"unknown":1}');
    await assert.rejects(loadConfig([], 'dev', root), /未知配置项/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
