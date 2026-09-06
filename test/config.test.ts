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
    assert.equal(config.indexWatch, true);
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


test('standalone defaults keep resources beside the executable and data outside cwd', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-standalone-config-'));
  try {
    const cwd = path.join(root, 'cwd'), data = path.join(root, 'data'), app = path.join(root, 'app');
    await mkdir(cwd); await mkdir(data);
    await writeFile(path.join(cwd, 'voidplayer.config.json'), '{"wrong":true}');
    const paths = { configFile: path.join(data, 'voidplayer.config.json'), staticDir: path.join(app, 'dist'), logsDir: path.join(data, 'logs') };
    const temporary = await loadConfig(['--folder', 'media'], 'production', cwd, paths);
    assert.equal(temporary.staticDir, paths.staticDir); assert.equal(temporary.logsDir, paths.logsDir);
    assert.deepEqual(temporary.mediaRoots, [path.join(cwd, 'media')]);
    await writeFile(paths.configFile, JSON.stringify({ mediaRoots: ['../media'], logsDir: 'logs' }));
    const persistent = await loadConfig([], 'production', cwd, paths);
    assert.equal(persistent.staticDir, paths.staticDir); assert.equal(persistent.logsDir, paths.logsDir);
    assert.deepEqual(persistent.mediaRoots, [path.join(root, 'media')]);
    await assert.rejects(loadConfig(['--config', 'absent.json'], 'production', cwd, paths), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('stable root definitions preserve IDs and resolve paths independently of data storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-root-config-'));
  try {
    await writeFile(path.join(root, 'voidplayer.config.json'), JSON.stringify({ mediaRoots: [{ id: 'archive-a', path: 'media', name: 'Archive' }], dataDir: 'state' }));
    const config = await loadConfig([], 'production', root);
    assert.deepEqual(config.mediaRoots, [{ id: 'archive-a', path: path.join(root, 'media'), name: 'Archive' }]);
    assert.equal(config.dataDir, path.join(root, 'state'));
    const standalone = await loadConfig([], 'production', root, { dataDir: path.join(root, 'external-state') });
    assert.equal(standalone.dataDir, path.join(root, 'external-state'));
    await writeFile(path.join(root, 'voidplayer.config.json'), JSON.stringify({ mediaRoots: [{ id: '../invalid', path: 'media' }] }));
    await assert.rejects(loadConfig([], 'production', root), /mediaRoots/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('directory watch hints can be disabled without disabling periodic calibration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-watch-config-'));
  try {
    const file = path.join(root, 'voidplayer.config.json');
    await writeFile(file, JSON.stringify({ mediaRoots: ['media'], indexWatch: false, indexTtlMs: 1000 }));
    const config = await loadConfig([], 'production', root);
    assert.equal(config.indexWatch, false); assert.equal(config.indexTtlMs, 1000);
    await writeFile(file, JSON.stringify({ mediaRoots: ['media'], indexWatch: 'false' }));
    await assert.rejects(loadConfig([], 'production', root), /indexWatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('explicit admin environment overrides JSON identities, including revoking all users', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-admin-config-'));
  const original = process.env.VOIDPLAYER_ADMIN_USERS;
  try {
    await writeFile(path.join(root, 'voidplayer.config.json'), JSON.stringify({ mediaRoots: ['media'], adminUsers: ['json-owner'] }));
    process.env.VOIDPLAYER_ADMIN_USERS = 'team.admin, qa.tester';
    assert.deepEqual((await loadConfig([], 'production', root)).adminUsers, ['team.admin', 'qa.tester']);
    process.env.VOIDPLAYER_ADMIN_USERS = '';
    assert.deepEqual((await loadConfig([], 'production', root)).adminUsers, []);
    process.env.VOIDPLAYER_ADMIN_USERS = 'not a user';
    await assert.rejects(loadConfig([], 'production', root), /adminUsers/);
  } finally { if (original === undefined) delete process.env.VOIDPLAYER_ADMIN_USERS; else process.env.VOIDPLAYER_ADMIN_USERS = original; await rm(root, { recursive: true, force: true }); }
});
