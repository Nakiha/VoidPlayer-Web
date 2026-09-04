"""Generate small local-only browser QA clips; requires ffmpeg on PATH."""
from pathlib import Path
import subprocess

output = Path(__file__).resolve().parent.parent / 'fixtures'
output.mkdir(exist_ok=True)
for name, rate, filters in (
    ('a.mp4', 30, []),
    ('b.mp4', 24, ['-vf', 'hue=h=25']),
    ('vfr.mp4', 30, ['-vf', "select='if(lt(t,1),1,not(mod(n,2)))'", '-fps_mode', 'vfr']),
):
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', f'testsrc2=size=640x360:rate={rate}',
        '-t', '3', *filters, '-c:v', 'libx264', '-g', str(rate),
        '-bf', '2', '-pix_fmt', 'yuv420p', str(output / name),
    ], check=True)
(output / 'invalid.mp4').write_text('not a video')
print(f'Generated test files in {output}')
