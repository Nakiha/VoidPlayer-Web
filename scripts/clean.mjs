#!/usr/bin/env node
// 清理可再生成的本地产物（.run 下的历史证据/测试素材/日志，以及 artifacts/ 的历史打包产物）。
//
// 设计原则：默认只报告不删除；任何候选路径必须同时满足
//   1. 解析后仍在本仓库内（拒绝跟随指向仓库外的符号链接）
//   2. git 确认被忽略（`git check-ignore`）——已跟踪的源码永远不会被删
//   3. 不在 PROTECTED 清单里
//   4. 修改时间早于 --keep-days（目录取内部最新时间，避免误判活跃目录）
// 任一条件不满足即拒绝，不做「尽力而为」的删除。
//
// 用法：
//   node scripts/clean.mjs                      # dry-run，列出各分类可回收体积
//   node scripts/clean.mjs --apply              # 实际删除
//   node scripts/clean.mjs --only=media,logs    # 只处理指定分类
//   node scripts/clean.mjs --keep-days=0        # 连最近产物一起清（默认 14 天）
//   node scripts/clean.mjs --verbose --apply    # 逐条打印

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// 分类：每一类给出「相对于仓库根的候选路径」判定与说明。
// 用显式前缀而不是宽泛通配，避免把将来新增的目录一并吃掉。
// ---------------------------------------------------------------------------

const CATEGORIES = {
  packages: {
    description: 'artifacts/ 下的历史打包产物（npm run release 可重新生成）',
    match: relative => relative.startsWith('artifacts/voidplayer-'),
  },
  media: {
    description: '测试用生成片源与原生 oracle 检出（脚本可重新生成）',
    match: relative => [
      '.run/playback-media',
      '.run/native-oracle-source',
      '.run/native-oracle-mac',
    ].includes(relative) || /^\.run\/generated-library-/.test(relative),
  },
  toolchain: {
    description: '下载的工具链（bun / actionlint）',
    match: relative => ['.run/bun-toolchain', '.run/actionlint', '.run/actionlint.tar.gz'].includes(relative),
  },
  reports: {
    description: '测试报告目录与临时测试数据目录',
    match: relative => [
      '.run/playback-reports',
      '.run/analysis-reports',
      '.run/diag',
      '.run/diag-logs',
      '.run/lan-logs',
      '.run/lan-data',
    ].includes(relative) || /^\.run\/[^/]*bench-data$/.test(relative),
  },
  logs: {
    description: '.run 下的运行日志（dev.log、CI 日志、历史回归日志）',
    match: relative => /^\.run\/[^/]+\.log$/.test(relative),
  },
  evidence: {
    description: '.run 顶层的历史验收证据目录（兜底分类）',
    // 兜底：.run 顶层其余条目。年龄与保护清单仍会过滤。
    match: relative => /^\.run\/[^/]+$/.test(relative),
  },
};

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find(argument => argument === `--${name}` || argument.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
};

const apply = argv.includes('--apply');
const verbose = argv.includes('--verbose');

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`清理可再生成的本地产物（默认 dry-run）

  --apply              实际删除；不加则只报告
  --only=a,b           只处理指定分类（${Object.keys(CATEGORIES).join(',')}）
  --keep-days=N        保留最近 N 天内修改过的条目（默认 14）
  --verbose            逐条打印候选与被跳过的项
  --help               显示本帮助

安全约束：候选必须位于仓库内、被 git 忽略、且不在保护清单中；
任何一项不满足都会被跳过（例如未安装 git 时不会删除任何东西）。
`);
  process.exit(0);
}

const keepDaysRaw = flag('keep-days', '14');
const keepDays = Number(keepDaysRaw);
if (!Number.isFinite(keepDays) || keepDays < 0) {
  process.stderr.write(`--keep-days 需要一个非负数字，收到 ${JSON.stringify(keepDaysRaw)}\n`);
  process.exit(2);
}

const onlyRaw = flag('only', null);
const only = onlyRaw === null || onlyRaw === true
  ? null
  : new Set(String(onlyRaw).split(',').map(value => value.trim()).filter(Boolean));

