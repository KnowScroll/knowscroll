"""A disposable stack that stays up for hands-on use of the `.journeytest` app on the emulator.

Source scripts/env.sh first, and run every command from the worktree whose code you want to use.

    python3 scripts/android-hands-on.py up [--port N] [--seed SCRIPT]... [--reel MP4[@SCROLL_ID]]... [--worker-env K=V]...
    python3 scripts/android-hands-on.py down [--keep-db]
    python3 scripts/android-hands-on.py sql "SELECT ..."
    python3 scripts/android-hands-on.py exec -- pnpm exec tsx scripts/substrate/correct-source.ts ...
    python3 scripts/android-hands-on.py restart api|worker
    python3 scripts/android-hands-on.py reinstall [--clear]
    python3 scripts/android-hands-on.py shot NAME [--ui]

`up` creates a `knowscroll_test_hands_*` database, migrates and seeds it (the editorial substrate),
optionally adds authorized local MP4s as Reels (`scripts/fixtures/native-reel.ts`; `@SCROLL_ID` mints one over
that library Scroll, so it carries the Scroll's concepts and has a why and continuations), starts the API
on a free, never-owner port and the worker, runs any `--seed` scripts against the live API, builds
and installs `com.knowscroll.mobile.journeytest` (never the owner's `.journey` preview), clears it
and launches it. It then stays in the foreground until `down` or Ctrl-C; run it in the background.
The worker gets only the environment it is given: no provider key reaches it, so every transport
is the labelled fixture unless a `--worker-env` says otherwise.

Everything goes to the ignored `artifacts/hands-on/<run>/`: `runtime.json` (no secrets), the API
and worker logs, `shots/`, and on the way down `preview-untouched.json` from PreviewWatch. The
stack's own environment (the disposable database URL and dev token) is written to `stack.env`
(mode 600) only so `sql`, `exec` and `restart` can reach the same stack; `down` deletes it and
drops the database unless `--keep-db`.
"""
from pathlib import Path
from urllib.parse import urlparse, urlunparse
import argparse, datetime, json, os, secrets, signal, socket, subprocess, sys, time, urllib.request

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from android_preview import PREVIEW_PACKAGE, PreviewWatch  # noqa: E402

OWNER_PORTS = {4310, 4320, 4322, 4325, *range(4392, 4396)}
PACKAGE = 'com.knowscroll.mobile.journeytest'
ALLOWED = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME',
           'ANDROID_USER_HOME', 'GRADLE_USER_HOME', 'JAVA_HOME', 'npm_config_cache', 'COREPACK_HOME', 'TMPDIR')
root = Path.cwd()
base = root / 'artifacts/hands-on'
current = base / 'current'  # a symlink to the running stack's directory


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def stack_dir():
    if not current.exists(): sys.exit('No hands-on stack is running from this worktree (artifacts/hands-on/current is missing).')
    return current.resolve()


def stack_env(directory):
    return json.loads((directory / 'stack.env').read_text())


def runtime(directory):
    return json.loads((directory / 'runtime.json').read_text())


def psql_args(env):
    source = urlparse(env['DATABASE_URL'])
    return (['psql', '-h', source.hostname, '-p', str(source.port or 5432), '-U', source.username, '-d', source.path[1:]],
            {**env, 'PGPASSWORD': source.password or ''})


def build_and_install(env, clear):
    subprocess.run(['./gradlew', ':app:assembleDebug', '--console', 'plain', '-q'], cwd=root / 'apps/mobile', env=env, check=True)
    subprocess.run(['adb', 'install', '-r', str(root / 'apps/mobile/app/build/outputs/apk/debug/app-debug.apk')], check=True, stdout=subprocess.DEVNULL)
    if clear: subprocess.run(['adb', 'shell', 'pm', 'clear', PACKAGE], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['adb', 'shell', 'am', 'start', '-n', PACKAGE + '/com.knowscroll.mobile.MainActivity'], check=True, stdout=subprocess.DEVNULL)


def start(role, env, directory):
    log = (directory / (role + '.log')).open('a')
    return subprocess.Popen(['pnpm', 'dev:' + role], env=env, stdout=log, stderr=log, start_new_session=True)


def stop(child):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=15)


