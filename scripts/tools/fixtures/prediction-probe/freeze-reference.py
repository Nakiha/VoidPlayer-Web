"""Freeze predictions from independently instrumented JM, HM and VTM. See the fixture notes."""
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

work, output = map(Path, sys.argv[1:])
result = {}
def digest(rows):
    text = ''.join(line + '\n' for line in sorted(','.join(map(str, row)) for row in rows))
    return [len(rows), hashlib.sha256(text.encode('ascii')).hexdigest()]

def freeze(codec, records, order):
    assert len(order) == 17
    products = ['intra'] if codec == 'h264' else ['intra', 'inter']
    result[codec] = [{p: digest(records[poc, p]) for p in products} for poc in order]

for codec, reference in [('h264', 'jm'), ('hevc', 'hm')]:
    rows = defaultdict(list)
    order = {}
    trace = (work / (reference + '.rows')).read_text().splitlines()
    assert all('Assertion failed:' not in line for line in trace)
    for line in trace:
        if not line.startswith('VP '):
            continue
        _, poc, plane, *values = line.split()
        poc = int(poc)
        order.setdefault(poc, len(order))
        x, y, w, h, *v = map(int, values)
        if plane == 'P':
            for i in (4, 8):
                if v[i] >= 0:
                    v[i] = order[v[i]]
            rows[poc, 'inter'].append([x, y, w, h, *v])
        else:
            rows[poc, 'intra'].append([x, y, w, h, 1 if plane == 'Y' else 6, *v])
    freeze(codec, rows, order)

log = (work / 'vtm-dec.log').read_text()
assert 'Total Time:' in log and 'ERROR' not in log
order = [int(p) for p in re.findall(r'^POC\s+(\d+) LId:', log, re.M)]
pattern = re.compile(r'BlockStat: POC (\d+) @\(\s*(\d+),\s*(\d+)\) \[\s*(\d+)x\s*(\d+)\] (\w+)=(\d+)$')
fields = set('Luma_IntraMode Chroma_IntraMode Chroma_SelectedMode MIPFlag ISPMode MultiRefIdx AffineFlag AffineType SkipFlag '
             'MergeFlag MMVDMergeFlag CiipFlag GpmPartitionIndex'.split())
blocks = defaultdict(dict)
original = hashlib.sha256()
with (work / 'vtm.stats').open('rb') as stats:
    for line in stats:
        if b'Chroma_SelectedMode' not in line and b'GpmPartitionIndex' not in line:
            original.update(line)
        m = pattern.match(line.decode('ascii'))
        if m and m[6] in fields:
            key = tuple(map(int, m.group(1, 2, 3, 4, 5)))
            if key[3] and key[4]:
                assert m[6] not in blocks[key]
                blocks[key][m[6]] = int(m[7])
assert original.hexdigest() == 'f8d506d8902d7cf4d5d5053159f2a283bedef413d2d701189404a47d1c45208d'
rows = defaultdict(list)
for (poc, x, y, w, h), v in blocks.items():
    if 'MIPFlag' in v:
        rows[poc, 'intra'].append([x, y, w, h, 1, v['Luma_IntraMode'], v['MIPFlag'], v['ISPMode'], v['MultiRefIdx']])
    if 'Chroma_IntraMode' in v:
        rows[poc, 'intra'].append([x, y, w, h, 6, v['Chroma_IntraMode'], v['Chroma_SelectedMode']])
    if 'AffineFlag' in v:
        skip = v['SkipFlag']
        subtype = v['AffineType'] if v['AffineFlag'] else -1
        rows[poc, 'inter'].append([x, y, w, h, skip, 1 if skip else v['MergeFlag'], v.get('MMVDMergeFlag', 0),
                                  v.get('CiipFlag', 0), v.get('GpmPartitionIndex', -1), subtype])
freeze('vvc', rows, order)
output.write_text(json.dumps(result, indent=2) + '\n')
