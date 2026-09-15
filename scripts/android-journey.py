"""Real emulator proof in an isolated database and separately installed journey app.
Run from repository root after sourcing scripts/env.sh. No provider mocks.
"""
from pathlib import Path
from urllib.parse import urlparse,urlunparse
import subprocess,os,uuid,time,json
root=Path.cwd();config=dict(l.split('=',1) for l in Path('.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
u=urlparse(config['DATABASE_URL']);name='knowscroll_test_'+uuid.uuid4().hex
adminenv={**os.environ,'PGPASSWORD':u.password or ''}
args=['-h',u.hostname,'-p',str(u.port or 5432),'-U',u.username]
env={**os.environ,**config,'DATABASE_URL':urlunparse(u._replace(path='/'+name)),'PORT':'4311','KS_JOURNEY_API_URL':'http://10.0.2.2:4311'}
out=root/'artifacts/android-journey';out.mkdir(parents=True,exist_ok=True)
processes=[]
def run(cmd,**kw):return subprocess.run(cmd,check=True,**kw)
def service(script):
 log=(out/(script.replace(':','-')+'.log')).open('w')
 p=subprocess.Popen(['pnpm',script],env=env,stdout=log,stderr=log,start_new_session=True);processes.append((p,log));return p
try:
 run(['createdb',*args,name],env=adminenv)
 run(['pnpm','db:migrate'],env=env);run(['pnpm','db:seed'],env=env)
 api=service('dev:api');worker=service('dev:worker')
 import urllib.request
 for _ in range(40):
  try:
   urllib.request.urlopen('http://127.0.0.1:4311/health',timeout=1);break
  except Exception:time.sleep(.25)
 else:raise RuntimeError('Journey API did not start')
 run(['./gradlew',':app:assembleDebug',':app:assembleDebugAndroidTest','--console','plain'],cwd='apps/mobile',env=env)
 for apk in ['app/build/outputs/apk/debug/app-debug.apk','app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk']:run(['adb','install','-r','apps/mobile/'+apk])
 package='com.knowscroll.mobile.journey'
 def instrument(method):
  result=subprocess.check_output(['adb','shell','am','instrument','-w','-e','class','com.knowscroll.mobile.RealJourneyTest#'+method,package+'.test/androidx.test.runner.AndroidJUnitRunner'],text=True)
  (out/(method+'.txt')).write_text(result)
  print(result)
  if 'OK (1 test)' not in result:raise RuntimeError('Android instrumentation did not pass')
 instrument('sourcedScrollKeepAndReturn')
 import signal
 os.killpg(api.pid,signal.SIGTERM);api.wait(timeout=10)
 instrument('unavailableIsHonest')
 api=service('dev:api')
 for _ in range(40):
  try:urllib.request.urlopen('http://127.0.0.1:4311/health',timeout=1);break
  except Exception:time.sleep(.25)
 run(['adb','shell','wm','size','840x1680'])
 instrument('compactLayoutAndRecovery')
 for filename in ['j001-android.json','j001-scroll.png','j001-return.png','j001-unavailable.png','j001-compact.png','j001-recovered.png']:
  (out/filename).write_bytes(subprocess.check_output(['adb','exec-out','run-as',package,'cat','files/'+filename]))
 try:head=subprocess.check_output(['git','rev-parse','HEAD'],text=True,stderr=subprocess.DEVNULL).strip()
 except subprocess.CalledProcessError:head='uncommitted bootstrap'
 import hashlib
 hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path('apps/mobile').rglob('*') if p.is_file() and 'build' not in p.parts and '.gradle' not in p.parts and '.kotlin' not in p.parts and p.name!='local.properties'}
 (out/'environment.json').write_text(json.dumps({'git':head,'sourceSha256':hashes,'database':'isolated disposable PostgreSQL','apiPort':4311,'emulator':'API36 arm64','regularSize':'1080x2400','compactSize':'840x1680','result':'passed'},indent=2)+'\n')
finally:
 run(['adb','shell','wm','size','reset'])
 import signal
 for p,log in processes:
  if p.poll() is None:
   os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=10)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL)
  log.close()
 subprocess.run(['dropdb',*args,'--if-exists',name],env=adminenv,check=True)