def wait_for_health(port):
    for attempt in range(150):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1): return
        except Exception:
            if attempt == 149: raise
            time.sleep(.1)


def up(options):
    if current.exists(): sys.exit(f'A hands-on stack is already running here ({current.resolve().name}); run `down` first.')
    if options.port in OWNER_PORTS: sys.exit(f'Port {options.port} belongs to the owner; choose another.')
    # Only a live listener refuses the port (on any address: a wildcard listener would otherwise lose
    # its loopback traffic to the API); a port the last stack just released sits in TIME_WAIT.
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', options.port)) == 0: sys.exit(f'Port {options.port} is in use; choose another.')
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', options.port))
    config = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
    source = urlparse(config['DATABASE_URL'])
    assert source.hostname in ('127.0.0.1', 'localhost')
    name = 'knowscroll_test_hands_' + secrets.token_hex(6)
    directory = base / now().strftime('%Y%m%dT%H%M%SZ')
    (directory / 'shots').mkdir(parents=True)
    env = {key: os.environ[key] for key in ALLOWED if key in os.environ}
    env.update({key: '' for key in config})
    env.update(DATABASE_URL=urlunparse(source._replace(path='/' + name)), KS_DEV_TOKEN=secrets.token_hex(32), NODE_ENV='test',
               PORT=str(options.port), KS_JOURNEY_API_URL=f'http://10.0.2.2:{options.port}', KS_APP_ID_SUFFIX='.journeytest',
               KS_MEDIA_ROOT=str(directory / 'media'))
    worker_extra = dict(pair.split('=', 1) for pair in options.worker_env)
    stack_file = directory / 'stack.env'
    stack_file.touch(mode=0o600)
    stack_file.write_text(json.dumps({'api': env, 'worker': {**env, **worker_extra}}))
    guard = PreviewWatch(PREVIEW_PACKAGE, directory)
    psql, admin = psql_args(env)
    children, created, stopping, exited = {}, False, [], set()
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(True))
    signal.signal(signal.SIGINT, lambda *_: stopping.append(True))
    try:
        guard.preserve()
        subprocess.run(['createdb', *psql[1:7], name], env=admin, check=True); created = True
        subprocess.run(['pnpm', 'db:migrate'], env=env, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['pnpm', 'db:seed'], env=env, check=True, stdout=subprocess.DEVNULL)
        reels = []
        for index, spec in enumerate(options.reel):
            video, _, scroll = spec.partition('@')
            reel_env = {**env, 'KS_NATIVE_VIDEO': str(Path(video).resolve()), 'KS_NATIVE_TAG': f'hands-on-{index + 1}'}
            if scroll: reel_env['KS_NATIVE_SOURCE_ASSET'] = scroll
            reels.append(json.loads(subprocess.check_output(['pnpm', 'exec', 'tsx', 'scripts/fixtures/native-reel.ts'], text=True,
                                                            env=reel_env).strip().splitlines()[-1]))
        children['api'] = start('api', env, directory)
        children['worker'] = start('worker', {**env, **worker_extra}, directory)
        wait_for_health(options.port)
        for seed in options.seed:
            subprocess.run(['pnpm', 'exec', 'tsx', seed], env={**env, 'KS_ATLAS_SEED_API_BASE': f'http://127.0.0.1:{options.port}'},
                           check=True, stdout=(directory / 'seed.log').open('a'))
        build_and_install(env, clear=True)
        (directory / 'runtime.json').write_text(json.dumps({
            'database': name, 'apiPort': options.port, 'package': PACKAGE, 'pid': os.getpid(),
            'source': subprocess.check_output(['git', 'describe', '--always', '--dirty', '--abbrev=40'], text=True).strip(),
            'seeds': options.seed, 'reels': len(reels), 'workerEnv': sorted(worker_extra), 'startedAt': now().isoformat()}, indent=2) + '\n')
        current.symlink_to(directory.name)
        print(f'hands-on stack up: {PACKAGE} -> 127.0.0.1:{options.port}, database {name}, {directory}', flush=True)
        while not stopping:
            request = directory / 'restart'
            if request.exists():
                role = request.read_text().strip()
                request.unlink()
                stop(children[role])
                exited.discard(role)
                children[role] = start(role, {**env, **worker_extra} if role == 'worker' else env, directory)
                if role == 'api': wait_for_health(options.port)
                print(f'restarted {role}', flush=True)
            for role, child in children.items():
                if child.poll() is not None and role not in exited:
                    exited.add(role)
                    print(f'{role} exited with {child.returncode}; see {directory / (role + ".log")}', flush=True)
            time.sleep(0.5)
    finally:
        errors = []
        for label, step in [('preview', guard.restore), *[(f'stop {role}', lambda c=child: stop(c)) for role, child in children.items()]]:
            try: step()
            except Exception as error: errors.append(f'{label}: {error}')
        keep = (directory / 'keep-db').exists()
        if created and not keep:
            try: subprocess.run(['dropdb', '--if-exists', *psql[1:7], name], env=admin, check=True)
            except Exception as error: errors.append(f'drop database: {error}')
        stack_file.unlink(missing_ok=True)
        if current.is_symlink() and current.resolve() == directory: current.unlink()
        print(f'hands-on stack down ({"database kept: " + name if keep else "database dropped"})', flush=True)
        if errors: raise RuntimeError('cleanup incomplete: ' + '; '.join(errors))


