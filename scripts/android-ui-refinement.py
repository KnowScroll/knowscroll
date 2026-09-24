"""Real UI verification against a disposable demo library and separate .journeytest application (never the owner's .journey preview, #136).

Run after sourcing scripts/env.sh. No provider calls, owner app changes, or owner history reset.
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
import sys as _sys
from pathlib import Path as _Path
_sys.dont_write_bytecode = True
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from android_preview import PreviewWatch  # noqa: E402  (#136: the owner's .journey preview)

root = Path.cwd()
config = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines()
              if '=' in line and not line.startswith('#'))
source = urlparse(config['DATABASE_URL'])
if source.hostname not in ('127.0.0.1', 'localhost', '::1'):
    raise RuntimeError('UI verification requires loopback PostgreSQL')
name = 'knowscroll_demo_ui_' + secrets.token_hex(8)
package = 'com.knowscroll.mobile.journeytest'
out = root / 'artifacts/android-ui-refinement'
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
_preview_error = None
_guard = PreviewWatch('com.knowscroll.mobile.journey', _Path.cwd() / 'artifacts' / 'preview-guard' / _Path(__file__).stem)
try:
    _guard.preserve()
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
    for label, size, scale, duration in [('regular', 'reset', '1.0', '1.0'),
                                         ('compact-reduced', '840x1680', '1.3', '0')]:
        adb('shell', 'wm', 'size', size)
        adb('shell', 'settings', 'put', 'system', 'font_scale', scale)
        adb('shell', 'settings', 'put', 'global', 'animator_duration_scale', duration)
        adb('shell', 'pm', 'clear', package)
        result = subprocess.check_output(['adb', 'shell', 'am', 'instrument', '-w', '-e', 'class',
            'com.knowscroll.mobile.SystemViewJourneyTest#systemNamesNoSourceAcrossRecreationAndBack',
            package + '.test/androidx.test.runner.AndroidJUnitRunner'], text=True, timeout=120)
        (out / (label + '.txt')).write_text(result)
        print(result, flush=True)
        if 'OK (1 test)' not in result:
            raise RuntimeError(label + ' system view failed')
        for file in ['atlas-ui.png', 'system-ui.png', 'keep-ui.png', 'system-ui-receipt.json']:
            data = subprocess.check_output(['adb', 'exec-out', 'run-as', package, 'cat', 'files/' + file])
            (out / (label + '-' + file)).write_bytes(data)
        scenarios.append({'name': label, 'size': size, 'fontScale': scale, 'animatorDurationScale': duration,
                          'result': 'passed'})
    adb('shell', 'pm', 'clear', package)
    result = subprocess.check_output(['adb', 'shell', 'am', 'instrument', '-w', '-e', 'class',
        'com.knowscroll.mobile.SystemViewJourneyTest#clearedSystemIsNotRestoredOnForeground',
        package + '.test/androidx.test.runner.AndroidJUnitRunner'], text=True, timeout=120)
    (out / 'privacy.txt').write_text(result)
    print(result, flush=True)
    if 'OK (1 test)' not in result:
        raise RuntimeError('System privacy-fence test failed')
    (out / 'system-privacy-receipt.json').write_bytes(subprocess.check_output(
        ['adb', 'exec-out', 'run-as', package, 'cat', 'files/system-privacy-receipt.json']))
    scenarios.append({'name': 'system-privacy-fence', 'result': 'passed'})
    files = list((root / 'apps/mobile/app/src').rglob('*.kt'))
    files += [root / 'apps/mobile/app/src/main/res/values/strings.xml', Path(__file__).resolve(),
              root / 'packages/db/src/privacy.ts',
              root / 'packages/db/migrations/0025_world_system_privacy_erasure.sql']
    receipt = {'result': 'passed', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'database': name, 'package': package, 'scenarios': scenarios,
               'sourceSha256': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
               'limits': ['Marked demo content with real API/database projections.',
                          'No semantic evolution, provider, browser-content, or frame-time proof.']}
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
finally:
    # Restore the owner's preview first (only if this run replaced it), so no later cleanup can hide it.
    try: _guard.restore()
    except Exception as _error: _preview_error = _error; print(f'PREVIEW RESTORE FAILED: {_error}', flush=True)
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
if _preview_error is not None: raise _preview_error
