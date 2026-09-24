"""J003 Android proof with real services and a test-only lost-response proxy.

Run after sourcing scripts/env.sh. Uses only a new disposable database and the
separate .journeytest package. The proxy drops a committed clear response; it never
invents an API response or a database outcome.
"""
from pathlib import Path
from urllib.parse import urlparse, urlunparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import datetime
import hashlib
import http.client
import json
import os
import signal
import socket
import subprocess
import threading
import time
import urllib.request
import uuid
import sys as _sys
from pathlib import Path as _Path
_sys.dont_write_bytecode = True
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from android_preview import PreviewGuard  # noqa: E402  (#136: the owner's .journey preview)

root = Path.cwd()
config = dict(line.split('=', 1) for line in Path('.env').read_text().splitlines()
              if '=' in line and not line.startswith('#'))
source = urlparse(config['DATABASE_URL'])
if source.hostname not in ('127.0.0.1', 'localhost', '::1'):
    raise RuntimeError('Android history verification requires loopback PostgreSQL')
name = 'knowscroll_test_history_' + uuid.uuid4().hex
args = ['-h', source.hostname, '-p', str(source.port or 5432), '-U', source.username]
adminenv = {**os.environ, 'PGPASSWORD': source.password or ''}
allowed = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'ANDROID_HOME',
           'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME', 'ANDROID_USER_HOME',
           'GRADLE_USER_HOME', 'JAVA_HOME', 'npm_config_cache', 'COREPACK_HOME', 'TMPDIR')
env = {key: os.environ[key] for key in allowed if key in os.environ}
env.update({key: '' for key in config})
env.update(DATABASE_URL=urlunparse(source._replace(path='/' + name)),
           KS_DEV_TOKEN=config['KS_DEV_TOKEN'], PORT='4316', NODE_ENV='test',
           KS_JOURNEY_API_URL='http://10.0.2.2:4311', KS_APP_ID_SUFFIX='.journeytest')
out = root / 'artifacts/android-history-journey'
out.mkdir(parents=True, exist_ok=True)
package = 'com.knowscroll.mobile.journeytest'
component = package + '/com.knowscroll.mobile.MainActivity'
processes = []
created = False
proxy = None
control_lock = threading.Lock()
control = {'mode': 'forward', 'attempts': [], 'dropped': None, 'record': False}


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log Authorization headers or client content.

    def forward(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        is_clear = self.command == 'POST' and self.path == '/v1/history/clear'
        with control_lock:
            mode = control['mode']
            if is_clear and control['record']:
                control['attempts'].append(json.loads(body))
        if is_clear and mode == 'hold':
            self.connection.shutdown(socket.SHUT_RDWR)
            self.close_connection = True
            return
        connection = http.client.HTTPConnection('127.0.0.1', 4316, timeout=10)
        try:
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in ('host', 'connection')}
            connection.request(self.command, self.path, body, headers)
            response = connection.getresponse()
            result = response.read()
            if is_clear and mode == 'drop-next' and response.status == 200:
                with control_lock:
                    control['dropped'] = json.loads(result)
                    control['mode'] = 'hold'
                self.connection.shutdown(socket.SHUT_RDWR)
                self.close_connection = True
                return
            self.send_response(response.status)
            self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
            self.send_header('Content-Length', str(len(result)))
            self.end_headers()
            self.wfile.write(result)
        finally:
            connection.close()

    do_GET = forward
    do_POST = forward


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def service(role):
    log = (out / (role + '.log')).open('w')
    child = subprocess.Popen(['pnpm', 'exec', 'tsx', 'apps/' + role + '/src/main.ts'],
                             env=env, stdin=subprocess.DEVNULL, stdout=log,
                             stderr=log, start_new_session=True)
    processes.append((child, log))


def instrument(method):
    result = subprocess.check_output([
        'adb', 'shell', 'am', 'instrument', '-w', '-e', 'class',
        'com.knowscroll.mobile.RealJourneyTest#' + method,
        package + '.test/androidx.test.runner.AndroidJUnitRunner'], text=True, timeout=100)
    (out / (method + '.txt')).write_text(result)
    print(result)
    if 'OK (1 test)' not in result:
        raise RuntimeError('Android history instrumentation failed: ' + method)


def app_file(name):
    value = subprocess.check_output(['adb', 'exec-out', 'run-as', package, 'cat', 'files/' + name])
    (out / name).write_bytes(value)
    return json.loads(value) if name.endswith('.json') else value


def scalar(sql):
    return subprocess.check_output(['psql', *args, '-d', name, '-Atqc', sql],
                                   env=adminenv, text=True).strip()


