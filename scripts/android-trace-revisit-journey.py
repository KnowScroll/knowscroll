"""Issue78: saved Trace read, HTTP/worker/PostgreSQL and real Android restoration.

Only disposable data and the separate .journey Android package are mutated.
The proxy drops trace-read sockets and applies declared disposable source/session
faults. Every successful response comes from the actual API and PostgreSQL.
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

root = Path.cwd()
config = dict(line.split('=', 1) for line in Path('.env').read_text().splitlines()
              if '=' in line and not line.startswith('#'))
source = urlparse(config['DATABASE_URL'])
if source.hostname not in ('127.0.0.1', 'localhost', '::1'):
    raise RuntimeError('Trace verification requires loopback PostgreSQL')
name = 'knowscroll_test_trace_revisit_' + uuid.uuid4().hex
args = ['-h', source.hostname, '-p', str(source.port or 5432), '-U', source.username]
adminenv = {**os.environ, 'PGPASSWORD': source.password or ''}
allowed = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'ANDROID_HOME',
           'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME', 'ANDROID_USER_HOME',
           'GRADLE_USER_HOME', 'JAVA_HOME', 'npm_config_cache', 'COREPACK_HOME', 'TMPDIR')
env = {key: os.environ[key] for key in allowed if key in os.environ}
env.update({key: '' for key in config})
env.update(DATABASE_URL=urlunparse(source._replace(path='/' + name)),
           KS_DEV_TOKEN=config['KS_DEV_TOKEN'], PORT='4316', NODE_ENV='test',
           KS_JOURNEY_API_URL='http://10.0.2.2:4311')
out = root / 'artifacts/android-trace-revisit-journey'
out.mkdir(parents=True, exist_ok=True)
package = 'com.knowscroll.mobile.journey'
processes = []
created = False
proxy = None
control_lock = threading.Lock()
control = {'dropEventId': None, 'remainingDrops': 0, 'traceSocketsDropped': 0,
           'traceReadsForwarded': 0, 'sessionsRevoked': 0, 'unauthorizedTraceReads': 0,
           'unauthorizedScopeResponses': 0, 'unauthorizedRoutes': [],
           'changedSourceResponses': 0, 'sourceMutations': 0, 'historyClears': 0}
original_sources = {}


def quoted(value):
    return "'" + str(value).replace("'", "''") + "'"


def actual_api(method, path, body=None):
    connection = http.client.HTTPConnection('127.0.0.1', 4316, timeout=15)
    try:
        payload = json.dumps(body).encode() if body is not None else None
        connection.request(method, path, payload, {'Authorization': 'Bearer ' + config['KS_DEV_TOKEN'],
                           'Content-Type': 'application/json'})
        response = connection.getresponse()
        result = response.read()
        if response.status < 200 or response.status >= 300:
            raise RuntimeError('Disposable control API refused operation')
        return json.loads(result) if result else None
    finally:
        connection.close()


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def forward(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path.startswith('/__journey/'):
            if self.command != 'POST' or not name.startswith('knowscroll_test_trace_revisit_'):
                self.send_error(400)
                return
            try:
                command = json.loads(body)
                if self.path == '/__journey/trace-mode':
                    event_id = str(uuid.UUID(command['eventId']))
                    if set(command) != {'eventId', 'mode'} or command['mode'] != 'drop_next':
                        raise ValueError('Invalid trace control')
                    with control_lock:
                        control['dropEventId'] = event_id
                        control['remainingDrops'] = 2
                elif self.path == '/__journey/source-mode':
                    asset_id = str(uuid.UUID(command['assetId']))
                    if set(command) != {'assetId', 'mode'} or command['mode'] not in ('changed', 'original'):
                        raise ValueError('Invalid source control')
                    with control_lock:
                        if asset_id not in original_sources:
                            original_sources[asset_id] = json.loads(scalar('SELECT to_json(source_title) FROM asset WHERE id=' + quoted(asset_id)))
                        value = original_sources[asset_id] + (' (source changed)' if command['mode'] == 'changed' else '')
                        changed = scalar('WITH changed AS (UPDATE asset SET source_title=' + quoted(value) + ' WHERE id=' + quoted(asset_id) + ' RETURNING id) SELECT count(*) FROM changed')
                        if changed != '1':
                            raise RuntimeError('Missing disposable source')
                        control['sourceMutations'] += 1
                elif self.path == '/__journey/revoke-sessions' and command == {}:
                    revoked = int(scalar("WITH locked AS MATERIALIZED (SELECT id FROM universe ORDER BY id FOR UPDATE), revoked AS (UPDATE device_session SET revoked_at=clock_timestamp() WHERE universe_id IN (SELECT id FROM locked) AND revoked_at IS NULL RETURNING id) SELECT count(*) FROM revoked"))
                    if revoked < 1:
                        raise RuntimeError('No disposable session revoked')
                    with control_lock:
                        control['sessionsRevoked'] += revoked
                elif self.path == '/__journey/clear-history' and command == {}:
                    current = actual_api('GET', '/v1/universe')
                    actual_api('POST', '/v1/history/clear', {'requestId': str(uuid.uuid4()),
                               'expectedPrivacyEpoch': current['privacyEpoch'], 'confirmation': 'clear-scroll-history'})
                    with control_lock:
                        control['historyClears'] += 1
                else:
                    raise ValueError('Unknown control')
                self.send_response(204)
                self.end_headers()
            except Exception:
                self.send_error(400, 'Disposable control failed')
            return
        is_trace = self.command == 'GET' and self.path.startswith('/v1/traces/')
        with control_lock:
            drop = is_trace and self.path == '/v1/traces/' + str(control['dropEventId']) and control['remainingDrops'] > 0
            if drop:
                control['remainingDrops'] -= 1
                control['traceSocketsDropped'] += 1
            elif is_trace:
                control['traceReadsForwarded'] += 1
        if drop:
            self.connection.shutdown(socket.SHUT_RDWR)
            self.close_connection = True
            return
        connection = http.client.HTTPConnection('127.0.0.1', 4316, timeout=15)
        try:
            headers = {key: value for key, value in self.headers.items() if key.lower() not in ('host', 'connection')}
            connection.request(self.command, self.path, body, headers)
            response = connection.getresponse()
            result = response.read()
            with control_lock:
                if is_trace and response.status == 401:
                    control['unauthorizedTraceReads'] += 1
                if response.status == 401 and (is_trace or self.path in ('/v1/session', '/v1/universe')):
                    control['unauthorizedScopeResponses'] += 1
                    control['unauthorizedRoutes'].append('/v1/traces/:eventId' if is_trace else self.path)
                if is_trace and response.status == 409:
                    control['changedSourceResponses'] += 1
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
    assert_services_live()
    result = subprocess.check_output([
        'adb', 'shell', 'am', 'instrument', '-w', '-e', 'class',
        'com.knowscroll.mobile.' + class_name + '#' + method,
        package + '.test/androidx.test.runner.AndroidJUnitRunner'], text=True, timeout=120)
    (out / (method + '.txt')).write_text(result)
    print(result, flush=True)
    if 'OK (1 test)' not in result:
        raise RuntimeError('Trace instrumentation failed: ' + method)
    assert_services_live()


def assert_services_live():
    if len(processes) != 2 or any(child.poll() is not None for child, _ in processes):
        raise RuntimeError('Disposable API or worker exited before journey completion')


def app_file(filename):
    value = subprocess.check_output(['adb', 'exec-out', 'run-as', package, 'cat', 'files/' + filename])
    (out / filename).write_bytes(value)
    return json.loads(value) if filename.endswith('.json') else value


def scalar(sql):
    return subprocess.check_output(['psql', *args, '-d', name, '-Atqc', sql], env=adminenv, text=True).strip()


def counts():
    return {table: int(scalar('SELECT count(*) FROM ' + table)) for table in ('decision', 'exposure', 'ledger', 'job', 'trace', 'explicit_ask', 'reasoning_job', 'reasoning_attempt', 'reasoning_accounting')}


def private_snapshot():
    # Source faults intentionally mutate asset; worker heartbeat is operational.
    # Every private table is compared in full, including values/timestamps so an
    # UPDATE cannot masquerade as a read merely by preserving row counts.
    excluded = {'asset', 'schema_migrations', 'worker_heartbeat'}
    tables = scalar("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
    result = {}
    for table in tables:
        if table in excluded:
            continue
        if not table.replace('_', '').isalnum():
            raise RuntimeError('Unexpected disposable table identifier')
        rows = scalar("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM " + table + ' t')
        result[table] = hashlib.sha256(rows.encode()).hexdigest()
    return result


receipt = None
original_font = subprocess.check_output(['adb', 'shell', 'settings', 'get', 'system', 'font_scale'], text=True).strip()
try:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 4316))
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
         ':app:lintDebug', ':app:testDebugUnitTest', '--console', 'plain'], cwd='apps/mobile', env=env)
    for apk in ('app/build/outputs/apk/debug/app-debug.apk',
                'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'):
        run(['adb', 'install', '-r', 'apps/mobile/' + apk])
    run(['adb', 'shell', 'pm', 'clear', package])
    run(['adb', 'shell', 'wm', 'size', '840x1680'])
    run(['adb', 'shell', 'settings', 'put', 'system', 'font_scale', '1.3'])
    phases = {}
    instrument('TraceRevisitJourneyTest', 'prepareProjectedTraceForRevisit')
    phases['prepare'] = app_file('trace-revisit-prepare.json')
    app_file('trace-revisit-prepare.png')
    baseline = counts()
    baseline_snapshot = private_snapshot()
    if baseline['exposure'] != 1 or baseline['ledger'] != 2 or baseline['job'] != 1 or baseline['trace'] != 1:
        raise RuntimeError('Preparation must explicitly Keep and project exactly one exposed Scroll')
    if any(baseline[key] for key in ('explicit_ask', 'reasoning_job', 'reasoning_attempt', 'reasoning_accounting')):
        raise RuntimeError('Trace preparation unexpectedly created reasoning work')
    component = package + '/com.knowscroll.mobile.MainActivity'
    run(['adb', 'shell', 'am', 'start', '-W', '-n', component])
    before_pid = subprocess.check_output(['adb', 'shell', 'pidof', package], text=True).strip()
    run(['adb', 'shell', 'am', 'force-stop', package])
    if subprocess.run(['adb', 'shell', 'pidof', package], capture_output=True).returncode == 0:
        raise RuntimeError('Journey process survived requested force-stop')
    with control_lock:
        before_cold_reads = control['traceReadsForwarded']
    run(['adb', 'shell', 'am', 'start', '-W', '-n', component])
    after_pid = subprocess.check_output(['adb', 'shell', 'pidof', package], text=True).strip()
    if not before_pid or not after_pid or before_pid == after_pid:
        raise RuntimeError('Cold restart process evidence missing')
    instrument('TraceRevisitJourneyTest', 'coldRestoreRefetchesSavedTraceIdentityAndPosition')
    phases['cold'] = app_file('trace-revisit-cold.json')
    app_file('trace-revisit-cold.png')
    if control['traceReadsForwarded'] <= before_cold_reads:
        raise RuntimeError('Cold restoration did not refetch trace authority')
    if private_snapshot() != baseline_snapshot:
        raise RuntimeError('Cold restoration mutated private domain rows')
    for method, label in [('reopensVerifiedTraceShowsSourcesAndReturns', 'sources'),
                          ('traceReadDropRetriesSameIdentity', 'retry'),
                          ('changedSourceDiscardsTraceReader', 'drift')]:
        before = counts()
        before_snapshot = private_snapshot()
        instrument('TraceRevisitJourneyTest', method)
        phases[label] = app_file('trace-revisit-' + label + '.json')
        app_file('trace-revisit-' + label + '.png')
        if counts() != before or counts() != baseline:
            raise RuntimeError('Read-only trace phase mutated domain counts: ' + label)
        if private_snapshot() != before_snapshot or private_snapshot() != baseline_snapshot:
            raise RuntimeError('Read-only trace phase mutated existing private rows: ' + label)
    if control['traceSocketsDropped'] != 2 or control['changedSourceResponses'] < 1 or control['sourceMutations'] < 2:
        raise RuntimeError('Expected real transport and source-drift failures were not observed')
    instrument('TraceRevisitJourneyTest', 'clearHistoryDiscardsOpenTrace')
    phases['clear'] = app_file('trace-revisit-clear.json')
    app_file('trace-revisit-clear.png')
    after_clear = counts()
    if any(after_clear.values()) or control['historyClears'] != 1:
        raise RuntimeError('Actual Clear did not remove the disposable private graph')
    run(['adb', 'shell', 'wm', 'size', 'reset'])
    run(['adb', 'shell', 'settings', 'put', 'system', 'font_scale', '1.0'])
    instrument('TraceRevisitJourneyTest', 'revokedSessionDiscardsOpenTrace')
    phases['authority'] = app_file('trace-revisit-authority.json')
    app_file('trace-revisit-authority.png')
    if control['sessionsRevoked'] < 1 or control['unauthorizedScopeResponses'] < 1:
        raise RuntimeError('Expected actual revoked-session rejection from the scope or trace API')
    assert_services_live()
    paths = [p for p in Path('apps/mobile').rglob('*') if p.is_file() and not {'build', '.gradle', '.kotlin'}.intersection(p.parts) and p.name != 'local.properties']
    paths.extend(Path(p) for p in ['scripts/android-trace-revisit-journey.py', 'apps/api/src/app.ts',
        'packages/db/src/trace-revisit.ts', 'packages/contracts/src/trace-revisit.ts', 'packages/db/src/identity.ts'])
    receipt = {'check': 'android-trace-revisit-78', 'result': 'passed',
               'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'source': {'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                          'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()),
                          'files': [{'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(paths)]},
               'runtime': {'database': 'disposable PostgreSQL', 'api': 'separate process', 'worker': 'separate process',
                           'device': subprocess.check_output(['adb', 'shell', 'getprop', 'ro.build.version.sdk'], text=True).strip(),
                           'compact': '840x1680 at font_scale1.3', 'regular': 'AVD native size at font_scale1.0',
                           'coldRestart': {'beforePid': before_pid, 'afterPid': after_pid, 'refetchedTrace': True}},
               'phases': phases, 'initialKeepCounts': baseline, 'readOnlyRevisitCountsUnchanged': True,
               'readOnlyRevisitRowsUnchanged': True, 'privateRowHashes': baseline_snapshot,
               'afterClearCounts': after_clear, 'afterAuthorityCounts': counts(),
               'transportFixture': {key: value for key, value in control.items() if key != 'dropEventId'}, 'providerCalls': 0,
               'limits': ['Transport loss/source drift/revocation are explicitly injected in disposable state; successful content comes from real services',
                          'No owner visual acceptance or manual TalkBack traversal', 'No historical source-version viewer, desktop, Reel or live provider proof']}

finally:
    cleanup_errors = []
    def clean(action):
        try:
            action()
        except Exception as error:
            cleanup_errors.append(type(error).__name__)
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
                try:
                    os.killpg(child.pid, 0)
                except ProcessLookupError:
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
        raise RuntimeError('Trace cleanup failed: ' + ', '.join(cleanup_errors))
    if receipt:
        receipt['cleanup'] = {'databaseDropped': True, 'childrenExited': True, 'fontRestored': True, 'displaySizeReset': True}
        (out / 'release.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps({'check': 'android-trace-revisit-78', 'result': 'passed', 'receipt': str(out / 'release.json')}))
