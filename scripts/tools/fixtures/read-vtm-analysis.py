#!/usr/bin/env python3
"""Freeze an independent VTM block-statistics oracle; never imports our analyzer.
Usage: read-vtm-analysis.py VTM_SOURCE STATS DECODE_LOG MP4 ANNEX_B OUTPUT
The decoder must finish successfully; trace all POCs to preserve VTM's geo contexts.
"""
import collections
import hashlib
import json
import pathlib
import re
import subprocess
import sys

source, stats, log, media, bitstream, output = map(pathlib.Path, sys.argv[1:])
pocs = {0, 1, 16}
records = collections.defaultdict(dict)
pattern = re.compile(r'BlockStat: POC (\d+) @\(\s*(\d+),\s*(\d+)\) \[\s*(\d+)x\s*(\d+)\] (PredMode|QP|SkipFlag)=(\d+)')
for line in stats.open():
    match = pattern.match(line)
    if match and int(match[1]) in pocs:
        poc, x, y, width, height = map(int, match.group(1, 2, 3, 4, 5))
        # Local dual-tree chroma-only CUs can be traced with an empty Y area.
        if not width or not height:
            continue
        block = records[poc].setdefault((x, y, width, height), {})
        assert match[6] not in block, 'Duplicate luma CU statistic'
        block[match[6]] = int(match[7])
text = log.read_text()
assert 'ERROR' not in text and 'Total Time:' in text, 'VTM must complete successfully'
frames = list(re.finditer(r'^POC\s+(\d+).*?([IPB])-SLICE.*?\[L0([^\]]*)\] \[L1([^\]]*)\]', text, re.M))
au_for_poc = {int(frame[1]): au for au, frame in enumerate(frames)}
assert len(au_for_poc) == len(frames), 'Repeated POC needs an explicit sequence identity'
def digest(file):
    with file.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()
answers = []
for frame in frames:
    poc = int(frame[1])
    if poc not in pocs:
        continue
    blocks = []
    for geometry, values in sorted(records[poc].items()):
        assert values['PredMode'] in (0, 1), 'Unsupported oracle prediction mode'
        mode = 'skip' if values.get('SkipFlag', 0) else 'intra' if values['PredMode'] == 1 else 'inter'
        assert frame[2] == 'I' or 'SkipFlag' in values, 'Missing inter skip statistic'
        blocks.append([*geometry, values['QP'], mode])
    assert blocks and sum(b[2] * b[3] for b in blocks) == 1920 * 1080
    canonical = json.dumps(blocks, separators=(',', ':')).encode()
    selected = blocks[:3] + blocks[-3:]
    for mode in ('intra', 'inter', 'skip'):
        candidate = next((b for b in blocks if b[-1] == mode), None)
        if candidate and candidate not in selected:
            selected.append(candidate)
    references = []
    for index, value in enumerate(frame.group(3, 4)):
        for ref in value.split():
            references.append({'au': au_for_poc[int(ref.rstrip('c'))], 'list': index})
    answers.append({'au': au_for_poc[poc], 'poc': poc, 'frameType': frame[2],
        'width': 1920, 'height': 1080, 'blockCount': len(blocks),
        'blocksSha256': hashlib.sha256(canonical).hexdigest(), 'selected': selected,
        'modeCounts': dict(collections.Counter(b[-1] for b in blocks)),
        'references': sorted(references, key=lambda r: (r['list'], r['au']))})
assert len(answers) == len(pocs)
result = {'schema': 1, 'codec': 'vvc', 'file': media.name, 'sha256': digest(media),
    'oracle': {'repository': 'https://vcgit.hhi.fraunhofer.de/jvet/VVCSoftware_VTM.git',
        'revision': subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
        'buildFlags': '-DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-DENABLE_TRACING=1',
        'traceRule': 'D_BLOCK_STATISTICS_ALL:poc>=0', 'inputPacketCount': len(frames),
        'annexBSha256': digest(bitstream), 'traceSha256': digest(stats)},
    'canonicalBlocks': '[x,y,width,height,lumaQP,mode] sorted numerically by x,y,width,height; compact JSON UTF-8',
    'pictures': answers}
output.write_text(json.dumps(result, indent=2) + '\n')
