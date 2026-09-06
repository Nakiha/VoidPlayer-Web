// Validate the shared artifact on every native runner, including restored caches.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const directory = path.resolve(process.argv[2] ?? path.join(root, 'public/vendor/voidplayer-core'));
if (process.argv[3] === '--variant') {
  // Isolate Emscripten's pthread workers in a process with a bounded lifetime.
  const stem = process.argv[4];
  try {
    const create = (await import(pathToFileURL(path.join(directory, stem + '.js')).href)).default;
    const core = await create({ wasmBinary: await readFile(path.join(directory, stem + '.wasm')) });
    for (const symbol of ['vp_create', 'vp_destroy', 'vp_open_blob', 'vp_index_build', 'vp_extract', 'vp_pixel_format', 'vp_color_primaries', 'vp_color_transfer', 'vp_color_space', 'vp_color_range', 'vp_packet_open', 'vp_packet_alloc', 'vp_packet_send', 'vp_packet_receive', 'vp_packet_reset']) assert.equal(typeof core['_' + symbol], 'function', symbol);
    const ctx = core.ccall('vp_create', 'number', [], []);
    assert.ok(ctx);
    try {
      core.FS.writeFile('/invalid.bin', new Uint8Array([1, 2, 3, 4]));
      assert.notEqual(core.ccall('vp_open', 'number', ['number', 'string'], [ctx, '/invalid.bin']), 0);
      assert.equal(core.ccall('vp_packet_open', 'number', ['number', 'string', 'number', 'number'], [ctx, 'av1', 0, 0]), 0, 'dav1d must open');
    } finally { core.ccall('vp_destroy', null, ['number'], [ctx]); }
    console.log(`PASS ${stem}: required interfaces, invalid input, AV1 decoder`);
    process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
} else {
  const lock = JSON.parse(await readFile(path.join(root, 'scripts/release-core.json'), 'utf8'));
  const provenance = JSON.parse(await readFile(path.join(directory, 'provenance.json'), 'utf8'));
  assert.equal(provenance.schema, 'voidplayer-core-build');
  assert.deepEqual(provenance.source, lock, 'Decoder source must match the release lock');
  for (const required of ['voidplayer-core.js', 'voidplayer-core.wasm', 'voidplayer-core-mt.js', 'voidplayer-core-mt.wasm', 'LICENSES/COPYING.LGPLv2.1', 'LICENSES/dav1d-COPYING']) assert.match(provenance.files[required] ?? '', /^[a-f0-9]{64}$/);
  for (const [file, hash] of Object.entries(provenance.files)) {
    assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), 'Unsafe core manifest path');
    assert.equal(createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex'), hash, file);
  }
  for (const suffix of ['', '-mt']) execFileSync(process.execPath, [import.meta.filename, directory, '--variant', 'voidplayer-core' + suffix], { stdio: 'inherit', timeout: 30000 });
  console.log('PASS decoder provenance and file hashes');
}
