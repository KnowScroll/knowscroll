"""Issue91: "Why this appeared" explain sheet and "Sign out this device", joined
against a real disposable HTTP/worker/PostgreSQL stack and a real API36 emulator.

Only disposable data and the separate .journey Android package are mutated. The
loopback proxy rewrites only the /v1/feed response's `reason` field for one
fixture phase, drops /v1/session/revoke sockets to model genuine network loss,
and directly revokes/restores the disposable device_session row as an explicit
setup fixture -- exactly the pattern already used by the existing reader/trace
journey scripts. Every successful response, including every terminal signed-out
state, comes from the real API's own authentication/session logic.
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
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from android_preview import PreviewGuard  # noqa: E402

root = Path.cwd()
config = dict(line.split('=', 1) for line in Path('.env').read_text().splitlines()
              if '=' in line and not line.startswith('#'))
source = urlparse(config['DATABASE_URL'])
if source.hostname not in ('127.0.0.1', 'localhost', '::1'):
    raise RuntimeError('Reader-explain verification requires loopback PostgreSQL')
name = 'knowscroll_test_reader_explain_' + uuid.uuid4().hex
args = ['-h', source.hostname, '-p', str(source.port or 5432), '-U', source.username]
adminenv = {**os.environ, 'PGPASSWORD': source.password or ''}
allowed = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'ANDROID_HOME',
           'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME', 'ANDROID_USER_HOME',
           'GRADLE_USER_HOME', 'JAVA_HOME', 'npm_config_cache', 'COREPACK_HOME', 'TMPDIR')
env = {key: os.environ[key] for key in allowed if key in os.environ}
env.update({key: '' for key in config})
# Dedicated ports: never 4310/4311/4316, which other journey scripts use. This
# script owns the emulator for the whole run, so no concurrent script clashes.
ACTUAL_PORT = '4326'
PROXY_PORT = 4321
env.update(DATABASE_URL=urlunparse(source._replace(path='/' + name)),
           KS_DEV_TOKEN=config['KS_DEV_TOKEN'], PORT=ACTUAL_PORT, NODE_ENV='test',
           KS_JOURNEY_API_URL='http://10.0.2.2:%d' % PROXY_PORT)
out = root / 'artifacts/android-reader-explain-journey'
out.mkdir(parents=True, exist_ok=True)
package = 'com.knowscroll.mobile.journey'
owner_package = 'com.knowscroll.mobile'
processes = []
created = False
proxy = None
control_lock = threading.Lock()
control = {
    'blankNextFeedReason': False, 'feedReasonsBlanked': 0,
    'remainingRevokeDrops': 0, 'revokeSocketsDropped': 0,
    'revokeSucceeded': 0, 'revokeUnauthorized': 0,
    'sessionsRevoked': 0, 'sessionsRestored': 0,
}


def actual_api(method, path, body=None):
    connection = http.client.HTTPConnection('127.0.0.1', int(ACTUAL_PORT), timeout=15)
    try:
        payload = json.dumps(body).encode() if body is not None else None
        connection.request(method, path, payload, {'Authorization': 'Bearer ' + config['KS_DEV_TOKEN'],
                           'Content-Type': 'application/json'})
        response = connection.getresponse()
        result = response.read()
        return response.status, (json.loads(result) if result else None)
    finally:
        connection.close()


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def forward(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path.startswith('/__journey/'):
            if self.command != 'POST' or not name.startswith('knowscroll_test_reader_explain_'):
                self.send_error(400)
                return
            try:
                command = json.loads(body) if body else {}
                if self.path == '/__journey/feed-reason-mode':
                    if command != {'mode': 'blank_next'}:
                        raise ValueError('Invalid feed-reason control')
                    with control_lock:
                        control['blankNextFeedReason'] = True
                    self.send_response(204); self.end_headers(); return
                if self.path == '/__journey/revoke-request-mode':
                    if command != {'mode': 'drop_next'}:
                        raise ValueError('Invalid revoke-request control')
                    with control_lock:
                        control['remainingRevokeDrops'] = 2
                    self.send_response(204); self.end_headers(); return
                if self.path == '/__journey/revoke-sessions' and command == {}:
                    revoked = int(scalar("WITH locked AS MATERIALIZED (SELECT id FROM universe ORDER BY id FOR UPDATE), revoked AS (UPDATE device_session SET revoked_at=clock_timestamp() WHERE universe_id IN (SELECT id FROM locked) AND revoked_at IS NULL RETURNING id) SELECT count(*) FROM revoked"))
                    with control_lock:
                        control['sessionsRevoked'] += revoked
                    self.send_response(204 if revoked > 0 else 409); self.end_headers(); return
                if self.path == '/__journey/restore-session' and command == {}:
                    restored = int(scalar("WITH locked AS MATERIALIZED (SELECT id FROM universe ORDER BY id FOR UPDATE), restored AS (UPDATE device_session SET revoked_at=NULL, expires_at=clock_timestamp()+interval '1 hour' WHERE universe_id IN (SELECT id FROM locked) RETURNING id) SELECT count(*) FROM restored"))
                    with control_lock:
                        control['sessionsRestored'] += restored
                    self.send_response(204 if restored > 0 else 409); self.end_headers(); return
                raise ValueError('Unknown control')
            except Exception:
                self.send_error(400, 'Disposable control failed')
            return
        # The app sends query strings (e.g. `/v1/feed?kinds=Scroll`): match the path itself (#136).
        request_path = urlparse(self.path).path
        is_revoke = self.command == 'POST' and request_path == '/v1/session/revoke'
        is_feed = self.command == 'GET' and request_path == '/v1/feed'
        with control_lock:
            drop_revoke = is_revoke and control['remainingRevokeDrops'] > 0
            if drop_revoke:
                control['remainingRevokeDrops'] -= 1
                control['revokeSocketsDropped'] += 1
        if drop_revoke:
            self.connection.shutdown(socket.SHUT_RDWR)
            self.close_connection = True
            return
        connection = http.client.HTTPConnection('127.0.0.1', int(ACTUAL_PORT), timeout=15)
        try:
            headers = {key: value for key, value in self.headers.items() if key.lower() not in ('host', 'connection')}
            connection.request(self.command, self.path, body, headers)
            response = connection.getresponse()
            result = response.read()
            if is_feed and response.status == 200:
                with control_lock:
                    blank = control['blankNextFeedReason']
                    if blank:
                        control['blankNextFeedReason'] = False
                if blank:
                    payload = json.loads(result)
                    for item in payload.get('items', []):
                        item['reason'] = ''
                    result = json.dumps(payload).encode()
                    with control_lock:
                        control['feedReasonsBlanked'] += 1
            if is_revoke and response.status == 204:
                with control_lock:
                    control['revokeSucceeded'] += 1
            if is_revoke and response.status == 401:
                with control_lock:
                    control['revokeUnauthorized'] += 1
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


def assert_services_live():
    if len(processes) != 2 or any(child.poll() is not None for child, _ in processes):
        raise RuntimeError('Disposable API or worker exited before journey completion')


def instrument(class_name, method):
    assert_services_live()
    result = subprocess.check_output([
        'adb', 'shell', 'am', 'instrument', '-w', '-e', 'class',
        'com.knowscroll.mobile.' + class_name + '#' + method,
        package + '.test/androidx.test.runner.AndroidJUnitRunner'], text=True, timeout=120)
    (out / (method + '.txt')).write_text(result)
    print(result, flush=True)
    if 'OK (1 test)' not in result:
        raise RuntimeError('Reader-explain instrumentation failed: ' + method)
    assert_services_live()


def app_file(filename):
    value = subprocess.check_output(['adb', 'exec-out', 'run-as', package, 'cat', 'files/' + filename])
    (out / filename).write_bytes(value)
    return json.loads(value) if filename.endswith('.json') else value


def scalar(sql):
    return subprocess.check_output(['psql', *args, '-d', name, '-Atqc', sql], env=adminenv, text=True).strip()


def counts():
    return {table: int(scalar('SELECT count(*) FROM ' + table)) for table in ('decision', 'exposure', 'ledger', 'job', 'trace')}


def pm_clear():
    run(['adb', 'shell', 'pm', 'clear', package])


def proxy_control(path, body):
    connection = http.client.HTTPConnection('127.0.0.1', PROXY_PORT, timeout=10)
    try:
        connection.request('POST', path, json.dumps(body).encode(), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        response.read()
        if response.status not in (200, 204):
            raise RuntimeError('Proxy control %s failed: HTTP %d' % (path, response.status))
        return response.status
    finally:
        connection.close()


def restore_session():
    """Between destructive sign-out phases: reuse the one disposable device_session
    row for the next scenario, exactly as the existing revoke-sessions control
    reuses direct SQL as a setup fixture. The app's own subsequent revoke call is
    always a genuine HTTP round trip; only this preceding setup step is direct SQL.
    """
    status, _ = actual_api('GET', '/v1/session')
    if status == 200:
        return
    proxy_control('/__journey/restore-session', {})


receipt = None
original_font = subprocess.check_output(['adb', 'shell', 'settings', 'get', 'system', 'font_scale'], text=True).strip()
owner_before = subprocess.run(['adb', 'shell', 'pm', 'path', owner_package], capture_output=True, text=True).stdout.strip()
# The `.journey` app is also the owner's running preview: preserved before anything replaces it and
# restored (verified) first in `finally` (#136, scripts/android_preview.py).
guard = PreviewGuard(package, out)
try:
    guard.preserve()
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', int(ACTUAL_PORT)))
    proxy = ThreadingHTTPServer(('127.0.0.1', PROXY_PORT), Proxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    run(['createdb', *args, name], env=adminenv)
    created = True
    run(['pnpm', 'db:migrate'], env=env)
    run(['pnpm', 'db:seed'], env=env)
    service('api')
    service('worker')
    for _ in range(60):
        try:
            with urllib.request.urlopen('http://127.0.0.1:%s/health' % ACTUAL_PORT, timeout=1) as response:
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
    pm_clear()
    run(['adb', 'shell', 'wm', 'size', '840x1680'])
    run(['adb', 'shell', 'settings', 'put', 'system', 'font_scale', '1.3'])

    phases = {}
    baseline = counts()

    # ---- Part A: "Why this appeared" (non-destructive; one shared live session) ----
    instrument('ReaderExplainJourneyTest', 'explainSheetShowsDiscoveryReasonTruthAndSourcesNote')
    phases['discovery'] = app_file('explain-discovery.json')
    app_file('explain-discovery.png')

    # The blank-reason fixture and pm clear are set up here, at the shell level,
    # never from inside a running instrumentation (which would kill its own process).
    proxy_control('/__journey/feed-reason-mode', {'mode': 'blank_next'})
    pm_clear()
    instrument('ReaderExplainJourneyTest', 'explainSheetReportsNoRecordedExplanationForABlankReason')
    phases['blankReason'] = app_file('explain-blank-reason.json')
    app_file('explain-blank-reason.png')
    if control['feedReasonsBlanked'] < 1:
        raise RuntimeError('Blank-reason fixture did not actually rewrite a feed response')

    pm_clear()
    instrument('ReaderExplainJourneyTest', 'explainSheetShowsSavedTraceOriginWithKeptDateAndNoReason')
    phases['savedTrace'] = app_file('explain-saved-trace.json')
    app_file('explain-saved-trace.png')

    pm_clear()
    instrument('ReaderExplainJourneyTest', 'explainSheetPrepareForRotationAndProcessDeath')
    phases['prepare'] = app_file('explain-prepare.json')
    app_file('explain-recreate.png')
    component = package + '/com.knowscroll.mobile.MainActivity'
    run(['adb', 'shell', 'am', 'start', '-W', '-n', component])
    before_pid = subprocess.check_output(['adb', 'shell', 'pidof', package], text=True).strip()
    run(['adb', 'shell', 'am', 'force-stop', package])
    if subprocess.run(['adb', 'shell', 'pidof', package], capture_output=True).returncode == 0:
        raise RuntimeError('Journey process survived requested force-stop')
    run(['adb', 'shell', 'am', 'start', '-W', '-n', component])
    after_pid = subprocess.check_output(['adb', 'shell', 'pidof', package], text=True).strip()
    if not before_pid or not after_pid or before_pid == after_pid:
        raise RuntimeError('Cold restart process evidence missing')
    instrument('ReaderExplainJourneyTest', 'explainSheetRestoresReadingAfterProcessDeath')
    phases['processDeath'] = app_file('explain-process-death.json')
    app_file('explain-process-death.png')
    if phases['processDeath']['sheetOpenAfterProcessDeath']:
        raise RuntimeError('A transient sheet must not reappear across real process death')

    explain_counts = counts()
    if explain_counts['exposure'] < baseline['exposure'] + 2 or explain_counts['job'] < 1 or explain_counts['trace'] < 1:
        raise RuntimeError('Explain-sheet phases did not record the expected discovery/keep/trace activity')

    run(['adb', 'shell', 'wm', 'size', 'reset'])
    run(['adb', 'shell', 'settings', 'put', 'system', 'font_scale', '1.0'])
    pm_clear()

    # ---- Part B: "Sign out this device" ----
    before_signout = counts()
    instrument('SignOutJourneyTest', 'signOutConfirmationCancelIsHarmless')
    phases['signOutCancel'] = app_file('signout-confirm.json')
    app_file('signout-confirm.png')
    if counts() != before_signout:
        raise RuntimeError('Cancelling sign-out must never touch domain rows')

    instrument('SignOutJourneyTest', 'signOutConfirmedRevokeEndsSessionHonestly')
    phases['signOutSuccess'] = app_file('signout-success.json')
    app_file('signout-success.png')
    if counts() != before_signout:
        raise RuntimeError('Sign-out must only touch device_session, never decision/exposure/ledger/job/trace')
    if control['revokeSucceeded'] < 1:
        raise RuntimeError('Expected a real 204 from the actual API for the confirmed revoke')
    restore_session()
    pm_clear()

    instrument('SignOutJourneyTest', 'signOutNetworkDroppedRevokeThenRetrySucceeds')
    phases['signOutNetworkDrop'] = app_file('signout-network-drop.json')
    app_file('signout-network-drop.png')
    app_file('signout-network-drop-resolved.png')
    if counts() != before_signout:
        raise RuntimeError('Ambiguous-then-retried sign-out must only touch device_session')
    if control['revokeSocketsDropped'] < 2:
        raise RuntimeError('Expected the real transport-loss fixture (request + its internal retry) to fire')
    restore_session()
    pm_clear()

    instrument('SignOutJourneyTest', 'signOutAlreadyRevokedSessionResolvesAsSignedOut')
    phases['signOut401'] = app_file('signout-401.json')
    app_file('signout-401.png')
    if counts() != before_signout:
        raise RuntimeError('A 401-resolved sign-out must only touch device_session')
    if control['revokeUnauthorized'] < 1:
        raise RuntimeError('Expected a real 401 from the actual API for the already-revoked session')

    run(['adb', 'shell', 'wm', 'size', 'reset'])
    assert_services_live()

    owner_after = subprocess.run(['adb', 'shell', 'pm', 'path', owner_package], capture_output=True, text=True).stdout.strip()
    journey_path = subprocess.run(['adb', 'shell', 'pm', 'path', package], capture_output=True, text=True).stdout.strip()
    if owner_before != owner_after:
        raise RuntimeError('The owner/dev app package must remain untouched by this journey')

    paths = [p for p in Path('apps/mobile').rglob('*') if p.is_file() and not {'build', '.gradle', '.kotlin'}.intersection(p.parts) and p.name != 'local.properties']
    paths.append(Path('scripts/android-reader-explain-journey.py'))
    receipt = {'check': 'android-reader-explain-91', 'result': 'passed',
               'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'source': {'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                          'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()),
                          'files': [{'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(paths)]},
               'runtime': {'database': 'disposable PostgreSQL', 'api': 'separate process', 'worker': 'separate process',
                           'device': subprocess.check_output(['adb', 'shell', 'getprop', 'ro.build.version.sdk'], text=True).strip(),
                           'compact': '840x1680 at font_scale1.3', 'regular': 'AVD native size at font_scale1.0',
                           'apiPort': ACTUAL_PORT, 'proxyPort': PROXY_PORT,
                           'coldRestart': {'beforePid': before_pid, 'afterPid': after_pid}},
               'phases': phases,
               'domainCounts': {'beforeExplain': baseline, 'afterExplain': explain_counts, 'beforeSignOut': before_signout, 'afterSignOut': counts()},
               'transportFixture': dict(control), 'providerCalls': 0,
               'ownerPackage': {'installedPathBefore': owner_before or None, 'installedPathAfter': owner_after or None, 'untouched': True},
               'journeyPackagePath': journey_path or None,
               'limits': [
                   'Transport loss and session revocation are explicitly injected fixtures; every successful response and every terminal signed-out state comes from the real API/session logic',
                   'No owner visual acceptance or manual TalkBack traversal recorded here',
                   'No desktop, physical device, Reel, semantic/living/social world or live provider proof',
                   'Concurrent restore-of-a-pending-sign-out with a still-inflight universe reconciliation is not exercised; only sequential ambiguous-then-retry and pre-revoked-then-401 are covered',
               ]}
finally:
    cleanup_errors = []
    try:
        guard.restore()
    except Exception as error:
        cleanup_errors.append('PreviewRestore: ' + str(error))
    def clean(action):
        try:
            action()
        except Exception as error:
            cleanup_errors.append(type(error).__name__ + ': ' + str(error))
    clean(lambda: run(['adb', 'shell', 'wm', 'size', 'reset']))
    clean(lambda: run(['adb', 'shell', 'settings', 'put', 'system', 'font_scale', original_font if original_font != 'null' else '1.0']))
    if proxy:
        clean(proxy.shutdown)
        clean(proxy.server_close)
    def stop_service(child, log):
        premature_exit = child.poll() is not None
        try:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
                cleanup_errors.append('ServiceRequiredForcedShutdown')
            for _ in range(50):
                groups = subprocess.check_output(['ps', '-axo', 'pgid='], text=True)
                if str(child.pid) not in {line.strip() for line in groups.splitlines()}:
                    break
                time.sleep(.1)
            else:
                cleanup_errors.append('ServiceProcessGroupStillPresent')
            if child.returncode not in (0, -signal.SIGTERM):
                cleanup_errors.append('UnexpectedServiceExit')
            if premature_exit and receipt:
                cleanup_errors.append('ServiceExitedBeforeShutdown')
        finally:
            log.close()
    for child, log in processes:
        clean(lambda child=child, log=log: stop_service(child, log))
    if created:
        clean(lambda: run(['dropdb', *args, '--if-exists', name], env=adminenv))
    if cleanup_errors:
        raise RuntimeError('Reader-explain cleanup failed: ' + ', '.join(cleanup_errors))
    if receipt:
        receipt['cleanup'] = {'databaseDropped': True, 'childrenExited': True, 'fontRestored': True, 'displaySizeReset': True}
        (out / 'release.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps({'check': 'android-reader-explain-91', 'result': 'passed', 'receipt': str(out / 'release.json')}))
