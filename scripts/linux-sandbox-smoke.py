#!/usr/bin/env python3
"""Run as a fresh, non-root user under xvfb on the native Ubuntu CI host."""
import os
import pathlib
import re
import signal
import subprocess
import sys
import time

kind, executable, log_name = sys.argv[1:]
assert os.getuid() != 0, "a root launch cannot test unprivileged sandboxing"
assert kind in ("deb", "appimage")
baseline_depth = len(re.search(r"^NSpid:\s+(.+)$", pathlib.Path('/proc/self/status').read_text(), re.M)[1].split())


def sandbox_zygotes():
    evidence = []
    for entry in pathlib.Path('/proc').glob('[0-9]*'):
        try:
            status = (entry / 'status').read_text()
            if int(re.search(r'^Uid:\s+(\d+)', status, re.M)[1]) != os.getuid():
                continue
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            if b'--type=zygote' not in args or b'--no-zygote-sandbox' in args:
                continue
            nspid = re.search(r'^NSpid:\s+(.+)$', status, re.M)[1]
            if len(nspid.split()) > baseline_depth:
                evidence.append(f'pid={entry.name} sandboxed zygote NSpid={nspid}')
        except (OSError, TypeError):
            continue  # a child can exit between directory listing and read
    return evidence


# No shell wrapper, no sandbox-disabling switches, same flags for both formats.
with open(log_name, 'w') as log:
    proc = subprocess.Popen([executable, '--disable-gpu'], stdout=log, stderr=subprocess.STDOUT,
                            start_new_session=True)
    try:
        if kind == 'appimage':
            try:
                result = proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                raise AssertionError('AppImage survived: the negative control cannot see #213')
            contents = pathlib.Path(log_name).read_text()
            assert result != 0, f'AppImage exited successfully: {contents}'
            assert re.search(r'setuid_sandbox_host\.cc|SUID sandbox helper binary', contents), contents
            assert '4755' in contents, contents
            print(f'PASS AppImage negative control: exit={result}; SUID helper / 4755 failure')
        else:
            deadline = time.monotonic() + 30
            evidence = []
            visible = False
            while time.monotonic() < deadline:
                assert proc.poll() is None, f'deb exited early: {pathlib.Path(log_name).read_text()}'
                visible = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name',
                                          'Grok Build|AFK Pilot'], stdout=subprocess.DEVNULL).returncode == 0
                evidence = sandbox_zygotes()
                if visible and evidence:
                    break
                time.sleep(0.5)
            assert visible, 'deb never displayed its application window'
            assert evidence, 'no Chromium zygote in a nested PID namespace; sandbox not demonstrated'
            time.sleep(3)
            assert proc.poll() is None, 'deb crashed after showing its window'
            contents = pathlib.Path(log_name).read_text()
            assert not re.search(r'FATAL:|No usable sandbox|startup failed:|did-fail-load', contents), contents
            print('PASS deb: visible window, live process, no sandbox-disabling flags')
            print('\n'.join(evidence))
    finally:
        # Chromium children share our launched process group; never leave a
        # surviving GUI/zygote behind to make the next control pass by accident.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
