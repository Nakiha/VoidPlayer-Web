import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { digest } from './static-assets.mjs';

const lockPath = 'scripts/release-websr.json';
const weightPath = 'scripts/vendor/websr/cnn-2x-s-rl.json';
export const webSrLicenseFile = 'licenses/websr.txt';
export const webSrProvenanceFile = 'licenses/websr-source.json';
export const webSrBuildInputs = [lockPath, weightPath, 'public/' + webSrLicenseFile, 'scripts/websr-assets.mjs'];
const layers = ['conv2d_tf', 'conv2d_1_tf', 'conv2d_2_tf', 'conv2d_last_tf'];
const wgslNumbers = array => array.map(value => Number(value.toPrecision(9)).toExponential()).join(', ');

function convolution({ weights, bias }, stage) {
  const first = stage === 0;
  assert.ok(weights.length === (first ? 144 : 288) && weights.every(Number.isFinite), 'Invalid WebSR convolution weights');
  assert.ok(bias.length === 4 && bias.every(Number.isFinite), 'Invalid WebSR convolution bias');
  const matrix = index => 'mat4x4f(' + wgslNumbers(weights.slice(index * 16, index * 16 + 16)) + ')';
  const terms = [];
  for (let index = 0; index < 9; index++) {
    const offset = 'vec2i(' + (Math.floor(index / 3) - 1) + ', ' + (index % 3 - 1) + ')';
    const pixel = 'p' + index;
    terms.push('let ' + pixel + ' = sampleInput(p + ' + offset + ');');
    if (first) terms.push('sum += ' + matrix(index) + ' * ' + pixel + ';');
    else {
      terms.push('sum += ' + matrix(index) + ' * max(' + pixel + ', vec4f(0.));');
      terms.push('sum += ' + matrix(index + 9) + ' * max(-' + pixel + ', vec4f(0.));');
    }
  }
  return /* wgsl */ `
@group(0) @binding(0) var input: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba16float, write>;
fn sampleInput(p: vec2i) -> vec4f {
  if (any(p < vec2i(0)) || any(p >= vec2i(textureDimensions(input)))) { return vec4f(0.); }
  return textureLoad(input, p, 0);
}
@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(output))) { return; }
  let p = vec2i(id.xy);
  var sum = vec4f(${wgslNumbers(bias)});
  ${terms.join('\n  ')}
  textureStore(output, p, sum);
}
`;
}

const recompose = /* wgsl */ `
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var packed: texture_2d<f32>;
@group(0) @binding(3) var output: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output);
  if (any(id.xy >= size)) { return; }
  let original = textureSampleLevel(source, linearSampler, (vec2f(id.xy) + vec2f(0.5)) / vec2f(size), 0.).rgb;
  let lane = (id.y % 2u) * 2u + id.x % 2u;
  let residual = textureLoad(packed, vec2i(id.xy / 2u), 0)[lane];
  textureStore(output, id.xy, vec4f(original + residual, 1.));
}
`;

export async function readWebSrAssets(root) {
  const [lock, weights, license] = await Promise.all([
    readFile(path.join(root, lockPath), 'utf8'),
    readFile(path.join(root, weightPath)),
    readFile(path.join(root, 'public', webSrLicenseFile)),
  ]);
  const provenance = JSON.parse(lock);
  assert.equal(digest(weights), provenance.weights.sha256, 'WebSR weight SHA-256 mismatch');
  assert.equal(digest(license), provenance.license.sha256, 'WebSR license SHA-256 mismatch');
  const network = JSON.parse(weights).layers;
  const shaders = [...layers.map((name, stage) => convolution(network[name], stage)), recompose];
  return { lock, shaders };
}
