"""Real emulator proof in an isolated database and separately installed journey app.
Run from repository root after sourcing scripts/env.sh. No provider mocks.
"""
from pathlib import Path
from urllib.parse import urlparse,urlunparse
import subprocess,os,uuid,time,json
import sys as _sys
from pathlib import Path as _Path
_sys.dont_write_bytecode = True
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from android_preview import PreviewGuard  # noqa: E402  (#136: the owner's .journey preview)
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
_preview_error = None
_guard = PreviewGuard('com.knowscroll.mobile.journey', _Path.cwd() / 'artifacts' / 'preview-guard' / _Path(__file__).stem)
try:
 _guard.preserve()
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
 run(['adb','shell','pm','clear',package])
 def instrument(method):
  result=subprocess.check_output(['adb','shell','am','instrument','-w','-e','class','com.knowscroll.mobile.RealJourneyTest#'+method,package+'.test/androidx.test.runner.AndroidJUnitRunner'],text=True)
  (out/(method+'.txt')).write_text(result)
  print(result)
  if 'OK (1 test)' not in result:raise RuntimeError('Android instrumentation did not pass')
 run(['adb','shell','wm','size','840x1680'])
 process_size=subprocess.check_output(['adb','shell','wm','size'],text=True).strip()
 display_density=subprocess.check_output(['adb','shell','wm','density'],text=True).strip()
 instrument('processDeathPrepare')
 component=package+'/com.knowscroll.mobile.MainActivity'
 run(['adb','shell','am','start','-W','-n',component])
 before_pid=subprocess.check_output(['adb','shell','pidof',package],text=True).strip()
 if not before_pid:raise RuntimeError('Journey app process was not running before force-stop')
 run(['adb','shell','am','force-stop',package])
 stopped=subprocess.run(['adb','shell','pidof',package],text=True,capture_output=True)
 if stopped.stdout.strip():raise RuntimeError('Journey app survived force-stop')
 run(['adb','shell','am','start','-W','-n',component])
 after_pid=subprocess.check_output(['adb','shell','pidof',package],text=True).strip()
 if not after_pid or after_pid==before_pid:raise RuntimeError('Journey app did not relaunch in a new OS process')
 instrument('processDeathRestoreKeepReturnAndNext')
 run(['adb','shell','wm','size','reset'])
 regular_size=subprocess.check_output(['adb','shell','wm','size'],text=True).strip()
 instrument('sourcedScrollKeepAndReturn')
 import signal
 os.killpg(api.pid,signal.SIGTERM);api.wait(timeout=10)
 instrument('unavailableIsHonest')
 api=service('dev:api')
 for _ in range(40):
  try:urllib.request.urlopen('http://127.0.0.1:4311/health',timeout=1);break
  except Exception:time.sleep(.25)
 run(['adb','shell','wm','size','840x1680'])
 compact_size=subprocess.check_output(['adb','shell','wm','size'],text=True).strip()
 instrument('compactLayoutAndRecovery')
 for filename in ['wave1-process-before.json','wave1-process-after.json','wave1-process-before.png','wave1-process-restored.png','wave1-process-return-next.png','j001-android.json','j001-scroll.png','j001-return.png','j001-unavailable.png','j001-compact.png','j001-recovered.png']:
  (out/filename).write_bytes(subprocess.check_output(['adb','exec-out','run-as',package,'cat','files/'+filename]))
 process_receipt=json.loads((out/'wave1-process-after.json').read_text())
 for field in ['clientExposureId','clientEventId']:
  process_receipt[field]=str(uuid.UUID(process_receipt[field]))
 def scalar(query):
  return subprocess.check_output(['psql',*args,'-d',name,'-Atqc',query],env=adminenv,text=True).strip()
 exposure_count=int(scalar("SELECT count(*) FROM exposure WHERE client_key='%s'::uuid" % process_receipt['clientExposureId']))
 exposure_ledger_count=int(scalar("SELECT count(*) FROM ledger WHERE kind='exposure' AND client_key='%s'::uuid" % process_receipt['clientExposureId']))
 keep_count=int(scalar("SELECT count(*) FROM ledger WHERE kind='keep' AND client_key='%s'::uuid" % process_receipt['clientEventId']))
 if (exposure_count,exposure_ledger_count,keep_count)!=(1,1,1):
  raise RuntimeError('Process-death retries created duplicate exposure or keep rows')
 try:head=subprocess.check_output(['git','rev-parse','HEAD'],text=True,stderr=subprocess.DEVNULL).strip()
 except subprocess.CalledProcessError:head='uncommitted bootstrap'
 import hashlib
 hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path('apps/mobile').rglob('*') if p.is_file() and 'build' not in p.parts and '.gradle' not in p.parts and '.kotlin' not in p.parts and p.name!='local.properties'}
 hashes['scripts/android-journey.py']=hashlib.sha256(Path('scripts/android-journey.py').read_bytes()).hexdigest()
 (out/'environment.json').write_text(json.dumps({'git':head,'observedAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'sourceSha256':hashes,'database':'isolated disposable PostgreSQL','apiPort':4311,'emulator':'API36 arm64','displayDensity':display_density,'regularSize':regular_size,'compactSize':compact_size,'processDeath':{'displaySize':process_size,'forceStopPid':before_pid,'relaunchPid':after_pid,'readingPosition':process_receipt['readingPosition'],'sameRetryIdentity':True,'exposureRows':exposure_count,'exposureLedgerRows':exposure_ledger_count,'keepLedgerRows':keep_count},'result':'passed'},indent=2)+'\n')
finally:
 # Restore the owner's preview first (only if this run replaced it), so no later cleanup can hide it.
 try: _guard.restore()
 except Exception as _error: _preview_error = _error; print(f'PREVIEW RESTORE FAILED: {_error}', flush=True)
 run(['adb','shell','wm','size','reset'])
 import signal
 for p,log in processes:
  if p.poll() is None:
   os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=10)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL)
  log.close()
 subprocess.run(['dropdb',*args,'--if-exists',name],env=adminenv,check=True)
if _preview_error is not None: raise _preview_error
