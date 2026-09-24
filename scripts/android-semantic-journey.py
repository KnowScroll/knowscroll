"""#131/#134 live semantic Android journey: disposable API/worker/PostgreSQL with the editorial
substrate, the separate .journey app, no provider call and no owner-database access.

Source scripts/env.sh first. The .journey app is also the owner's running preview (its APK carries
that preview's API address and token), so this runner pulls the installed APK and archives its app
data before replacing it, and in `finally` reinstalls that exact APK, restores the data and
relaunches it. Each run keeps its own timestamped backup, the runner refuses to replace the preview
unless that backup is a readable archive, and the restore is verified against the backup's listing.
Receipts go to ignored artifacts/semantic-journey/<journey>; reviewed copies are committed.

Journeys (KS_SEMANTIC_JOURNEY): `branch` (default, #131 live continuations) and `why` (#133 the
recorded path of a v3 encounter and the reader's "less like this").
"""
from pathlib import Path
from urllib.parse import urlparse, urlunparse
import datetime, hashlib, io, json, os, secrets, signal, socket, subprocess, sys, tarfile, time, urllib.request

root = Path.cwd()
config = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
source = urlparse(config['DATABASE_URL'])
assert source.hostname in ('127.0.0.1', 'localhost')
port = int(os.environ.get('KS_SEMANTIC_PORT', '4333'))
assert port not in (4310, 4320, 4322), 'never reuse an owner/preview port'
name = 'knowscroll_test_semantic_' + secrets.token_hex(8)
package = 'com.knowscroll.mobile.journey'
journey_name = os.environ.get('KS_SEMANTIC_JOURNEY', 'branch')
JOURNEYS = {
    'branch': {'test': 'com.knowscroll.mobile.SemanticBranchJourneyTest', 'receipt': 'semantic-branch.json',
               'captures': ('semantic-connections.png', 'semantic-branch-target.png', 'semantic-branch-return.png', 'semantic-hidden.png', 'semantic-failure.png')},
    'why': {'test': 'com.knowscroll.mobile.SemanticWhyJourneyTest', 'receipt': 'why-journey.json',
            'captures': ('why-path.png', 'why-corrected.png', 'why-failure.png')},
}
if journey_name not in JOURNEYS: sys.exit(f'unknown journey {journey_name}; choose one of {sorted(JOURNEYS)}')
spec = JOURNEYS[journey_name]
out = root / 'artifacts/semantic-journey' / journey_name
# Never shared between runs: a failed run must not overwrite the last good backup.
backup = out / 'preview-backup' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
out.mkdir(parents=True, exist_ok=True); backup.mkdir(mode=0o700, parents=True, exist_ok=True)
allowed = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME',
           'ANDROID_USER_HOME', 'GRADLE_USER_HOME', 'JAVA_HOME', 'npm_config_cache', 'COREPACK_HOME', 'TMPDIR')
env = {key: os.environ[key] for key in allowed if key in os.environ}
env.update({key: '' for key in config})
env.update(DATABASE_URL=urlunparse(source._replace(path='/' + name)), KS_DEV_TOKEN=secrets.token_hex(32), NODE_ENV='test',
           PORT=str(port), KS_JOURNEY_API_URL=f'http://10.0.2.2:{port}', KS_MEDIA_ROOT=str(out / 'media'))
args = ['-h', source.hostname, '-p', str(source.port or 5432), '-U', source.username]
admin = {**env, 'PGPASSWORD': source.password or ''}
processes, created, preview_apk, preview_listing = [], False, None, []

def run(command, **kwargs): return subprocess.run(command, check=True, **kwargs)
def adb(*command): return subprocess.check_output(['adb', *command], text=True).strip()
def sql(query):
    return subprocess.check_output(['psql', *args, '-d', name, '-Atqc', query], env=admin, text=True).strip()
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def archive_listing(data):
    # Names and sizes of regular files; raises on anything that is not a complete tar archive.
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        return sorted((m.name, m.size) for m in archive.getmembers() if m.isfile())
def pull_preview_data():
    data = subprocess.run(['adb', 'exec-out', 'run-as', package, 'tar', '-cf', '-', 'shared_prefs', 'files'], capture_output=True)
    if data.returncode != 0: raise RuntimeError('could not archive the preview app data; the preview was not touched')
    listing = archive_listing(data.stdout)
    if not any(name.startswith('shared_prefs/') for name, _ in listing):
        raise RuntimeError('preview app data archive has no preferences; the preview was not touched')
    return data.stdout, listing

