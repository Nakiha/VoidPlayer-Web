import { validateQualityCore } from '../shared/analysis/quality/analysis-core.ts';
import {verifyCoreCapabilities} from './core-capabilities.mjs';
import { pathToFileURL } from 'node:url';
import { validateAnalysisCore } from '../shared/analysis/bitstream/core-abi.ts';
import { readFile, mkdir, cp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dirname, ".."),
  source = path.resolve(process.argv[2]),
  target = path.resolve(
    process.argv[3] ?? path.join(root, "public/vendor/voidplayer-analysis"),
  );
const lock = JSON.parse(
    await readFile(path.join(root, "scripts/release-analysis.json"), "utf8"),
  ),
  manifest = JSON.parse(
    await readFile(path.join(source, "manifest.json"), "utf8"),
  );
for (const key of [
  "repository",
  "revision",
  "ffmpegRepository",
  "ffmpegRevision",
  "abi",
  "semanticVersion",
  "referenceAbi", "demuxAbi", "qualityAbi",
])
  assert.equal(manifest[key], lock[key], `Analysis provenance ${key}`);
assert.ok(
  manifest.emscripten.includes(` ${lock.emscripten} `),
  "Analysis toolchain version",
);
assert.ok(!manifest.dirty || process.env.ANALYSIS_ALLOW_LOCAL_BUILD === '1', 'Unpublished analysis core: use ANALYSIS_ALLOW_LOCAL_BUILD=1 for local preview only');
const create = (await import(pathToFileURL(path.join(source, 'voidplayer-analysis.js')).href)).default;
const core=await create({wasmBinary:await readFile(path.join(source,'voidplayer-analysis.wasm'))});
validateAnalysisCore(core);
validateQualityCore(core);
assert.equal(manifest.quality.revision,lock.vmafRevision);
assert.equal(manifest.quality.avfilter,false);
await verifyCoreCapabilities(source,lock,'analysis','',core);
assert.equal(typeof core._vpa_feed_known,'function','Known timestamp feed ABI');
await mkdir(target, { recursive: true });
const hashes = {};
for (const file of [
  "voidplayer-analysis.js",
  "voidplayer-analysis.wasm",
  "LICENSE", "LICENSE.libvmaf", "LICENSE.libsvm",
  "manifest.json",
  "capabilities.json",
]) {
  const bytes = await readFile(path.join(source, file));
  hashes[file] = createHash("sha256").update(bytes).digest("hex");
  if (source !== target)
    await cp(path.join(source, file), path.join(target, file));
}
await writeFile(
  path.join(target, "provenance.json"),
  JSON.stringify(
    {
      schema: "voidplayer-analysis-build",
      version: 1,
      source: lock,
      buildId: manifest.buildId ?? manifest.revision,
      dirty: manifest.dirty ?? false,
      referenceAbi: manifest.referenceAbi ?? null,
      files: hashes,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Prepared analysis core ${lock.revision}: ${target}`);
