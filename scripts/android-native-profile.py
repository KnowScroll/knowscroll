"""Repeatable frame metrics for 12 world-entry/source/Back cycles, disposable demo and .journey only.

Run after sourcing scripts/env.sh. No provider calls, owner app changes, or owner history reset.
The `.journey` app is also the owner's running preview: it is preserved before anything replaces it
and restored (verified) first in `finally` (scripts/android_preview.py). Each run writes to its own
folder, `artifacts/android-spatial/profile/<KS_PROFILE_LABEL or timestamp>/`, with every frame phase
and per-frame rows (#136), and records the exact source with `git describe --dirty`.
"""
from pathlib import Path
from urllib.parse import urlparse, urlunparse
import datetime
import hashlib
import json
import os
import secrets
import signal
import subprocess
import time
import urllib.request
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from android_preview import PreviewGuard  # noqa: E402

root = Path.cwd()
config = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines()
              if '=' in line and not line.startswith('#'))
source = urlparse(config['DATABASE_URL'])
if source.hostname not in ('127.0.0.1', 'localhost', '::1'):
    raise RuntimeError('UI verification requires loopback PostgreSQL')
name = 'knowscroll_demo_ui_' + secrets.token_hex(8)
package = 'com.knowscroll.mobile.journeytest'
out = root / 'artifacts/android-spatial/profile' / (os.environ.get('KS_PROFILE_LABEL') or datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
out.mkdir(parents=True, exist_ok=True)
allowed = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'ANDROID_HOME',
           'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME', 'ANDROID_USER_HOME',
           'GRADLE_USER_HOME', 'JAVA_HOME', 'npm_config_cache', 'COREPACK_HOME', 'TMPDIR')
env = {key: os.environ[key] for key in allowed if key in os.environ}
env.update({key: '' for key in config})
env.update(DATABASE_URL=urlunparse(source._replace(path='/' + name)),
           KS_DEV_TOKEN=secrets.token_hex(32), NODE_ENV='test', PORT='4317',
           KS_JOURNEY_API_URL='http://10.0.2.2:4317', KS_APP_ID_SUFFIX='.journeytest')
processes = []


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def adb(*args):
    return subprocess.check_output(['adb', *args], text=True).strip()


def start(args, label):
    log = (out / (label + '.log')).open('w')
    process = subprocess.Popen(args, env=env, stdout=log, stderr=log, start_new_session=True)
    processes.append((process, log))


font = adb('shell', 'settings', 'get', 'system', 'font_scale')
motion = adb('shell', 'settings', 'get', 'global', 'animator_duration_scale')
sizes = adb('shell', 'wm', 'size').splitlines()
original_override = next((line.split(': ', 1)[1] for line in sizes if line.startswith('Override size:')), None)
scenarios = []
guard = PreviewGuard('com.knowscroll.mobile.journey', out)
try:
    guard.preserve()
    import socket
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', 4317))
    run(['pnpm', 'exec', 'tsx', 'scripts/demo-populate.ts', '--stage', 'light'], env=env)
    start(['pnpm', 'dev:api'], 'api')
    start(['pnpm', 'dev:worker'], 'worker')
    for attempt in range(60):
        try:
            with urllib.request.urlopen('http://127.0.0.1:4317/health', timeout=1):
                break
        except Exception:
            if attempt == 59:
                raise
            time.sleep(.25)
    run(['./gradlew', ':app:assembleDebug', ':app:assembleDebugAndroidTest', ':app:lintDebug',
         ':app:testDebugUnitTest', '--console', 'plain'], cwd=root / 'apps/mobile', env=env)
    for apk in ('app/build/outputs/apk/debug/app-debug.apk',
                'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'):
        run(['adb', 'install', '-r', str(root / 'apps/mobile' / apk)])
    adb('shell', 'wm', 'size', 'reset')
    adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0')
    adb('shell', 'settings', 'put', 'global', 'animator_duration_scale', '1.0')
    adb('shell', 'pm', 'clear', package)
    result=subprocess.check_output(['adb','shell','am','instrument','-w','-e','class',
        'com.knowscroll.mobile.AtlasProfileTest',package+'.test/androidx.test.runner.AndroidJUnitRunner'],text=True,timeout=240)
    (out/'instrumentation.txt').write_text(result)
    print(result,flush=True)
    if 'OK (1 test)' not in result:
        failure=subprocess.run(['adb','exec-out','run-as',package,'cat','files/profile-failure.png'],capture_output=True)
        if failure.returncode==0: (out/'failure.png').write_bytes(failure.stdout)
        raise RuntimeError('Profile scenario failed')
    (out/'atlas-profile.json').write_bytes(subprocess.check_output(['adb','exec-out','run-as',package,'cat','files/atlas-profile.json']))
    (out/'atlas-frames.json').write_bytes(subprocess.check_output(['adb','exec-out','run-as',package,'cat','files/atlas-frames.json']))
    (out/'source.json').write_text(json.dumps({'revision':subprocess.check_output(['git','describe','--always','--dirty','--abbrev=40'],text=True).strip(),
        'mainSourceSha256':hashlib.sha256(b''.join(str(p.relative_to(root)).encode()+b'\0'+p.read_bytes() for p in sorted((root/'apps/mobile/app/src/main').rglob('*')) if p.is_file())).hexdigest()},indent=2))

finally:
    restore_error = None
    try: guard.restore()
    except Exception as error: restore_error = error; print(f'PREVIEW RESTORE FAILED: {error}', flush=True)
    for process, log in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=15)
        log.close()
    adb('shell', 'wm', 'size', original_override or 'reset')
    adb('shell', 'settings', 'put', 'system', 'font_scale', font if font != 'null' else '1.0')
    adb('shell', 'settings', 'put', 'global', 'animator_duration_scale', motion if motion != 'null' else '1.0')
    admin = {**os.environ, 'PGPASSWORD': source.password or ''}
    run(['dropdb', '--if-exists', '-h', source.hostname, '-p', str(source.port or 5432),
         '-U', source.username, name], env=admin)
    if restore_error: raise RuntimeError(f'preview restore failed: {restore_error}')
