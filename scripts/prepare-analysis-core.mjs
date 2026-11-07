import {analysisFiles} from './core-artifacts.mjs';
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
  "referenceAbi", "demuxAbi", "qualityAbi", 'qualityInputAbi', 'xpsnrInputAbi',
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
await verifyCoreCapabilities(source,lock,'analysis','',core);
assert.equal(typeof core._vpa_feed_known,'function','Known timestamp feed ABI');
const threaded = JSON.parse(await readFile(path.join(source, 'threading.json'), 'utf8'));
const threadedWasm = await readFile(path.join(source, 'voidplayer-analysis-mt.wasm'));
const threadedDigest = createHash('sha256').update(threadedWasm).digest('hex');
assert.equal(threaded.revision, lock.revision);
assert.equal(threaded.ffmpegRevision, lock.threadedFfmpegRevision);
assert.equal(threaded.buildId, lock.revision + ':mt-' + threadedDigest.slice(0, 16));
assert.equal(threaded.abi, lock.threadingAbi);
assert.equal(threaded.heapMaxBytes, lock.threadedHeapMaxBytes);
assert.equal(threaded.maxThreads, lock.maxThreads);
const createThreaded = (await import(pathToFileURL(path.join(source, 'voidplayer-analysis-mt.js')).href)).default;
const threadCore = await createThreaded({ wasmBinary: threadedWasm, analysisThreads: 2 });
try {
  validateAnalysisCore(threadCore);
  assert.equal(threadCore._vpa_configure_threads(1, 1), 0);
  assert.equal(threadCore._vpa_configure_threads(2, 2), 0);
  assert.ok(threadCore._vpa_configure_threads(1, 2) < 0);
  assert.ok(threadCore._vpa_configure_threads(lock.maxThreads + 1, 1) < 0);
} finally { threadCore.PThread.terminateAllThreads(); }
await mkdir(target, { recursive: true });
const hashes = {};
for (const file of analysisFiles) {
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