if (only !== null) {
  const unknown = [...only].filter(name => !(name in CATEGORIES));
  if (unknown.length) {
    process.stderr.write(`未知分类：${unknown.join(', ')}（可用：${Object.keys(CATEGORIES).join(',')}）\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 永不删除的路径（相对仓库根）：这些不是「可再生成」的
// ---------------------------------------------------------------------------

const PROTECTED = [
  // 服务端 SQLite：媒体库索引、工作区、标注
  '.run/data',
  // git 历史重写用的备份仓库与快照，无法再生成
  '.run/identity-private',
  // 由脚本从网络取回、被文档引用的输入
  '.run/qa-samples',
  '.run/core-source',
  '.run/oracle-source',
  '.run/emsdk-cache',
  // 手工笔记与草稿
  '.run/gpt_review',
  // 本地诊断日志（gitignored，但属于用户数据）
  'logs',
  // 同步脚本填充的产物与依赖
  'fixtures',
  'public',
  'node_modules',
  'dist',
  // 打包脚本依赖的清单
  'artifacts/latest-release.json',
  // 文档引用的取证报告
  'artifacts/color',
  'artifacts/browsers',
  'artifacts/analysis-round3',
  'artifacts/source-activity',
];

// 自动保护文档引用的实际证据路径。删父目录同样会删掉引用的文件。
// 读取失败时直接停止，不能在保护信息不完整时继续清理。
const documentedPaths = new Set();
const markdownFiles = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of markdownFiles) {
  const source = readFileSync(path.join(repoRoot, file), 'utf8');
  for (const match of source.matchAll(/(?:\.run|artifacts)\/[A-Za-z0-9_./-]+/g)) {
    const relative = match[0].replace(/\/+$/, '');
    if (existsSync(path.join(repoRoot, relative))) documentedPaths.add(relative);
  }
}

const isProtected = relative => {
  const normalized = relative.split(path.sep).join('/');
  if (PROTECTED.includes(normalized)) return true;
  if ([...documentedPaths].some(reference => reference === normalized || reference.startsWith(normalized + '/'))) return true;
  // 文档里以链接形式引用的日期化证据目录
  if (/^artifacts\/local-codecs-/.test(normalized)) return true;
  // .run 顶层的手工笔记
  if (/^\.run\/[^/]+\.md$/.test(normalized)) return true;
  return false;
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const topLevel = directory => {
  const absolute = path.join(repoRoot, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).map(name => `${directory}/${name}`);
};

const isIgnoredByGit = relative => {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', relative], { cwd: repoRoot, stdio: 'ignore' });
    // 被忽略的目录里仍可能有强制加入 Git 的文件，或由 ! 规则保留的文件。
    const retained = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', relative], { cwd: repoRoot });
    if (retained.length) return false;
    return true;
  } catch {
    return false;
  }
};

// realpathSync 会解析符号链接；对已不存在的路径退回最近的已存在父目录判断。
const isInsideRepo = absolute => {
  let probe = absolute;
  while (!existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  const resolved = realpathSync(probe);
  return resolved === repoRoot || resolved.startsWith(repoRoot + path.sep);
};

// 与 du 口径一致：硬链接指向同一 inode 时只计一次。
const diskUsage = (absolute, seen = new Set()) => {
  const stat = lstatSync(absolute);
  if (!stat.isDirectory()) {
    if (stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`;
      if (seen.has(key)) return 0;
      seen.add(key);
    }
    return stat.blocks * 512;
  }
  let total = 0;
  for (const entry of readdirSync(absolute)) total += diskUsage(path.join(absolute, entry), seen);
  return total;
};

// 目录取内部最新修改时间，避免把仍在写入的目录判为陈旧。
const newestMtime = absolute => {
  const stat = lstatSync(absolute);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(absolute)) {
    const childNewest = newestMtime(path.join(absolute, entry));
    if (childNewest > newest) newest = childNewest;
  }
  return newest;
};

const formatBytes = bytes => {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
};

// ---------------------------------------------------------------------------
// 挑选候选
// ---------------------------------------------------------------------------

