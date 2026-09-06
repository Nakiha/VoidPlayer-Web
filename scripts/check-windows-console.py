"""Verify Ctrl+C on a real, isolated Windows console for the compiled release."""
import ctypes
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import time
import urllib.request

if os.name != 'nt':
    raise SystemExit('Windows runner required')
release = json.loads(pathlib.Path('artifacts/latest-release.json').read_text())
exe = str(pathlib.Path(release['directory']) / 'voidplayer.exe')
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
with tempfile.TemporaryDirectory(prefix='vp-console-') as folder:
    root = pathlib.Path(folder)
    media = root / 'media'
    media.mkdir()
    (media / 'sample.mp4').write_bytes(b'console-test')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    env = {k: v for k, v in os.environ.items() if k.upper() not in ('PATH', 'VOIDPLAYER_CONFIG', 'VOIDPLAYER_DATA_DIR', 'VOIDPLAYER_PROXY_TOKEN')}
    env['PATH'] = str(root / 'empty-path')
    # CI shells may ignore Ctrl+C; this flag is inherited across CreateProcess.
    # Reset it in this helper before creating the isolated console child.
    if not kernel.SetConsoleCtrlHandler(None, False):
        raise ctypes.WinError(ctypes.get_last_error())
    child = subprocess.Popen([exe, '--folder', str(media), '--data-dir', str(root / 'data'), '--port', str(port), '--no-logs'], cwd=root, env=env, creationflags=subprocess.CREATE_NEW_CONSOLE)
    try:
        ready = False
        for _ in range(100):
            if child.poll() is not None:
                raise AssertionError(f'Process exited before ready: {child.returncode}')
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/ready', timeout=1) as response:
                    ready = response.status == 200
                if ready:
                    break
            except OSError:
                pass
            time.sleep(0.1)
        assert ready, 'Startup timeout'
        # Attach only to the owned child's new console; never signal the runner console.
        kernel.FreeConsole()
        if not kernel.AttachConsole(child.pid):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not kernel.SetConsoleCtrlHandler(None, True):
                raise ctypes.WinError(ctypes.get_last_error())
            if not kernel.GenerateConsoleCtrlEvent(0, 0):
                raise ctypes.WinError(ctypes.get_last_error())
            assert child.wait(timeout=8) == 0, 'Ctrl+C must exit normally, not forced termination'
        finally:
            kernel.FreeConsole()
        print('PASS Windows isolated console: compiled executable handles Ctrl+C and exits with code 0')
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