def down(options):
    directory = stack_dir()
    if options.keep_db: (directory / 'keep-db').touch()
    pid = runtime(directory)['pid']
    os.kill(pid, signal.SIGTERM)
    for _ in range(120):
        if not current.exists(): return
        time.sleep(0.5)
    sys.exit(f'The stack (pid {pid}) has not finished stopping; check {directory}.')


def sql(options):
    psql, admin = psql_args(stack_env(stack_dir())['api'])
    subprocess.run([*psql, '-Atq', '-c', options.query], env=admin, check=True)


def exec_(options):
    command = options.command[1:] if options.command[:1] == ['--'] else options.command
    sys.exit(subprocess.run(command, env=stack_env(stack_dir())['api']).returncode)


def restart(options):
    directory = stack_dir()
    (directory / 'restart').write_text(options.role)
    while (directory / 'restart').exists(): time.sleep(0.2)


def reinstall(options):
    # An upgrade in place keeps the app's data, like a real update; --clear starts it fresh.
    build_and_install(stack_env(stack_dir())['api'], clear=options.clear)


def shot(options):
    shots = stack_dir() / 'shots'
    target = shots / (options.name + '.png')
    target.write_bytes(subprocess.check_output(['adb', 'exec-out', 'screencap', '-p']))
    if options.ui:
        subprocess.run(['adb', 'shell', 'uiautomator', 'dump', '/sdcard/hands-on-ui.xml'], check=True, stdout=subprocess.DEVNULL)
        (shots / (options.name + '.xml')).write_bytes(subprocess.check_output(['adb', 'exec-out', 'cat', '/sdcard/hands-on-ui.xml']))
    print(target)


parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
commands = parser.add_subparsers(dest='command_name', required=True)
command = commands.add_parser('up'); command.set_defaults(run=up)
command.add_argument('--port', type=int, default=4341)
command.add_argument('--seed', action='append', default=[], help='a script run with tsx against the live API (KS_ATLAS_SEED_API_BASE)')
command.add_argument('--reel', action='append', default=[], metavar='MP4[@SCROLL_ID]',
                     help='an authorized local MP4 to add as a Reel, optionally minted over a library Scroll')
command.add_argument('--worker-env', action='append', default=[], metavar='K=V', help='extra environment for the worker only')
command = commands.add_parser('down'); command.set_defaults(run=down)
command.add_argument('--keep-db', action='store_true')
command = commands.add_parser('sql'); command.set_defaults(run=sql); command.add_argument('query')
command = commands.add_parser('exec'); command.set_defaults(run=exec_); command.add_argument('command', nargs=argparse.REMAINDER)
command = commands.add_parser('restart'); command.set_defaults(run=restart); command.add_argument('role', choices=('api', 'worker'))
command = commands.add_parser('reinstall'); command.set_defaults(run=reinstall); command.add_argument('--clear', action='store_true')
command = commands.add_parser('shot'); command.set_defaults(run=shot); command.add_argument('name'); command.add_argument('--ui', action='store_true')

if __name__ == '__main__':
    options = parser.parse_args()
    options.run(options)