const selected = Object.entries(CATEGORIES).filter(([name]) => only === null || only.has(name));
const cutoff = Date.now() - keepDays * 86400_000;

const candidates = new Map();
const skipped = [];
const claimed = new Set();

const consider = (relative, categoryName) => {
  if (claimed.has(relative)) return;
  const absolute = path.join(repoRoot, relative);
  if (!existsSync(absolute)) return;

  if (isProtected(relative)) return;
  if (!isInsideRepo(absolute)) { skipped.push([relative, '解析后位于仓库外']); return; }
  if (!isIgnoredByGit(relative)) { skipped.push([relative, '未被 git 忽略或 git 不可用']); return; }
  if (newestMtime(absolute) > cutoff) { skipped.push([relative, `最近 ${keepDays} 天内修改过`]); return; }

  claimed.add(relative);
  candidates.set(relative, { categoryName, size: diskUsage(absolute) });
};

// evidence 是兜底分类，必须最后评估，否则会把其他分类已认领的条目重复计入。
for (const [name, category] of selected) {
  if (name === 'evidence') continue;
  for (const relative of [...topLevel('.run'), ...topLevel('artifacts')]) {
    if (category.match(relative)) consider(relative, name);
  }
}
for (const [name, category] of selected) {
  if (name !== 'evidence') continue;
  for (const relative of topLevel('.run')) if (category.match(relative)) consider(relative, name);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const totals = new Map();
for (const { categoryName, size } of candidates.values()) {
  const entry = totals.get(categoryName) ?? { count: 0, size: 0 };
  entry.count += 1;
  entry.size += size;
  totals.set(categoryName, entry);
}

process.stdout.write(`仓库：${repoRoot}\n`);
process.stdout.write(`保留最近 ${keepDays} 天内修改过的条目；模式：${apply ? '删除' : 'dry-run（加 --apply 才删除）'}\n\n`);

for (const [name, category] of selected) {
  const entry = totals.get(name) ?? { count: 0, size: 0 };
  process.stdout.write(`${name.padEnd(10)} ${String(entry.count).padStart(3)} 项  ${formatBytes(entry.size).padStart(10)}  ${category.description}\n`);
}

const reclaimable = [...candidates.values()].reduce((sum, item) => sum + item.size, 0);
process.stdout.write(`\n合计可回收：${formatBytes(reclaimable)}（${candidates.size} 项）\n`);

if (verbose) {
  process.stdout.write('\n候选路径（按体积降序）：\n');
  for (const [relative, { categoryName, size }] of [...candidates].sort((a, b) => b[1].size - a[1].size)) {
    process.stdout.write(`  ${formatBytes(size).padStart(10)}  [${categoryName}] ${relative}\n`);
  }
  if (skipped.length) {
    process.stdout.write('\n已跳过：\n');
    for (const [relative, reason] of skipped) process.stdout.write(`  ${relative} — ${reason}\n`);
  }
}

if (!apply) {
  process.stdout.write('\n未做任何修改。\n');
  process.exit(0);
}

if (!candidates.size) {
  process.stdout.write('\n没有可删除的条目。\n');
  process.exit(0);
}

// 删除前逐项复核，避免统计与执行之间出现新写入。
let removed = 0;
let freed = 0;
for (const [relative, { size }] of candidates) {
  const absolute = path.join(repoRoot, relative);
  if (!existsSync(absolute) || isProtected(relative) || !isInsideRepo(absolute) || !isIgnoredByGit(relative) || newestMtime(absolute) > cutoff) {
    process.stderr.write(`跳过（复核未通过）：${relative}\n`);
    continue;
  }
  try {
    rmSync(absolute, { recursive: true, force: false });
    removed += 1;
    freed += size;
    if (verbose) process.stdout.write(`  已删除 ${relative}\n`);
  } catch (error) {
    process.stderr.write(`删除失败 ${relative}：${error.message}\n`);
  }
}

process.stdout.write(`\n已删除 ${removed} 项，回收 ${formatBytes(freed)}。\n`);
