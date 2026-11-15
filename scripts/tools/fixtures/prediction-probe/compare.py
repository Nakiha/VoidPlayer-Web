"""Compare the two instrumented runs, released block bytes, and an independently decoded VTM trace."""
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

work, trace = map(Path, sys.argv[1:])
oracle = Path(__file__).resolve().parents[4] / 'docs/fixtures/bitstream-analysis-vtm.json'
stats = defaultdict(dict)
trace_line = re.compile(rb'BlockStat: POC (\d+) @\(\s*(\d+),\s*(\d+)\) \[\s*(\d+)x\s*(\d+)\] (\w+)=(.*)')
fields = {b'Luma_IntraMode', b'Chroma_IntraMode', b'Chroma_SelectedMode', b'MIPFlag', b'ISPMode',
          b'GeoPartitioning', b'MMVDMergeFlag', b'CiipFlag', b'AffineFlag', b'AffineType'}
original_hash = hashlib.sha256()
with trace.open('rb') as source:
    for line in source:
        if b'Chroma_SelectedMode' not in line:
            original_hash.update(line)
        match = trace_line.match(line)
        if match and match[6] in fields:
            key = tuple(map(int, match.group(1, 2, 3, 4, 5)))
            if key[3] and key[4]:
                values = stats[match[6].decode()]
                assert key not in values, (match[6], key)
                values[key] = True if match[6] == b'GeoPartitioning' else int(match[7])
assert original_hash.hexdigest() == json.loads(oracle.read_text())['oracle']['traceSha256']

def load(codec, run):
    with (work / f'{codec}-{run}.jsonl').open() as file:
        pictures = list(map(json.loads, file))
    by_au = {p['au']: p for p in pictures}
    assert len(pictures) == 17 and set(by_au) == set(range(17))
    return by_au

def keyed(pictures):
    rows = {}
    for p in pictures.values():
        for r in p['rows']:
            key = (r[0], p['poc'], *r[1:5])
            assert key not in rows, key
            rows[key] = r[5:]
    return rows

def vvc_checks(rows, path):
    predictions = defaultdict(dict)
    counts = Counter()
    for (kind, *coords), v in rows.items():
        k = tuple(coords)
        if kind == 1:
            predictions['Luma_IntraMode'][k] = v[1]
            predictions['MIPFlag'][k] = v[2]
            predictions['ISPMode'][k] = v[3]
        elif kind == 2:
            tree, final, selector, cclm, act, bdpcm, direct_mip, hs, vs = v[:9]
            # This normalization applies to the pinned 4:2:0 sample and the exercised syntax branches.
            assert (hs, vs, act, bdpcm, direct_mip) == (1, 1, 0, 0, 0)
            assert (selector in range(5) and cclm == -1) or (selector == -1 and cclm in range(3))
            mode = 67 + cclm if cclm >= 0 else final
            if cclm >= 0:
                assert final == 81 + cclm
            predictions['Chroma_IntraMode'][k] = mode
            predictions['Chroma_SelectedMode'][k] = 70 if selector == 4 else mode
            counts['DM'] += selector == 4
            counts['MDLM_T'] += cclm == 2
            counts['dual-tree chroma'] += tree == 2
        else:
            assert kind == 6
            skip, merge, mmvd, ciip, intra, gpm, subblock, model, ibc, dmvr, bdof = v
            assert not ibc
            if merge:
                predictions['MMVDMergeFlag'][k] = mmvd
                predictions['CiipFlag'][k] = ciip
            if ciip:
                predictions['Luma_IntraMode'][k] = intra
            if gpm >= 0:
                predictions['GeoPartitioning'][k] = True
            # VTM groups SbTMVP under affine with a separate type. Type is meaningful only when flagged.
            subtype = (2 if subblock and not model else model - 1) if subblock or model else -1
            reference = stats['AffineType'][k] if stats['AffineFlag'][k] else -1
            counts['affine/SbTMVP discrepancies'] += subtype != reference
            for field, value in [('MMVD', mmvd), ('CIIP', ciip), ('GPM', gpm >= 0), ('DMVR flag', dmvr), ('BDOF flag', bdof)]:
                counts[field] += value
    assert {k[1:] for k in rows if k[0] == 6} == stats['AffineFlag'].keys() == stats['AffineType'].keys()
    for field, observed in predictions.items():
        assert observed == stats[field], field
    assert set(predictions) == {f for f in stats if f not in ('AffineFlag', 'AffineType')}
    if path == 0:
        assert counts['affine/SbTMVP discrepancies'] == 0
    print('VVC path', path, dict(counts))

for codec in ('avc', 'hevc', 'vvc'):
    full, auto, release = (load(codec, mode) for mode in ('0', '1', 'release'))
    for au, picture in auto.items():
        assert not picture['invalid']
        assert picture['path'] == release[au]['path'] == int(codec != 'avc') and full[au]['path'] == 0
        for field in ('hash', 'blocks', 'poc', 'invalid'):
            assert full[au][field] == picture[field] == release[au][field], (codec, au, field)
    baseline, fast = keyed(full), keyed(auto)
    assert baseline.keys() == fast.keys()
    print(codec, 'records by family', dict(Counter(k[0] for k in fast)),
          'peak rows in a picture', max(len(p['rows']) for p in auto.values()))
    if codec == 'avc':
        assert baseline == fast
        for p in auto.values():
            y = [r for r in p['rows'] if r[0] == 4]
            chroma = [r for r in p['rows'] if r[0] == 5]
            assert sum(r[3] * r[4] for r in y) == 256 * len(chroma)
            assert all(r[5] in range(4) for r in chroma)
        print('AVC Y sizes', dict(Counter(k[4] for k in fast if k[0] == 4)))
    elif codec == 'hevc':
        assert baseline == fast
        directions = Counter()
        for au, p in auto.items():
            assert sum(r[3] * r[4] for r in p['rows'] if r[0] == 7) == sum(r[3] * r[4] for r in p['rows'] if r[0] == 8)
            for r in p['rows']:
                if r[0] in (7, 8):
                    assert r[5] in range(35)
                    if r[0] == 8:
                        assert r[6] in range(5)
                    continue
                assert r[0] == 3
                directions[r[7]] += 1
                for bit, index, ref in [(1, r[8], r[9]), (2, r[12], r[13])]:
                    if r[7] & bit:
                        assert index >= 0 and 0 <= ref < au
                    else:
                        assert index == ref == -1
        print('HEVC L0/L1/bi counts', dict(directions))
    else:
        vvc_checks(baseline, 0)
        vvc_checks(fast, 1)
        differences = Counter(i for k in fast for i, value in enumerate(fast[k]) if baseline[k][i] != value)
        assert all(k[0] == 6 for k in fast if baseline[k] != fast[k])
        assert set(differences) <= {7, 9, 10}, differences
        print('VVC changed CUs', sum(baseline[k] != fast[k] for k in fast),
              'changed fields (motion model / DMVR / BDOF)', dict(differences))