_preview_error = None
_guard = PreviewGuard('com.knowscroll.mobile.journey', _Path.cwd() / 'artifacts' / 'preview-guard' / _Path(__file__).stem)
try:
    _guard.preserve()
    # Fail before side effects if another lane owns the service port.
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 4316))
    # Reserve the proxy port before creating a database or building an app.
    proxy = ThreadingHTTPServer(('127.0.0.1', 4311), Proxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    run(['createdb', *args, name], env=adminenv)
    created = True
    run(['pnpm', 'db:migrate'], env=env)
    run(['pnpm', 'db:seed'], env=env)
    service('api')
    service('worker')
    for _ in range(60):
        try:
            with urllib.request.urlopen('http://127.0.0.1:4316/health', timeout=1) as response:
                if response.status == 200:
                    break
        except Exception:
            time.sleep(.1)
    else:
        raise RuntimeError('Disposable API failed startup')
    run(['./gradlew', ':app:assembleDebug', ':app:assembleDebugAndroidTest',
         ':app:lintDebug', ':app:testDebugUnitTest', '--console', 'plain'],
        cwd='apps/mobile', env=env)
    for apk in ('app/build/outputs/apk/debug/app-debug.apk',
                'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'):
        run(['adb', 'install', '-r', 'apps/mobile/' + apk])
    run(['adb', 'shell', 'pm', 'clear', package])
    run(['adb', 'shell', 'wm', 'size', '840x1680'])
    instrument('clearHistoryConfirmationCancelIsHarmless')
    instrument('clearHistoryClearsNonemptyHistory')
    with control_lock:
        control['mode'] = 'drop-next'
        control['record'] = True
    instrument('pendingClearProcessDeathPrepare')
    before = app_file('j003-pending-before.json')
    with control_lock:
        if control['dropped'] is None or control['mode'] != 'hold':
            raise RuntimeError('Prepare did not encounter a committed clear with a lost response')
        expected = {key: before[key] for key in ('requestId', 'expectedPrivacyEpoch', 'confirmation')}
        if not control['attempts'] or any(value != expected for value in control['attempts']):
            raise RuntimeError('Pending clear changed its request identity')
    request_id = str(uuid.UUID(before['requestId']))
    if scalar("SELECT count(*) FROM history_clear_receipt WHERE request_id='%s'::uuid" % request_id) != '1':
        raise RuntimeError('Lost response was not backed by exactly one committed receipt')
    run(['adb', 'shell', 'am', 'start', '-W', '-n', component])
    before_pid = subprocess.check_output(['adb', 'shell', 'pidof', package], text=True).strip()
    run(['adb', 'shell', 'am', 'force-stop', package])
    if subprocess.run(['adb', 'shell', 'pidof', package], capture_output=True).stdout.strip():
        raise RuntimeError('Journey app survived force-stop')
    with control_lock:
        control['mode'] = 'forward'
    run(['adb', 'shell', 'am', 'start', '-W', '-n', component])
    after_pid = subprocess.check_output(['adb', 'shell', 'pidof', package], text=True).strip()
    if not before_pid or not after_pid or before_pid == after_pid:
        raise RuntimeError('Pending clear did not cross an OS process boundary')
    instrument('pendingClearProcessDeathRestore')
    after = app_file('j003-pending-after.json')
    if after['requestId'] != before['requestId']:
        raise RuntimeError('Restored clear used a different request ID')
    if scalar("SELECT count(*) FROM history_clear_receipt WHERE request_id='%s'::uuid" % request_id) != '1':
        raise RuntimeError('Retry duplicated a clear receipt')
    with control_lock:
        if any(value != expected for value in control['attempts']):
            raise RuntimeError('Restored app changed the saved clear request body')
        if after['privacyEpoch'] != control['dropped']['privacyEpoch']:
            raise RuntimeError('Restored app cleared history a second time')
        control['record'] = False
    instrument('higherPrivacyEpochPurgesCachedScrollOnForeground')
    instrument('differentUniverseBindingDropsPendingClearAndCache')
    app_file('j003-universe-binding.json')
    app_file('j003-clear-android.json')
    if scalar('SELECT count(*) FROM asset') != '3':
        raise RuntimeError('History clear removed shared editorial assets')
    app_file('j003-confirmation.png')
    app_file('j003-cleared.png')
    paths = subprocess.check_output(['git', 'ls-files', 'apps/mobile'], text=True).splitlines()
    paths += ['scripts/android-history-journey.py', 'packages/db/src/privacy.ts', 'apps/api/src/app.ts']
    receipt = {
        'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'git': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'journey': 'J003', 'surface': 'Android + real API/worker/PostgreSQL', 'result': 'passed',
        'transportFailure': 'real committed clear response dropped by test proxy',
        'processDeath': {'beforePid': before_pid, 'afterPid': after_pid,
                         'sameRequestId': True, 'committedReceipts': 1},
        'sourceHashes': {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in paths},
        'checks': ['confirmation cancel', 'nonempty clear', 'lost response',
                   'pending clear process restoration', 'higher epoch cache purge', 'universe binding', 'shared assets retained'],
    }
    (out / 'environment.json').write_text(json.dumps(receipt, indent=2) + '\n')
finally:
    # Restore the owner's preview first (only if this run replaced it), so no later cleanup can hide it.
    try: _guard.restore()
    except Exception as _error: _preview_error = _error; print(f'PREVIEW RESTORE FAILED: {_error}', flush=True)
    subprocess.run(['adb', 'shell', 'wm', 'size', 'reset'], check=False)
    if proxy:
        proxy.shutdown()
        proxy.server_close()
    for child, log in processes:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
        log.close()
    if created:
        run(['dropdb', *args, '--if-exists', name], env=adminenv)
if _preview_error is not None: raise _preview_error
