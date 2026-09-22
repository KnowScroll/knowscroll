"""Native #72 verification: real API/DB/media, test-only lineage, no provider or owner mutation.
Run sourced env with KS_NATIVE_VIDEO pointing to an authorized local MP4. Media stays ignored/on SSD.
"""
from pathlib import Path
from urllib.parse import urlparse, urlunparse
import datetime, hashlib, json, os, secrets, signal, socket, subprocess, time, urllib.request
root=Path.cwd()
config=dict(line.split('=',1) for line in (root/'.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
source=urlparse(config['DATABASE_URL'])
assert source.hostname in ('127.0.0.1','localhost')
video=Path(os.environ['KS_NATIVE_VIDEO']).resolve()
assert video.is_file()
name='knowscroll_test_native_'+secrets.token_hex(8)
out=root/'artifacts/android-spatial/native'
out.mkdir(parents=True,exist_ok=True)
for prior in ('receipt.json','native-journey.json','rich-preview.json','media-faults.json','atlas-stress.json'):
    (out/prior).unlink(missing_ok=True)
allowed=('PATH','HOME','LANG','LC_ALL','KS_DEV_ROOT','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_AVD_HOME','ANDROID_USER_HOME','GRADLE_USER_HOME','JAVA_HOME','npm_config_cache','COREPACK_HOME','TMPDIR')
env={key:os.environ[key] for key in allowed if key in os.environ}
env.update({key:'' for key in config})
env.update(DATABASE_URL=urlunparse(source._replace(path='/'+name)),KS_DEV_TOKEN=secrets.token_hex(32),NODE_ENV='test',PORT='4320',KS_JOURNEY_API_URL='http://10.0.2.2:4320',KS_MEDIA_ROOT=str(out/'media'),KS_NATIVE_VIDEO=str(video))
args=['-h',source.hostname,'-p',str(source.port or 5432),'-U',source.username]
admin={**env,'PGPASSWORD':source.password or ''}
processes=[]
created=False
package='com.knowscroll.mobile.journey'
def run(command,**kwargs): return subprocess.run(command,check=True,**kwargs)
def adb(*command): return subprocess.check_output(['adb',*command],text=True).strip()
font=adb('shell','settings','get','system','font_scale')
motion=adb('shell','settings','get','global','animator_duration_scale')
try:
    with socket.socket() as probe: probe.bind(('127.0.0.1',4320))
    run(['createdb',*args,name],env=admin);created=True
    run(['pnpm','db:migrate'],env=env);run(['pnpm','db:seed'],env=env)
    with (out/'seed.json').open('w') as log:
        run(['pnpm','exec','tsx','scripts/fixtures/native-reel.ts'],env=env,stdout=log)
    for role in ('api','worker'):
        log=(out/(role+'.log')).open('w')
        child=subprocess.Popen(['pnpm','dev:'+role],env=env,stdout=log,stderr=log,start_new_session=True)
        processes.append((child,log))
    for attempt in range(100):
        try:
            with urllib.request.urlopen('http://127.0.0.1:4320/health',timeout=1): break
        except Exception:
            if attempt==99: raise
            time.sleep(.1)
    run(['./gradlew',':app:assembleDebug',':app:assembleDebugAndroidTest','--console','plain'],cwd=root/'apps/mobile',env=env)
    for apk in ('debug/app-debug.apk','androidTest/debug/app-debug-androidTest.apk'):
        run(['adb','install','-r',str(root/'apps/mobile/app/build/outputs/apk'/apk)])
    adb('shell','pm','clear',package)
    adb('shell','dumpsys','gfxinfo',package,'reset')
    result=subprocess.check_output(['adb','shell','am','instrument','-w','-e','class','com.knowscroll.mobile.NativeSpatialJourneyTest',package+'.test/androidx.test.runner.AndroidJUnitRunner'],text=True,timeout=240)
    (out/'instrumentation.txt').write_text(result);print(result,flush=True)
    if 'OK (1 test)' not in result:
        failure=subprocess.run(['adb','exec-out','run-as',package,'cat','files/native-failure.png'],capture_output=True)
        if failure.returncode==0: (out/'failure.png').write_bytes(failure.stdout)
        raise RuntimeError('Native joined journey failed')
    for file in ('spatial-map.png','spatial-world.png','real-reel.png','spatial-return.png','native-journey.json'):
        (out/file).write_bytes(subprocess.check_output(['adb','exec-out','run-as',package,'cat','files/'+file]))
    run(['adb','shell',f"run-as {package} sh -c 'cat > files/native-video.mp4'"],input=video.read_bytes())
    for scenario, receipt_file in [('NativePreviewJourneyTest','rich-preview.json'),('NativeMediaFaultTest','media-faults.json'),('NativeAtlasStressTest','atlas-stress.json')]:
        if scenario=='NativeAtlasStressTest': adb('shell','settings','put','global','animator_duration_scale','0')
        result=subprocess.check_output(['adb','shell','am','instrument','-w','-e','class','com.knowscroll.mobile.'+scenario,package+'.test/androidx.test.runner.AndroidJUnitRunner'],text=True,timeout=240)
        (out/(scenario+'.txt')).write_text(result);print(result,flush=True)
        if 'OK (1 test)' not in result: raise RuntimeError(scenario+' failed')
        (out/receipt_file).write_bytes(subprocess.check_output(['adb','exec-out','run-as',package,'cat','files/'+receipt_file]))
    for file in ('rich-image-preview.png','rich-preview.png'):
        (out/file).write_bytes(subprocess.check_output(['adb','exec-out','run-as',package,'cat','files/'+file]))
    sql="SELECT json_build_object('exposures',count(*),'reelExposures',count(*) FILTER(WHERE a.kind='Reel')) FROM exposure e JOIN asset a ON a.id=e.asset_id"
    counts=subprocess.check_output(['psql',*args,'-d',name,'-Atqc',sql],env=admin,text=True)
    receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'result':'passed','database':name,'counts':json.loads(counts),'mediaSha256':hashlib.sha256(video.read_bytes()).hexdigest(),'mediaBytes':video.stat().st_size,'providerCalls':0,'limits':['Synthetic test-only generation lineage. Supplied video proves playback only.','Debug API36 emulator, not physical-device performance.','Live branch/rich block transport is unavailable.']}
    (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
finally:
    for child,log in processes:
        if child.poll() is None: os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=15)
        log.close()
    adb('shell','settings','put','system','font_scale',font if font!='null' else '1.0')
    adb('shell','settings','put','global','animator_duration_scale',motion if motion!='null' else '1.0')
    if created: run(['dropdb','--if-exists',*args,name],env=admin)