try:
    # 1. Preserve the owner's preview exactly as it is.
    installed = subprocess.run(['adb', 'shell', 'pm', 'path', package], capture_output=True, text=True).stdout.strip()
    if installed.startswith('package:'):
        pulled = backup / 'preview-base.apk'
        run(['adb', 'pull', installed.splitlines()[0].split(':', 1)[1], str(pulled)], stdout=subprocess.DEVNULL)
        data, preview_listing = pull_preview_data()
        (backup / 'preview-data.tar').write_bytes(data)
        # Only now is the preview recoverable, so only now may anything replace it.
        preview_apk = pulled

    # 2. Disposable stack with the editorial substrate.
    with socket.socket() as probe: probe.bind(('127.0.0.1', port))
    run(['createdb', *args, name], env=admin); created = True
    run(['pnpm', 'db:migrate'], env=env, stdout=subprocess.DEVNULL)
    seeded = subprocess.check_output(['pnpm', 'db:seed'], env=env, text=True)
    assert 'editorial bridges admitted' in seeded, seeded
    for role in ('api', 'worker'):
        log = (out / (role + '.log')).open('w')
        processes.append((subprocess.Popen(['pnpm', 'dev:' + role], env=env, stdout=log, stderr=log, start_new_session=True), log))
    for attempt in range(100):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1): break
        except Exception:
            if attempt == 99: raise
            time.sleep(.1)

    # 3. Separate journey build against this stack only.
    run(['./gradlew', ':app:assembleDebug', ':app:assembleDebugAndroidTest', '--console', 'plain', '-q'], cwd=root / 'apps/mobile', env=env)
    for apk in ('debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk'):
        run(['adb', 'install', '-r', str(root / 'apps/mobile/app/build/outputs/apk' / apk)], stdout=subprocess.DEVNULL)
    adb('shell', 'pm', 'clear', package)
    result = subprocess.check_output(['adb', 'shell', 'am', 'instrument', '-w', '-e', 'class', spec['test'],
                                      package + '.test/androidx.test.runner.AndroidJUnitRunner'], text=True, timeout=420)
    (out / 'instrumentation.txt').write_text(result); print(result, flush=True)
    for filename in (spec['receipt'], *spec['captures']):
        capture = subprocess.run(['adb', 'exec-out', 'run-as', package, 'cat', 'files/' + filename], capture_output=True)
        if capture.returncode == 0 and (filename.endswith('.json') or capture.stdout.startswith(b'\x89PNG')): (out / filename).write_bytes(capture.stdout)
    if 'OK (1 test)' not in result: raise RuntimeError(f'Semantic {journey_name} journey failed')

    # 4. Verify the causal lineage the UI claimed, in the database itself.
    journey = json.loads((out / spec['receipt']).read_text())
    if journey_name == 'why':
        d, a = journey['decisionId'], journey['assetId']
        lineage = json.loads(sql(f"""SELECT json_build_object(
      'servedByV3', (SELECT count(*) FROM decision d JOIN decision_candidate dc ON dc.decision_id=d.id
          WHERE d.id='{d}' AND d.ranking_version='composer-semantic-v3' AND dc.asset_id='{a}' AND dc.rank IS NOT NULL),
      'citedKeepRecorded', (SELECT count(*) FROM decision_candidate dc CROSS JOIN LATERAL jsonb_array_elements(dc.evidence) s
          JOIN ledger l ON l.id=(s->>'eventId')::uuid WHERE dc.decision_id='{d}' AND dc.asset_id='{a}' AND dc.rank IS NOT NULL
          AND s->>'kind'='mark' AND l.kind='keep'),
      'lessLikeThis', (SELECT count(*) FROM encounter_feedback WHERE decision_id='{d}' AND asset_id='{a}' AND kind='less_like_this'),
      'attentionAccounts', (SELECT count(*) FROM attention_account),
      'sharedBridgesStillAdmitted', (SELECT count(*) FROM bridge WHERE universe_id IS NULL AND status='admitted'))"""))
        ok = (lineage['servedByV3'] == 1 and lineage['citedKeepRecorded'] >= 1 and lineage['lessLikeThis'] == 1
              and lineage['attentionAccounts'] >= 1 and lineage['sharedBridgesStillAdmitted'] == 6)
        assert ok, lineage
        limits = ['Editorial substrate; composer-semantic-v3 with bench thresholds.', 'Debug API36 emulator, not a physical device.',
                  'Scroll reader only; the Reel reader has no why sheet yet.']
    else:
        lineage = json.loads(sql(f"""SELECT json_build_object(
      'branchEvents', (SELECT count(*) FROM ledger WHERE kind='branch'),
      'branchCausedByOriginExposure', (SELECT count(*) FROM ledger l JOIN exposure e ON e.event_id=l.causation_id
          WHERE l.kind='branch' AND e.id='{journey['originExposureId']}'),
      'branchOpenDecision', (SELECT count(*) FROM branch_open WHERE decision_id='{journey['branchDecisionId']}' AND bridge_id='{journey['bridgeId']}'
          AND from_exposure_id='{journey['originExposureId']}' AND target_asset_id='{journey['targetAssetId']}'),
      'targetExposedThroughBranchDecision', (SELECT count(*) FROM exposure WHERE id='{journey['targetExposureId']}' AND decision_id='{journey['branchDecisionId']}'),
      'seemsWrong', (SELECT count(*) FROM connection_feedback WHERE objection='seems_wrong'),
      'sharedBridgesStillAdmitted', (SELECT count(*) FROM bridge WHERE universe_id IS NULL AND status='admitted'),
      'personalProposals', (SELECT count(*) FROM semantic_proposal WHERE universe_id IS NOT NULL))"""))
        expected = {'branchEvents': 1, 'branchCausedByOriginExposure': 1, 'branchOpenDecision': 1, 'targetExposedThroughBranchDecision': 1,
                    'seemsWrong': 1, 'sharedBridgesStillAdmitted': 6, 'personalProposals': 0}
        assert lineage == expected, lineage
        limits = ['Editorial substrate and bridges; no model-proposed bridge.', 'Debug API36 emulator, not a physical device.',
                  'Continuations are Scroll-only; Reels carry no concept annotations yet.']
    receipt = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'result': 'passed', 'database': name, 'apiPort': port,
               'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'package': package,
               'journeyName': journey_name, 'journey': journey, 'lineage': lineage, 'providerCalls': 0, 'limits': limits}
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(lineage), flush=True)
finally:
    cleanup_errors = []
    def attempt(label, step):
        try: step()
        except Exception as error: cleanup_errors.append(f'{label}: {error}')
    # 5. Restore the owner's preview first, so no later cleanup failure can leave it replaced:
    # exact APK (a downgrade is allowed), then its app data, verified, then relaunch it.
    def restore_preview():
        run(['adb', 'install', '-r', '-d', str(preview_apk)], stdout=subprocess.DEVNULL)
        subprocess.run(['adb', 'shell', 'pm', 'clear', package], stdout=subprocess.DEVNULL)
        data = (backup / 'preview-data.tar').read_bytes()
        subprocess.run(['adb', 'shell', f'run-as {package} tar -xf -'], input=data, check=True)
        _, restored_listing = pull_preview_data()
        subprocess.run(['adb', 'shell', 'am', 'start', '-n', package + '/com.knowscroll.mobile.MainActivity'], stdout=subprocess.DEVNULL)
        restored = subprocess.run(['adb', 'shell', 'pm', 'path', package], capture_output=True, text=True).stdout.strip()
        verified = restored_listing == preview_listing
        (out / 'preview-restored.json').write_text(json.dumps({'apkSha256': sha(preview_apk), 'restoredPath': restored, 'backup': backup.name,
            'dataBytes': len(data), 'files': len(preview_listing), 'dataVerified': verified,
            'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}, indent=2) + '\n')
        if not verified: raise RuntimeError(f'preview data restore differs from its backup; the backup is kept at {backup}')
        # The archive holds the preview's session; once the restore is proven it is not kept.
        (backup / 'preview-data.tar').unlink()
    if preview_apk is not None and preview_apk.exists(): attempt('restore preview', restore_preview)
    for child, log in processes:
        def stop(child=child):
            if child.poll() is None: os.killpg(child.pid, signal.SIGTERM); child.wait(timeout=15)
        attempt('stop ' + ' '.join(child.args[-1:]), stop)
        log.close()
    if created: attempt('drop database', lambda: run(['dropdb', '--if-exists', *args, name], env=admin))
    if cleanup_errors: raise RuntimeError('cleanup incomplete: ' + '; '.join(cleanup_errors))
