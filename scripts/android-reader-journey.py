"""Issue74: real reader, HTTP/worker/PostgreSQL and explicit transport-loss fixture.

Only disposable data and the separate .journeytest Android package are mutated.
The loopback proxy drops two feed sockets (one ApiClient operation including its
retry); it never fabricates a successful response, source, or projection.
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
from android_preview import PreviewWatch  # noqa: E402  (#136: the owner's .journey preview)

root = Path.cwd()
config = dict(line.split('=', 1) for line in Path('.env').read_text().splitlines()
              if '=' in line and not line.startswith('#'))
source = urlparse(config['DATABASE_URL'])
if source.hostname not in ('127.0.0.1', 'localhost', '::1'):
    raise RuntimeError('Reader verification requires loopback PostgreSQL')
name = 'knowscroll_test_reader_' + uuid.uuid4().hex
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
out = root / 'artifacts/android-reader-journey'
out.mkdir(parents=True, exist_ok=True)
package = 'com.knowscroll.mobile.journeytest'
processes = []
created = False
proxy = None
control_lock = threading.Lock()
control = {'remainingDrops': 0, 'feedSocketsDropped': 0, 'feedsForwarded': 0, 'exposuresForwarded': 0, 'sessionsRevoked': 0, 'unauthorizedFeeds': 0}


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def forward(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path == '/__journey/feed-mode' and self.command == 'POST':
            if json.loads(body) != {'mode': 'drop_next'}:
                self.send_error(400)
                return
            with control_lock:
                control['remainingDrops'] = 2
            self.send_response(204)
            self.end_headers()
            return
        if self.path == '/__journey/revoke-sessions' and self.command == 'POST':
            if json.loads(body) != {} or not name.startswith('knowscroll_test_reader_'):
                self.send_error(400)
                return
            revoked = int(scalar("WITH locked AS MATERIALIZED (SELECT id FROM universe ORDER BY id FOR UPDATE), revoked AS (UPDATE device_session SET revoked_at=clock_timestamp() WHERE universe_id IN (SELECT id FROM locked) AND revoked_at IS NULL RETURNING id) SELECT count(*) FROM revoked"))
            with control_lock:
                control['sessionsRevoked'] += revoked
            self.send_response(204 if revoked > 0 else 409)
            self.end_headers()
            return
        is_feed = self.command == 'GET' and self.path.split('?', 1)[0] == '/v1/feed'
        with control_lock:
            drop = is_feed and control['remainingDrops'] > 0
            delay = control['remainingDrops'] == 2
            if drop:
                control['remainingDrops'] -= 1
                control['feedSocketsDropped'] += 1
            elif is_feed:
                control['feedsForwarded'] += 1
            if self.command == 'POST' and self.path == '/v1/exposures':
                control['exposuresForwarded'] += 1
        if drop:
            if delay:
                time.sleep(1)
            self.connection.shutdown(socket.SHUT_RDWR)
            self.close_connection = True
            return
        connection = http.client.HTTPConnection('127.0.0.1', 4316, timeout=15)
        try:
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in ('host', 'connection')}
            connection.request(self.command, self.path, body, headers)
            response = connection.getresponse()
            result = response.read()
            if is_feed and response.status == 401:
                with control_lock:
                    control['unauthorizedFeeds'] += 1
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


def instrument(class_name, method):
    result = subprocess.check_output([
        'adb', 'shell', 'am', 'instrument', '-w', '-e', 'class',
        'com.knowscroll.mobile.' + class_name + '#' + method,
        package + '.test/androidx.test.runner.AndroidJUnitRunner'], text=True, timeout=120)
    (out / (method + '.txt')).write_text(result)
    print(result, flush=True)
    if 'OK (1 test)' not in result:
        raise RuntimeError('Reader instrumentation failed: ' + method)


def app_file(filename):
    value = subprocess.check_output(['adb', 'exec-out', 'run-as', package, 'cat', 'files/' + filename])
    (out / filename).write_bytes(value)
    return json.loads(value) if filename.endswith('.json') else value


def scalar(sql):
    return subprocess.check_output(['psql', *args, '-d', name, '-Atqc', sql], env=adminenv, text=True).strip()


def counts():
    return {table: int(scalar('SELECT count(*) FROM ' + table)) for table in ('exposure', 'ledger', 'job', 'trace')}


receipt = None
original_font = subprocess.check_output(['adb', 'shell', 'settings', 'get', 'system', 'font_scale'], text=True).strip()
_preview_error = None
_guard = PreviewWatch('com.knowscroll.mobile.journey', _Path.cwd() / 'artifacts' / 'preview-guard' / _Path(__file__).stem)
try:
    _guard.preserve()
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 4316))
    proxy = ThreadingHTTPServer(('127.0.0.1', 4311), Proxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    run(['createdb', *args, name], env=adminenv)
    created = True
    run(['pnpm', 'db:migrate'], env=env)
    # A finite three-Scroll library (the web reader journey's fixture): this journey reaches the
    # library's end, which the growing editorial library never does in a bounded run (#140, #136).
    run(['pnpm', 'db:seed'], env={**env, 'KS_SEED_SCROLLS': 'apps/web/e2e/fixtures/reader-library.json', 'KS_SEED_SUBSTRATE': 'none'})
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
         ':app:lintDebug', ':app:testDebugUnitTest', '--console', 'plain'], cwd='apps/mobile', env=env)
    for apk in ('app/build/outputs/apk/debug/app-debug.apk',
                'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'):
        run(['adb', 'install', '-r', 'apps/mobile/' + apk])
    run(['adb', 'shell', 'pm', 'clear', package])
    run(['adb', 'shell', 'wm', 'size', '840x1680'])
    run(['adb', 'shell', 'settings', 'put', 'system', 'font_scale', '1.3'])
    instrument('ReaderJourneyTest', 'readerSourcesThresholdAndRest')
    navigation = app_file('reader-navigation.json')
    for filename in ('reader-navigation.png', 'reader-source.png', 'reader-rest.png'):
        app_file(filename)
    navigation_counts = counts()
    if navigation_counts['exposure'] != 3 or navigation_counts['ledger'] != 3:
        raise RuntimeError('Expected exactly three explicitly visited editorial Scrolls')
    if navigation_counts['job'] or navigation_counts['trace']:
        raise RuntimeError('Reader navigation unexpectedly created Keep projection work')
    run(['adb', 'shell', 'pm', 'clear', package])
    run(['adb', 'shell', 'wm', 'size', 'reset'])
    run(['adb', 'shell', 'settings', 'put', 'system', 'font_scale', '1.0'])
    before_retry = counts()
    instrument('ReaderJourneyTest', 'readerNextFailurePreservesPage')
    retry = app_file('reader-retry.json')
    app_file('reader-retry.png')
    after_retry = counts()
    if control['feedSocketsDropped'] != 2:
        raise RuntimeError('Did not observe the two intended transport failures')
    if after_retry['exposure'] - before_retry['exposure'] != 2:
        raise RuntimeError('Expected one initial and one deliberate retry exposure')
    run(['adb', 'shell', 'pm', 'clear', package])
    instrument('ReaderPrivacyJourneyTest', 'sourceSheetClearOnForeground')
    privacy = app_file('reader-privacy.json')
    app_file('reader-privacy.png')
    if counts() != {'exposure': 0, 'ledger': 0, 'job': 0, 'trace': 0}:
        raise RuntimeError('Disposable Clear did not erase reader history')
    run(['adb', 'shell', 'pm', 'clear', package])
    instrument('ReaderAuthorityJourneyTest', 'readerNextRevokedSessionFailsClosed')
    authority = app_file('reader-authority.json')
    app_file('reader-authority.png')
    if control['sessionsRevoked'] < 1 or control['unauthorizedFeeds'] != 1:
        raise RuntimeError('Expected actual revoked-session feed rejection')
    if counts() != {'exposure': 1, 'ledger': 1, 'job': 0, 'trace': 0}:
        raise RuntimeError('Revoked next request created history or projection')
    paths = [p for p in Path('apps/mobile').rglob('*') if p.is_file() and not {'build', '.gradle', '.kotlin'}.intersection(p.parts) and p.name != 'local.properties']
    paths.append(Path('scripts/android-reader-journey.py'))
    receipt = {'check': 'android-reader-74', 'result': 'passed',
               'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'source': {'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                          'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()),
                          'files': [{'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(paths)]},
               'runtime': {'database': 'disposable PostgreSQL', 'api': 'separate process', 'worker': 'separate process',
                           'device': subprocess.check_output(['adb', 'shell', 'getprop', 'ro.build.version.sdk'], text=True).strip(),
                           'compact': '840x1680 at font_scale1.3', 'regular': 'AVD native size at font_scale1.0'},
               'navigation': navigation, 'navigationDatabaseCounts': navigation_counts,
               'retry': retry, 'retryExposureDelta': after_retry['exposure'] - before_retry['exposure'],
               'privacy': privacy, 'authority': authority, 'authorityDatabaseCounts': counts(), 'transportFixture': dict(control), 'providerCalls': 0,
               'limits': ['Transport loss is deliberately injected; all successful content/state comes from real services',
                          'No owner visual acceptance or manual TalkBack traversal', 'No desktop, Reel, branch or live provider proof']}
finally:
    # Restore the owner's preview first (only if this run replaced it), so no later cleanup can hide it.
    try: _guard.restore()
    except Exception as _error: _preview_error = _error; print(f'PREVIEW RESTORE FAILED: {_error}', flush=True)
    cleanup_errors = []
    def clean(action):
        try:
            action()
        except Exception as error:
            cleanup_errors.append(type(error).__name__)
    clean(lambda: run(['adb', 'shell', 'wm', 'size', 'reset']))
    clean(lambda: run(['adb', 'shell', 'settings', 'put', 'system', 'font_scale', original_font if original_font != 'null' else '1.0']))
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
        clean(lambda: run(['dropdb', *args, '--if-exists', name], env=adminenv))
    if cleanup_errors:
        raise RuntimeError('Reader cleanup failed: ' + ', '.join(cleanup_errors))
    if receipt:
        receipt['cleanup'] = {'databaseDropped': True, 'childrenExited': True, 'fontRestored': True, 'displaySizeReset': True}
        (out / 'release.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps({'check': 'android-reader-74', 'result': 'passed', 'receipt': str(out / 'release.json')}))
if _preview_error is not None: raise _preview_error
