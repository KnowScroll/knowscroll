"""Guarded owner-testable Android preview; --keep leaves its disposable runtime running.

Sources scripts/env.sh first. KS_NATIVE_VIDEO{,2,3} name authorized local MP4s.
No raw media, credentials or personal captures belong in Git. Android runners run serially.
"""
from pathlib import Path
from urllib.parse import urlparse, urlunparse
import argparse, datetime, json, os, secrets, signal, socket, subprocess, time, urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--keep', action='store_true')
parser.add_argument('--scenario', default='LivingCableJourneyTest')
parser.add_argument('--record', action='store_true', help='Capture the non-personal LivingAtlasJourneyTest only')
options = parser.parse_args()
if options.record and (options.keep or options.scenario != 'LivingAtlasJourneyTest'):
    parser.error('--record is restricted to LivingAtlasJourneyTest')
root = Path.cwd()
config = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
source = urlparse(config['DATABASE_URL'])
assert source.hostname in ('localhost', '127.0.0.1')
name = 'knowscroll_test_native_' + secrets.token_hex(8)
port = int(os.environ.get('KS_NATIVE_PORT', '4322'))
out = root / 'artifacts/android-living' / ('preview' if options.keep else 'verification')
out.mkdir(parents=True, exist_ok=True)
allowed = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'ANDROID_HOME', 'ANDROID_SDK_ROOT',
           'ANDROID_AVD_HOME', 'ANDROID_USER_HOME', 'GRADLE_USER_HOME', 'JAVA_HOME', 'npm_config_cache', 'COREPACK_HOME', 'TMPDIR')
env = {key: os.environ[key] for key in allowed if key in os.environ}
env.update({key: '' for key in config})
env.update(DATABASE_URL=urlunparse(source._replace(path='/' + name)), KS_DEV_TOKEN=secrets.token_hex(32),
           NODE_ENV='test', PORT=str(port), KS_JOURNEY_API_URL=f'http://10.0.2.2:{port}', KS_MEDIA_ROOT=str(out / 'media'))
args = ['-h', source.hostname, '-p', str(source.port or 5432), '-U', source.username]
admin = {**env, 'PGPASSWORD': source.password or ''}
processes = []
created = False
success = False
package = 'com.knowscroll.mobile.journey'

def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)

def adb(*command):
    return subprocess.check_output(['adb', *command], text=True).strip()

try:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', port))
    videos = [Path(os.environ[key]).resolve() for key in ('KS_NATIVE_VIDEO', 'KS_NATIVE_VIDEO2', 'KS_NATIVE_VIDEO3')]
    assert all(video.is_file() and video.suffix == '.mp4' for video in videos)
    run(['createdb', *args, name], env=admin); created = True
    run(['pnpm', 'db:migrate'], env=env); run(['pnpm', 'db:seed'], env=env)
    fixtures = []
    for index, video in enumerate(videos):
        result = subprocess.check_output(['pnpm', 'exec', 'tsx', 'scripts/fixtures/native-reel.ts'],
            env={**env, 'KS_NATIVE_VIDEO': str(video), 'KS_NATIVE_TAG': f'authored-demo-{index + 1}'}, text=True)
        fixtures.append(json.loads(result.strip().splitlines()[-1]))
    (out / 'media-receipt.json').write_text(json.dumps(fixtures, indent=2))
    for role in ('api', 'worker'):
        log = (out / (role + '.log')).open('w')
        child = subprocess.Popen(['pnpm', 'dev:' + role], env=env, stdout=log, stderr=log, start_new_session=True)
        processes.append((child, log))
    for attempt in range(100):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1): break
        except Exception:
            if attempt == 99: raise
            time.sleep(.1)
    run(['./gradlew', ':app:assembleDebug', ':app:assembleDebugAndroidTest', '--console', 'plain'], cwd=root / 'apps/mobile', env=env)
    for apk in ('debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk'):
        run(['adb', 'install', '-r', str(root / 'apps/mobile/app/build/outputs/apk' / apk)])
    adb('shell', 'pm', 'clear', package)
    if options.keep:
        result = subprocess.check_output(['adb', 'shell', 'am', 'instrument', '-w', '-e', 'class', 'com.knowscroll.mobile.OwnerPreviewSetupTest', package + '.test/androidx.test.runner.AndroidJUnitRunner'], text=True, timeout=180)
        (out / 'visible-setup.txt').write_text(result)
        if 'OK (1 test)' not in result: raise RuntimeError('Visible preview setup failed')
        adb('shell', 'am', 'start', '-n', package + '/com.knowscroll.mobile.MainActivity')
    else:
        recording = subprocess.Popen(['adb', 'shell', 'screenrecord', '--time-limit', '35', '/sdcard/knowscroll-living.mp4']) if options.record else None
        result = subprocess.check_output(['adb', 'shell', 'am', 'instrument', '-w', '-e', 'class',
            'com.knowscroll.mobile.' + options.scenario, package + '.test/androidx.test.runner.AndroidJUnitRunner'], text=True, timeout=300)
        (out / (options.scenario + '.txt')).write_text(result)
        print(result, flush=True)
        if recording:
            recording.wait(timeout=45)
            run(['adb', 'pull', '/sdcard/knowscroll-living.mp4', str(out / 'living-motion.mp4')])
        for filename in ('living-cable.json', 'living-scroll-top.png', 'living-scroll.png', 'living-reel.png', 'living-worlds.png', 'living-failure.png',
                         'living-atlas.json', 'living-system.png', 'living-continents.png', 'living-local.png', 'living-station.png', 'living-motion.mp4'):
            capture = subprocess.run(['adb', 'exec-out', 'run-as', package, 'cat', 'files/' + filename], capture_output=True)
            if capture.returncode == 0: (out / filename).write_bytes(capture.stdout)
        if 'OK (' not in result or 'FAILURES' in result: raise RuntimeError('Android scenario failed')
        if options.scenario == 'LivingCableJourneyTest':
            counts = json.loads(subprocess.check_output(['psql', *args, '-d', name, '-Atqc',
                "SELECT json_build_object('exposures',count(*),'reels',count(*) FILTER(WHERE a.kind='Reel')) FROM exposure e JOIN asset a ON a.id=e.asset_id"], env=admin, text=True))
            assert counts == {'exposures': 2, 'reels': 1}, counts
            (out / 'exposure-counts.json').write_text(json.dumps(counts, indent=2))
    receipt = {'database': name, 'apiPort': port, 'pids': [child.pid for child, _ in processes],
        'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'package': package, 'fixture': True, 'providerCalls': 0, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (out / 'runtime.json').write_text(json.dumps(receipt, indent=2))
    success = True
finally:
    if not (options.keep and success):
        for child, log in processes:
            if child.poll() is None: os.killpg(child.pid, signal.SIGTERM); child.wait(timeout=15)
            log.close()
        if created: run(['dropdb', '--if-exists', *args, name], env=admin)
