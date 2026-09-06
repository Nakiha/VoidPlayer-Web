#!/usr/bin/env python3
"""Create real-codec FLV regression samples from the shared QA clips.
Requires ffmpeg/ffprobe on PATH. No transcoding; private framing matches the
Flutter demuxer. Files and reference timestamps go into ignored fixtures/flv/.
"""
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEST = ROOT / 'fixtures' / 'flv'
DEST.mkdir(parents=True, exist_ok=True)

def u24(n):
    return (n & 0xffffff).to_bytes(3, 'big')

def unhex(dump):
    return bytes.fromhex(''.join(line.split(': ', 1)[1].split('  ', 1)[0].replace(' ', '') for line in dump.splitlines() if ': ' in line))

def tag(data, dts):
    return bytes([9]) + u24(len(data)) + u24(dts) + bytes([dts >> 24]) + bytes(3) + data + (11 + len(data)).to_bytes(4, 'big')

cases = [('h264', 'ci_h264_smoke.mp4', 7, 'avc1'), ('hevc', 'mhw_x265_aq_qg16_4s_1920x1080.mkv', 12, 'hvc1'),
         ('av1', 'av1_10s_1920x1080.webm', 13, 'av01'), ('vvc', 'h266_10s_1920x1080.mp4', 14, 'vvc1')]
for codec, source, codec_id, fourcc in cases:
    with tempfile.TemporaryDirectory(prefix='vp-flv-') as tmp:
        # MP4 provides avcC/hvcC/av1C/vvcC config records for all four codecs.
        mp4 = pathlib.Path(tmp) / 'source.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(ROOT / 'fixtures/video' / source), '-map', '0:v:0', '-c', 'copy', str(mp4)], check=True)
        doc = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_packets', '-show_data', '-of', 'json', str(mp4)]))
        config = unhex(doc['streams'][0]['extradata'])
        source_packets = doc['packets']
        for enhanced in ([False] if codec == 'h264' else [False, True]):
            name = ('enhanced-' if enhanced else { 'h264': 'standard-', 'hevc': 'legacy-', 'av1': 'private-', 'vvc': 'private-' }[codec]) + codec
            out = bytearray(b'FLV\x01\x01\x00\x00\x00\x09\x00\x00\x00\x00')
            out += tag(bytes([0x90]) + fourcc.encode() + config if enhanced else bytes([0x10 | codec_id, 0, 0, 0, 0]) + config, 0)
            reference = []
            for p in source_packets:
                pts = round(float(p['pts_time']) * 1000) + 2000
                dts = round(float(p['dts_time']) * 1000) + 2000
                if codec == 'av1' and not enhanced:
                    dts = pts + 5  # exercise signed negative CTS with valid AV1 OBUs
                key = 'K' in p['flags']
                payload = unhex(p['data'])
                if enhanced:
                    video = bytes([0x80 | (0x10 if key else 0x20) | 1]) + fourcc.encode()
                    if codec != 'av1':
                        video += u24(pts - dts)
                else:
                    video = bytes([(0x10 if key else 0x20) | codec_id, 1]) + u24(pts - dts)
                out += tag(video + payload, dts)
                reference.append(pts * 1000)
            (DEST / (name + '.flv')).write_bytes(out)
            (DEST / (name + '.json')).write_text(json.dumps({'codec': codec, 'times': sorted(reference), 'width': doc['streams'][0]['width'], 'height': doc['streams'][0]['height']}))
            print(f'{name}: {len(reference)} packets, {len(out)} bytes')
