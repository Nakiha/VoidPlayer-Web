import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseVersion({ packageVersion, revision, dirty, tag = '' }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageVersion)) throw new Error('package.json version 必须是 x.y.z');
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('发布需要完整 Git 修订');
  if (!tag) return `${packageVersion}-preview.${revision.slice(0, 8)}${dirty ? '.dirty' : ''}`;
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);
  if (!match || match[1] !== packageVersion || match[2]?.split('.').some(p => /^\d+$/.test(p) && p.length > 1 && p[0] === '0')) throw new Error('发布标签必须匹配 package.json version，可附加合法预发布后缀');
  if (dirty) throw new Error('标签发布拒绝未提交的改动');
  return tag.slice(1);
}

export async function readReleaseIdentity(root, tag = process.env.VOIDPLAYER_RELEASE_TAG || '') {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const { version: packageVersion } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const revision = git(['rev-parse', 'HEAD']);
  const dirty = !!git(['status', '--porcelain']);
  const version = releaseVersion({ packageVersion, revision, dirty, tag });
  if (tag && git(['rev-parse', `refs/tags/${tag}^{commit}`]) !== revision) throw new Error('发布标签未指向当前构建修订');
  return { version, revision, dirty, tag };
}

export async function readReleaseNotes(root, identity) {
  if (!identity.tag) return '';
  const notes = await readFile(path.join(root, 'docs/releases', `${identity.version}.md`), 'utf8');
  if (!notes.trim()) throw new Error('标签发布需要非空发布说明');
  return notes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const identity = await readReleaseIdentity(root);
  await readReleaseNotes(root, identity);
  console.log(`${identity.version} (${identity.revision})${identity.tag ? ' — tag and release notes verified' : ''}`);
}
