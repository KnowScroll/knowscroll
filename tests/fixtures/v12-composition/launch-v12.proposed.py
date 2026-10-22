"""DISABLED v12 SOURCE PROPOSAL ONLY. No runtime or provider authority.
Future election/postflight/day/job/baseline pins are unavailable. Do not import or execute.
"""
PIN_REVIEWED = False
CANDIDATE_SHA = None
CANDIDATE_TREE = None
ARTIFACT_SHA = None
OPERATOR_SHA = None
PUSH_RUN = None
ACTUAL35_POSTFLIGHT_SHA256 = None
UTC_DAY = None
JOB_ALLOCATION_ID = None
FRESH_EXTENDED_BASELINE = None
FRESH_EXTENDED_BASELINE_SHA256 = None
if not (PIN_REVIEWED is True
    and all(isinstance(v,str) and len(v)==40 and all(c in "0123456789abcdef" for c in v) for v in (CANDIDATE_SHA,CANDIDATE_TREE))
    and all(isinstance(v,str) and len(v)==64 and all(c in "0123456789abcdef" for c in v) for v in (ARTIFACT_SHA,OPERATOR_SHA,ACTUAL35_POSTFLIGHT_SHA256))
    and type(PUSH_RUN) is int and PUSH_RUN>0
    and isinstance(UTC_DAY,str) and len(UTC_DAY)==10
    and isinstance(JOB_ALLOCATION_ID,str) and JOB_ALLOCATION_ID):
 raise SystemExit("PENDING_V12_SOURCE_POSTFLIGHT_AND_JOB_PINS_NO_IMPORT_OR_IO")
if not (isinstance(FRESH_EXTENDED_BASELINE,dict) and isinstance(FRESH_EXTENDED_BASELINE_SHA256,str) and len(FRESH_EXTENDED_BASELINE_SHA256)==64 and all(c in "0123456789abcdef" for c in FRESH_EXTENDED_BASELINE_SHA256)):
 raise SystemExit("PENDING_FRESH_EXTENDED_BASELINE_NO_IMPORT_OR_IO")
import argparse
import base64
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

from guardian import Refused, canonical, require, sha, validate

HERE = Path(__file__).resolve().parent
LEDGER = HERE.parent / 'provider-allowance-232.json'

# A minimal ephemeral upload/manager handoff, not an installed service or system configuration.
# No shell sources an environment file. PID1 alone loads the four fixed EnvironmentFile paths.
HANDOFF = r'''
import base64, hashlib, json, os, pathlib, stat, subprocess, sys, urllib.parse
def check(ok):
    if not ok: raise RuntimeError('refused')
check(os.geteuid()==0)
p=json.load(sys.stdin)
c=p['config']
aid=c['allocationId']
check(__import__('re').fullmatch(r'dev-[a-z0-9][a-z0-9-]{0,100}',aid))
# Privileged read-only identity check before the restricted manager sandbox. All raw
# environment/URLs stay in memory; only an exact successful comparison permits start.
proof_bytes=base64.b64decode(p['legacyProof'],validate=True)
check(hashlib.sha256(proof_bytes).hexdigest()==c['legacyProof']['sha256'])
proof=json.loads(proof_bytes)
check(proof['legacyUnits']==c['legacyUnits'])
def pinned_file(path,expected):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        check(stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode & 0o022)
        with os.fdopen(fd,'rb',closefd=False) as f: check(hashlib.sha256(f.read()).hexdigest()==expected)
    finally: os.close(fd)
def stage_identity():
    approved=c['legacyUnits']['ks-generation@stage.service']
    process=approved['process']
    proc=pathlib.Path('/proc')/approved['state']['MainPID']
    check((proc/'stat').read_text().rsplit(') ',1)[1].split()[19]==str(process['starttime']))
    check(os.readlink(proc/'exe')==process['executable'] and os.readlink(proc/'cwd')==process['cwd'])
    check((proc/'cmdline').read_bytes()==b'\0'.join(a.encode() for a in process['argv'])+b'\0')
    status=(proc/'status').read_text().splitlines()
    check(next(line for line in status if line.startswith('Uid:')).split()[1:]==[str(process['uid'])]*4)
    gid_slots=next(line for line in status if line.startswith('Gid:')).split()[1:]
    groups=next(line for line in status if line.startswith('Groups:')).split()[1:]
    check(sorted({int(value) for value in gid_slots+groups})==process['gids'])
    pairs=(proc/'environ').read_bytes().split(b'\0')
    env=dict(pair.split(b'=',1) for pair in pairs if b'=' in pair)
    check(env.get(b'KS_WORLD')==b'stage')
    for key,db in [(b'DATABASE_URL','knowscroll_test_stage'),(b'KS_POOL_DATABASE_URL','knowscroll_pool')]:
        url=urllib.parse.urlsplit(env[key].decode())
        check(url.scheme in {'postgres','postgresql'} and url.hostname in {'127.0.0.1','localhost','::1'} and
              (url.port or 5432)==5432 and urllib.parse.unquote(url.path)=='/'+db and
              urllib.parse.unquote(url.username or '')=='ks_stage' and not url.query and not url.fragment)
    # The reviewed source captures both connections only at startup. Require same process
    # after reads as well, so an intervening restart cannot produce a mixed identity.
    check((proc/'stat').read_text().rsplit(') ',1)[1].split()[19]==str(process['starttime']))
for name,approved in c['legacyUnits'].items():
    r=subprocess.run(['/usr/bin/systemctl','show',name,
        '--property=LoadState,ActiveState,SubState,MainPID,ControlGroup,FragmentPath,DropInPaths,Result'],
        stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin'},timeout=20)
    check(r.returncode==0 and len(r.stdout)<=200000)
    fields=dict(line.split('=',1) for line in r.stdout.decode().splitlines() if '=' in line)
    check(fields==approved['state'])
    check(fields['DropInPaths']==' '.join(x['path'] for x in approved['dropIns']))
    pinned_file(fields['FragmentPath'],approved['fragmentSha256'])
    for drop in approved['dropIns']: pinned_file(drop['path'],drop['sha256'])
stage=c['legacyUnits']['ks-generation@stage.service']['process']
check(str(pathlib.Path('/srv/knowscroll/stage/current').resolve(strict=True))==stage['currentTarget'])
entry=pathlib.Path(stage['entrypointPath'])
info=entry.lstat()
check(stat.S_ISREG(info.st_mode) and {'uid':info.st_uid,'gid':info.st_gid,
      'mode':stat.S_IMODE(info.st_mode)}==stage['entrypointMetadata'])
for part in [entry,*entry.parents]:
    info=part.lstat()
    check(not stat.S_ISLNK(info.st_mode) and 'system.posix_acl_access' not in os.listxattr(part,follow_symlinks=False))
    writable=(info.st_mode & 0o200 if info.st_uid==stage['uid'] else
              info.st_mode & 0o020 if info.st_gid in stage['gids'] else info.st_mode & 0o002)
    check(not writable)
fd=os.open(entry,os.O_RDONLY|os.O_NOFOLLOW)
try:
    with os.fdopen(fd,'rb',closefd=False) as f: check(hashlib.sha256(f.read()).hexdigest()==stage['entrypointSha256'])
finally: os.close(fd)
stage_identity()
root=pathlib.Path('/run/knowscroll/scroll-dev232')
check(root.parent.is_dir() and not root.is_symlink())
try: root.mkdir(mode=0o700)
except FileExistsError: pass
s=root.stat()
check(s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700)
dest=root/aid
dest.mkdir(mode=0o700) # Exclusive; refuses reuse even after SSH loss or a failed prior start.
body=base64.b64decode(p['guardian'],validate=True)
check(hashlib.sha256(body).hexdigest()==c['guardianSha256'])
for name,data,mode in [('guardian.py',body,0o700),('config.json',json.dumps(c,sort_keys=True,separators=(',',':')).encode(),0o600)]:
    fd=os.open(dest/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
    with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
unit='ks2-scroll232-'+aid+'.service'
release=c['expectedCurrentTarget']
# System services default to root. Omit User=root: systemd259.5's explicit-UID/
# seccomp path drops CAP_SETUID. Keep the existing cap set and all other hardening.
props={
 'Group':'root','SupplementaryGroups':'','Slice':'ks-dev.slice',
 'Restart':'no','KillMode':'mixed','TimeoutStartSec':'infinity','TimeoutStopSec':'infinity',
 'SendSIGKILL':'yes','NoNewPrivileges':'yes','PrivateTmp':'yes','PrivateDevices':'yes',
 'ProtectSystem':'strict','ProtectHome':'yes','ProtectKernelTunables':'yes',
 'ProtectKernelModules':'yes','ProtectKernelLogs':'yes','ProtectControlGroups':'yes','RestrictSUIDSGID':'yes',
 'RestrictNamespaces':'yes','LockPersonality':'yes','CapabilityBoundingSet':'CAP_SETUID CAP_SETGID CAP_KILL',
 'AmbientCapabilities':'','UMask':'0077','WorkingDirectory':str(dest),
 'ReadWritePaths':'/run/knowscroll/deploy.lock '+str(dest),
 'InaccessiblePaths':'/etc/knowscroll -/srv/knowscroll/dev/media -/srv/knowscroll/stage/media -/srv/knowscroll/live/media -/srv/knowscroll/cutroom-pool',
 'StandardInput':'null','StandardOutput':'null','StandardError':'null',
 'LimitCORE':'0','TasksMax':'32','MemoryHigh':'450M','MemoryMax':'600M',
}
argv=['/usr/bin/systemd-run','--quiet','--service-type=exec','--unit='+unit]
for k,v in props.items(): argv+=['--property='+k+'='+v]
for path in ['/etc/knowscroll/dev.v2.env','/etc/knowscroll/secrets/v2-dev/database.env',
             release+'/.ks/release.env','/etc/knowscroll/secrets/shared/minimax.env']:
    argv+=['--property=EnvironmentFile='+path]
argv+=['--setenv=KS_WORLD=dev','--setenv=NODE_ENV=production',
       '/usr/bin/python3',str(dest/'guardian.py'),str(dest/'config.json')]
# Detached manager-owned unit: deliberately NO --wait, --pipe, --pty, --collect or runtime max.
r=subprocess.run(argv,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                 env={'PATH':'/usr/bin:/bin'})
check(r.returncode==0)
print(json.dumps({'event':'manager_accepted','unit':unit,'allocationId':aid,'outcome':'not_yet_known'}))
'''

def checked_integration_proof(c):
    review=c['review']
    proof_bytes=Path(review['rootIntegrationProof']).read_bytes()
    require(sha(proof_bytes)==review['rootIntegrationProofSha256'], 'integration_proof_hash_changed')
    proof=json.loads(proof_bytes)
    # BEGIN V3: a pinned Root receipt is the trust anchor, never a boolean shortcut.
    if proof.get('schemaVersion')=='scroll-production-integration-proof.v3':
        import hashlib
        import io
        import os
        import posixpath
        import stat
        import tarfile
        def check(ok, code):
            require(ok, 'composition_v3_'+code)
        def shape(value, keys):
            check(type(value) is dict and set(value)==set(keys.split()), 'closed_shape')
        def digest(value, width=64):
            check(type(value) is str and len(value)==width and
                  all(ch in '0123456789abcdef' for ch in value), 'digest')
            return value
        def positive(value):
            check(type(value) is int and 0<value<2**53, 'positive_integer')
            return value
        def path(value):
            check(type(value) is str and 1<=len(value)<=500 and value.isascii() and
                  value.isprintable() and not value.startswith('/') and '\\' not in value and
                  all(part not in {'','.','..'} for part in value.split('/')) and
                  len(value.split('/'))<=32, 'path')
            return value
        def sequence(value, maximum, minimum=1):
            check(type(value) is list and minimum<=len(value)<=maximum, 'sequence_bound')
            return value
        def unique_json(raw):
            def pairs(entries):
                result={}
                for key,value in entries:
                    check(key not in result, 'duplicate_json_key')
                    result[key]=value
                return result
            return json.loads(raw,object_pairs_hook=pairs,
                              parse_constant=lambda _: check(False,'json_constant'))
        # All materialized evidence must be regular, owner-controlled files below agents/.
        # No symlink ancestor/final file, traversal, network lookup, extraction or code import.
        anchor=Path(review['rootIntegrationProof']).absolute().parent.parent
        total=0
        used=set()
        cache={}
        def read(ref, maximum=16*1024*1024):
            nonlocal total
            shape(ref,'path sha256')
            relative=path(ref['path'])
            expected=digest(ref['sha256'])
            target=anchor/relative
            for parent in [anchor,*target.relative_to(anchor).parents]:
                candidate=parent if parent==anchor else anchor/parent
                check(not candidate.is_symlink(), 'symlink_ancestor')
            check(not target.is_symlink(), 'symlink_file')
            key=(relative,expected)
            if key in cache:
                check(len(cache[key])<=maximum, 'file_bound')
                return cache[key]
            fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW)
            try:
                info=os.fstat(fd)
                check(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and
                      not info.st_mode & 0o022 and info.st_size<=maximum, 'file_metadata')
                total+=info.st_size
                check(total<=512*1024*1024 and len(used)<256, 'total_read_bound')
                with os.fdopen(fd,'rb',closefd=False) as stream: raw=stream.read(maximum+1)
                check(len(raw)==info.st_size and len(raw)<=maximum and sha(raw)==expected,
                      'evidence_hash')
            finally:
                os.close(fd)
            used.add(relative)
            cache[key]=raw
            return raw
        proof_ref={'path':str(Path(review['rootIntegrationProof']).absolute().relative_to(anchor)),
                   'sha256':review['rootIntegrationProofSha256']}
        check(len(proof_bytes)<=65536 and read(proof_ref,65536)==proof_bytes, 'proof_reread')
        proof=unique_json(proof_bytes)
        shape(proof,'schemaVersion head tree artifactSha256 operatorJsSha256 actualPostflightSha256 acceptedFeature producerVersions candidatePushRun candidateArtifactId receipt')
        context={key:proof[key] for key in proof if key not in {'schemaVersion','receipt'}}
        check(proof['head']==c['releaseCommit']==CANDIDATE_SHA and
              proof['tree']==CANDIDATE_TREE and proof['artifactSha256']==c['artifactSha256']==ARTIFACT_SHA and
              proof['operatorJsSha256']==c['operatorJsSha256']==OPERATOR_SHA and
              proof['actualPostflightSha256']==ACTUAL35_POSTFLIGHT_SHA256 and
              proof['acceptedFeature']==review['reviewedFeatureCommit']==review['sourcePRHead'] and
              proof['candidatePushRun']==review['integrationPushRun']==PUSH_RUN and
              proof['producerVersions']=={'claims':'scroll-claims.v4','writer':'scroll-writer.v10',
                                          'policy':'scroll-production.v12'}, 'runtime_binding')
        for key in ('head','tree','acceptedFeature'): digest(proof[key],40)
        for key in ('artifactSha256','operatorJsSha256','actualPostflightSha256'): digest(proof[key])
        positive(proof['candidatePushRun']); positive(proof['candidateArtifactId'])
        receipt_ref=proof['receipt']
        receipt=unique_json(read(receipt_ref,32*1024*1024))
        shape(receipt,'schemaVersion context baseline steps components candidateFiles migrations candidateCI archives postflight evidence')
        check(receipt['schemaVersion']=='scroll-production-composition-receipt.v1' and
              receipt['context']==context, 'receipt_context')
        # A Root acceptance pins this entire object and all opaque evidence hashes. These
        # references retain original reviews/logs; they do not replace the body checks below.
        evidence=sequence(receipt['evidence'],192)
        evidence_names=[]
        forbidden={proof_ref['path'],receipt_ref['path']}
        for ref in evidence:
            check(type(ref) is dict and ref.get('path') not in forbidden, 'circular_evidence')
            read(ref,32*1024*1024)
            evidence_names.append(ref['path'])
        check(len(set(evidence_names))==len(evidence_names), 'duplicate_evidence')
        evidence_map={ref['path']:ref['sha256'] for ref in evidence}
        def cited(ref):
            shape(ref,'path sha256')
            check(evidence_map.get(ref['path'])==ref['sha256'], 'uncited_evidence')
        cited(receipt['postflight'])
        check(receipt['postflight']['sha256']==proof['actualPostflightSha256'], 'postflight_receipt')
        def body(value):
            shape(value,'mode gitBlob sha256')
            check(value['mode'] in {'100644','100755','120000'}, 'git_mode')
            digest(value['gitBlob'],40); digest(value['sha256'])
            return value
        def files(entries):
            result={}
            for entry in sequence(entries,5000):
                shape(entry,'path body')
                name=path(entry['path'])
                check(name not in result, 'duplicate_path')
                result[name]=body(entry['body'])
            check(list(result)==sorted(result), 'path_order')
            return result
        def tree(entries):
            nodes={}
            for name,value in entries.items():
                parts=name.split('/')
                node=nodes
                for part in parts[:-1]:
                    check(part not in node or type(node[part]) is dict, 'file_directory_conflict')
                    node=node.setdefault(part,{})
                check(parts[-1] not in node, 'file_directory_conflict')
                node[parts[-1]]=(value['mode'],value['gitBlob'])
            def build(node):
                packed=[]
                for name,value in node.items():
                    directory=type(value) is dict
                    mode,oid=('40000',build(value)) if directory else value
                    packed.append(((name+('/' if directory else '')).encode(),
                                   mode.encode()+b' '+name.encode()+b'\0'+bytes.fromhex(oid)))
                raw=b''.join(value for _,value in sorted(packed))
                return hashlib.sha1(b'tree '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
            return build(nodes)
        def ci(record, event, source, source_tree=None):
            shape(record,'run event head checkout tree jobs logs artifactId archiveSha256')
            positive(record['run']); positive(record['artifactId'])
            digest(record['head'],40); digest(record['checkout'],40); digest(record['tree'],40)
            digest(record['archiveSha256']); cited(record['logs'])
            check(record['event']==event and record['head']==source and
                  (event!='push' or record['checkout']==source) and
                  (source_tree is None or record['tree']==source_tree), 'ci_binding')
            jobs=sequence(record['jobs'],6,6)
            check(all(type(job) is dict and set(job)=={'name','conclusion'} and
                      job['conclusion']=='success' for job in jobs) and
                  sorted(job['name'] for job in jobs)==['backend','build','client','integrity','release','static'],
                  'all_six')
        shape(receipt['baseline'],'commit tree files review')
        baseline=receipt['baseline']
        previous=digest(baseline['commit'],40)
        check(previous!=proof['head'] and previous!=proof['acceptedFeature'], 'self_baseline')
        cited(baseline['review'])
        current=files(baseline['files'])
        check(tree(current)==baseline['tree'], 'baseline_tree')
        steps=sequence(receipt['steps'],64)
        commits=[digest(step.get('commit'),40) for step in steps]
        check(len(set(commits+[previous]))==len(commits)+1 and commits[-1]==proof['head'], 'chain_identity')
        components={}
        for component in sequence(receipt['components'],64):
            shape(component,'id kind sourceCommit sourceTree sourceFiles prFiles paths sourceCI prCI pr review')
            identity=digest(component['id'])
            check(identity not in components and component['kind'] in {'feature','checkpoint'}, 'component_identity')
            cited(component['review'])
            source=digest(component['sourceCommit'],40)
            source_files=files(component['sourceFiles'])
            check(tree(source_files)==component['sourceTree'], 'source_tree')
            owned=sequence(component['paths'],1000)
            check(all(path(name) for name in owned) and owned==sorted(set(owned)), 'owned_paths')
            if component['kind']=='feature':
                check(source not in commits and source!=baseline['commit'] and source!=proof['head'],
                      'circular_feature')
                positive(component['pr'])
                ci(component['sourceCI'],'push',source,component['sourceTree'])
                ci(component['prCI'],'pull_request',source)
                pr_files=files(component['prFiles'])
                check(component['sourceCI']['run']!=component['prCI']['run'] and
                      tree(pr_files)==component['prCI']['tree'] and
                      all(pr_files.get(name)==source_files.get(name) for name in owned), 'source_pr_bodies')
            else:
                check(owned==['docs/CHECKPOINT.md'] and component['pr'] is None and
                      component['sourceCI'] is None and component['prCI'] is None and component['prFiles'] is None and
                      source in commits, 'checkpoint_attribution')
            components[identity]=(component,source_files)
        consumed=set()
        producer=None
        for step in steps:
            shape(step,'commit parent tree component changes')
            check(step['parent']==previous and step['component'] in components and
                  step['component'] not in consumed, 'chain_parent_or_component')
            consumed.add(step['component'])
            component,source_files=components[step['component']]
            changes=sequence(step['changes'],1000)
            names=[]
            for change in changes:
                shape(change,'path before after')
                name=path(change['path']); names.append(name)
                before=None if change['before'] is None else body(change['before'])
                after=None if change['after'] is None else body(change['after'])
                check(before!=after and current.get(name)==before and source_files.get(name)==after,
                      'change_body')
                if after is None: current.pop(name)
                else: current[name]=after
            check(names==component['paths'] and names==sorted(set(names)), 'change_paths')
            check(tree(current)==step['tree'], 'step_tree')
            if component['kind']=='checkpoint':
                check(component['sourceCommit']==step['commit'] and component['sourceTree']==step['tree'] and
                      source_files==current, 'checkpoint_source')
            if component['sourceCommit']==proof['acceptedFeature']:
                check(producer is None and component['kind']=='feature', 'producer_identity')
                producer=(component,source_files)
            previous=step['commit']
        check(consumed==set(components) and producer is not None and
              current==files(receipt['candidateFiles']) and tree(current)==proof['tree'], 'candidate_tree')
        producer_component,producer_files=producer
        check(producer_component['prCI']['run']==review['sourcePRRun'], 'producer_pr_run')
        base='packages/backend/src/modules/content/production/'
        producer_paths=sorted([base+name for name in ('README.md','roles.test.ts','roles.ts','topics.ts',
                           'writer-example.ts','writer-profile.test.ts','writer-profile.ts')]+
                          ['tests/integration/modules/scroll-production.test.ts'])
        check(producer_component['paths']==producer_paths, 'producer_paths')
        # Later reviewed documentation can evolve; executable producer + tests cannot drift.
        check(all(current.get(name)==producer_files.get(name) for name in producer_paths
                  if name!=base+'README.md'), 'producer_body_drift')
        registry=c['migrationRegistry']
        check(type(registry) is list and len(registry)==35 and receipt['migrations']==registry,
              'migration_registry')
        migration_names=[]
        for index,migration in enumerate(registry,1):
            shape(migration,'name sha256')
            check(migration['name'].startswith(f'{index:04d}_') and
                  path(migration['name'])==migration['name'] and '/' not in migration['name'], 'migration_name')
            name='migrations/'+migration['name']+'.sql'
            check(current.get(name,{}).get('sha256')==digest(migration['sha256']), 'migration_body')
            migration_names.append(migration['name'])
        check(sorted(name for name in current if name.startswith('migrations/') and name.endswith('.sql'))==
              sorted('migrations/'+name+'.sql' for name in migration_names), 'extra_migration')
        ci(receipt['candidateCI'],'push',proof['head'],proof['tree'])
        check(receipt['candidateCI']['run']==proof['candidatePushRun'] and
              receipt['candidateCI']['artifactId']==proof['candidateArtifactId'] and
              receipt['candidateCI']['archiveSha256']==proof['artifactSha256'], 'candidate_ci')
        archives=receipt['archives']
        shape(archives,'candidate api worker web producer')
        parsed={}
        def archive(record):
            shape(record,'commit file component ci')
            digest(record['commit'],40)
            if record['ci']=='candidate':
                check(record['component'] is None, 'archive_candidate_component')
                attestation=receipt['candidateCI']
            else:
                check(record['component'] in components and record['ci'] in {'source','pr'} and
                      components[record['component']][0]['kind']=='feature', 'archive_component')
                attestation=components[record['component']][0][record['ci']+'CI']
            check(record['commit']==attestation['checkout'] and
                  record['file']['sha256']==attestation['archiveSha256'], 'archive_ci_binding')
            raw=read(record['file'],96*1024*1024)
            key=(record['file']['sha256'],record['commit'])
            if key in parsed: return parsed[key]
            output={}
            names=set()
            hardlinks={}
            byte_count=0
            with tarfile.open(fileobj=io.BytesIO(raw),mode='r:') as tar:
                for member in tar:
                    name=path(member.name.rstrip('/') if member.isdir() else member.name)
                    check(name not in names and len(names)<25000, 'archive_duplicate_or_bound')
                    names.add(name)
                    if member.isdir(): continue
                    check(member.isfile() or member.issym() or member.islnk(), 'archive_type')
                    check(member.size<=8*1024*1024 and member.mode & 0o7000==0, 'archive_member')
                    if member.islnk():
                        hardlinks[name]=(member.mode,path(member.linkname))
                        continue
                    if member.issym():
                        target=member.linkname
                        check(type(target) is str and 1<=len(target)<=500 and not target.startswith('/') and
                              '\\' not in target and target.isprintable() and target.isascii() and
                              not posixpath.normpath(posixpath.join(posixpath.dirname(name),target)).startswith('../'), 'archive_symlink_target')
                        value=target.encode()
                    else:
                        value=tar.extractfile(member).read(8*1024*1024+1)
                    byte_count+=len(value)
                    check(byte_count<=128*1024*1024, 'archive_expansion')
                    output[name]=('link' if member.issym() else 'file',member.mode,value)
            def resolve(name,trail):
                check(name not in trail and len(trail)<32, 'archive_hardlink_cycle')
                if name in hardlinks:
                    mode,target=hardlinks[name]
                    result=resolve(target,trail+[name])
                    check(result[0]=='file' and mode==result[1], 'archive_hardlink_type')
                    return result
                check(name in output and output[name][0]=='file', 'archive_hardlink_target')
                return output[name]
            for name in hardlinks: output[name]=resolve(name,[])
            check(1<=len(output)<=20000, 'archive_entries')
            check('release.json' in output and output['release.json'][0]=='file', 'release_missing')
            release=unique_json(output['release.json'][2])
            check(release.get('schema')=='ks-release.v2' and release.get('commit')==record['commit'], 'release_binding')
            parsed[key]=output
            return output
        candidate=archive(archives['candidate'])
        check(archives['candidate']['ci']=='candidate' and archives['candidate']['commit']==proof['head'] and
              archives['candidate']['file']['sha256']==proof['artifactSha256'] and
              sha(candidate.get('worker/dist/operator.js',('',0,b''))[2])==proof['operatorJsSha256'], 'candidate_archive')
        check(unique_json(candidate['release.json'][2]).get('migrations')==migration_names, 'archive_registry')
        # Match the release tool's file and symlink:<target> hashes. Hard links resolve
        # only within this bounded in-memory tar map; no archive member is extracted.
        manifest=candidate.get('files.sha256')
        check(manifest is not None and manifest[0]=='file', 'archive_manifest')
        manifest_map={}
        for line in manifest[2].decode().splitlines():
            check(len(line)>66 and line[64:66]=='  ', 'manifest_line')
            name=path(line[66:]); digest(line[:64])
            check(name not in manifest_map, 'manifest_duplicate')
            manifest_map[name]=line[:64]
        check(manifest_map=={name:sha((b'symlink:' if value[0]=='link' else b'')+value[2])
                             for name,value in candidate.items() if name!='files.sha256'}, 'manifest_bodies')
        backend_package='node_modules/.pnpm/@knowscroll+backend@file++++home+runner+work+knowscroll+knowscroll+packages+backend/node_modules/@knowscroll/backend/'
        expected_exceptions=set()
        for prefix in ('api/','worker/'):
            expected_exceptions.update(prefix+name for name in ('node_modules/.modules.yaml','node_modules/.pnpm-workspace-state-v1.json'))
            expected_exceptions.update(prefix+directory+tool for directory in
                (backend_package+'node_modules/.bin/','node_modules/.pnpm/node_modules/.bin/') for tool in ('pg-boss','pino'))
        differences=set()
        for role in ('api','worker','web'):
            reference=archive(archives[role])
            prefix=role+'/'
            left={name:value for name,value in candidate.items() if name.startswith(prefix)}
            right={name:value for name,value in reference.items() if name.startswith(prefix)}
            check(left and set(left)==set(right), 'archive_paths')
            for name,value in left.items():
                other=right[name]
                if value==other: continue
                differences.add(name)
                check(name in expected_exceptions and value[:2]==other[:2] and value[0]=='file', 'unreviewed_archive_difference')
                if name.endswith('.modules.yaml') or name.endswith('.pnpm-workspace-state-v1.json'):
                    field='prunedAt' if name.endswith('.modules.yaml') else 'lastValidatedTimestamp'
                    first=unique_json(value[2]); second=unique_json(other[2])
                    check(type(first) is dict and type(second) is dict and field in first and field in second and
                          type(first[field]) in (str,int) and type(second[field]) is type(first[field]) and
                          first[field]!=second[field], 'packaging_timestamp')
                    first.pop(field); second.pop(field)
                    check(first==second, 'packaging_only_timestamp')
                else:
                    # Six exact staging-path commit substitutions, never arbitrary SHA text.
                    old=('/.staging-'+proof['head']+'/').encode()
                    new=('/.staging-'+archives[role]['commit']+'/').encode()
                    check(old!=new and value[2].count(old)==6 and other[2].count(new)==6 and
                          value[2].replace(old,new)==other[2] and other[2].replace(new,old)==value[2], 'packaging_wrapper')
        check(differences==expected_exceptions, 'exact_twelve_packaging_paths')
        original=archive(archives['producer'])
        check(archives['producer']['ci']=='source' and archives['producer']['component']==producer_component['id'] and
              archives['producer']['commit']==proof['acceptedFeature'] and
              archives['producer']['file']['sha256']==producer_component['sourceCI']['archiveSha256'], 'producer_archive_binding')
        for role in ('api','worker'):
            for module in ('roles','topics','writer-example','writer-profile'):
                for suffix in ('.js','.js.map','.d.ts','.d.ts.map'):
                    name=role+'/'+backend_package+'dist/modules/content/production/'+module+suffix
                    check(name in candidate and candidate[name]==original.get(name), 'producer_compiled_body')
        return
    # END V3: the following original v2 branch is preserved literally.
    paths=proof.get('changedPaths')
    require(isinstance(paths,list) and 1<=len(paths)<=1000 and
            all(isinstance(path,str) and 1<=len(path)<=300 and path.isprintable() and
                not path.startswith('/') and '\\' not in path and
                all(part not in {'','.','..'} for part in path.split('/')) for path in paths) and
            len(set(paths))==len(paths) and type(proof.get('changedPathCount')) is int and
            proof['changedPathCount']==len(paths), 'integration_proof_changed_paths_invalid')
    require(proof.get('schemaVersion')=='scroll-production-integration-proof.v2' and
            proof.get('head')==c['releaseCommit'] and
            proof.get('acceptedFeature')==review['reviewedFeatureCommit'] and
            proof.get('allChangedPathsExactAcceptedFeature') is True and
            proof.get('outsideChangedPathsMatchesPreviousIntegration') is True and
            [{'name':m['file'].removesuffix('.sql'),'sha256':m['sha256']}
             for m in proof.get('migrations',[])]==c['migrationRegistry'], 'integration_proof_mismatch')

def checked_legacy_proof(c):
    body=Path(c['legacyProof']['path']).read_bytes()
    require(len(body)<=100000 and sha(body)==c['legacyProof']['sha256'], 'legacy_proof_hash_changed')
    proof=json.loads(body)
    source=proof.get('source',{})
    require(proof.get('schemaVersion')=='scroll-dev-legacy-proof.v1' and
            proof.get('legacyUnits')==c['legacyUnits'] and
            source.get('commit')=='8982391fe6a0dae385fc6e3013bf46b093d2d9d9' and
            source.get('entrypointSha256')==c['legacyUnits']['ks-generation@stage.service']['process']['entrypointSha256'] and
            all(source.get(key) is True for key in ('databaseCapturedAtStartup','poolCapturedAtStartup',
                'noMiniMaxGenerationTransport','noScrollProducer')) and
            isinstance(source.get('evidence'),str) and 1<=len(source['evidence'])<=300 and
            all(proof.get('database',{}).get(key) is True for key in ('expectedLegacyDatabaseMatch',
                'expectedExistingPoolMatch','legacyNotV2','poolNotV2','loopbackOnly')),
            'legacy_independence_proof_mismatch')
    return body

def checked_allocation(c, ledger_bytes):
    require(sha(ledger_bytes)==c['ledgerSha256'], 'external_ledger_changed')
    l=json.loads(ledger_bytes)
    require(l.get('schemaVersion')=='coordinator-provider-allowance.v1' and l.get('issue')==232 and
            l.get('provider')=='minimax' and l.get('totalModelRequests')==43,
            'owner_ledger_required')
    require(l.get('development',{}).get('limit')==12 and
            l['development'].get('dispatched')==11 and l['development'].get('reserved')==0 and
            l['development'].get('unknown')==0, 'development_bucket_must_stay_11_used_1_unused')
    d=l.get('dev',{})
    require(d.get('limit')==31 and type(d.get('dispatched')) is int and d['dispatched']>=0 and
            d.get('reserved')==4 and d.get('unknown')==0 and d['dispatched']+4<=31,
            'one_concrete_dev_reservation_required')
    allocations=l.get('allocations',[])
    candidates=[a for a in allocations if a.get('id')==c['allocationId']]
    require(len(candidates)==1, 'named_allocation_required')
    a=candidates[0]
    require(a.get('bucket')=='dev' and a.get('state')=='reserved' and a.get('world')=='dev' and
            a.get('head')==c['releaseCommit'] and a.get('topic')==c['topic'] and
            a.get('policyVersion')==c['policyVersion'] and a.get('model')=='MiniMax-M3' and
            a.get('maxRequests')==4 and a.get('dispatched',0)==0 and a.get('unknown',0)==0 and
            a.get('cumulativeRequestCaps')==c['requestCaps'] and
            a.get('baselineAttemptIds')==sorted(x['id'] for x in c['baseline']['productionAttempts']) and
            a.get('baselineSnapshotSha256')==sha(canonical(c['baseline']).encode()) and
            isinstance(a.get('reservedAt'),str) and a['reservedAt'], 'allocation_mismatch')
    require(not any(x.get('id')!=a['id'] and x.get('bucket')=='dev' and
            (x.get('state')!='settled' or x.get('unknown',0)!=0) for x in allocations),
            'other_dev_allocation_unsettled')
    require(sum(x.get('dispatched',0) for x in allocations if x.get('bucket')=='dev')==d['dispatched'],
            'dev_ledger_totals_disagree')
    require(a.get('sourceReview')==c['review']['sourceEvidence'] and
            a.get('checksRun')==c['review']['integrationPushRun'], 'allocation_review_mismatch')
    return a

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config',required=True,type=Path)
    p.add_argument('--launch-reviewed',action='store_true')
    args=p.parse_args()
    require(args.config.resolve().parent==HERE and args.config.name.endswith('.reviewed.json'),
            'reviewed_config_must_be_in_assigned_ssd_directory')
    c=validate(json.loads(args.config.read_text()))
    require(c['releaseCommit']==CANDIDATE_SHA and c['artifactSha256']==ARTIFACT_SHA and
            c['operatorJsSha256']==OPERATOR_SHA and c['review']['integrationPushRun']==PUSH_RUN and
            c['utcDay']==UTC_DAY and c['allocationId']==JOB_ALLOCATION_ID and
            c['baseline']==FRESH_EXTENDED_BASELINE and sha(canonical(c['baseline']).encode())==FRESH_EXTENDED_BASELINE_SHA256,
            'future_source_and_fresh_baseline_pin_mismatch')
    checked_integration_proof(c)
    legacy_proof=checked_legacy_proof(c)
    guard=(HERE/'guardian.py').read_bytes()
    require(sha(guard)==c['guardianSha256'], 'reviewed_guardian_hash_changed')
    checked_allocation(c,LEDGER.read_bytes())
    require(__import__('datetime').datetime.now(__import__('datetime').timezone.utc).date().isoformat()==c['utcDay'],
            'utc_baseline_stale')
    unit='ks2-scroll232-'+c['allocationId']+'.service'
    if not args.launch_reviewed:
        print(canonical({'event':'local_validation_only','allocationId':c['allocationId'],
              'unit':unit,'topic':c['topic'],'head':c['releaseCommit'],'maxRequests':4,
              'remoteActionsPerformed':False}))
        return 0
    # An exclusive LOCAL intent receipt fences casual repeats after connection loss. Root must
    # reconcile the unit, cgroup, DB and external ledger; removing this file is not spend authority.
    receipt=HERE/('launch-intent-'+c['allocationId']+'.json')
    fd=os.open(receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:
        f.write(canonical({'allocationId':c['allocationId'],'configSha256':sha(canonical(c).encode()),
              'status':'dispatch_intent_remote_outcome_unknown','unit':unit})+'\n')
        f.flush()
        os.fsync(f.fileno())
    payload=canonical({'config':c,'guardian':base64.b64encode(guard).decode(),
        'legacyProof':base64.b64encode(legacy_proof).decode()}).encode()
    # Only the reviewed Python guardian and secret-free root JSON are uploaded as files.
    # SSH alias/paths/world are fixed; no provider secret or DB URL enters argv/stdin/evidence.
    remote='sudo -n /usr/bin/python3 -c '+shlex.quote(HANDOFF)
    r=subprocess.run(['/usr/bin/ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=10',
        'knowscroll-vps',remote],input=payload,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    require(r.returncode==0 and len(r.stdout)<=1000, 'ssh_handoff_unknown_inspect_do_not_retry')
    response=json.loads(r.stdout)
    require(response=={'event':'manager_accepted','unit':unit,'allocationId':c['allocationId'],
                      'outcome':'not_yet_known'}, 'manager_reply_unknown_inspect_do_not_retry')
    print(canonical(response))
    return 0

if __name__=='__main__':
    try:
        result=main()
    except (Refused,OSError,ValueError,KeyError,TypeError):
        print('{"event":"refused_or_unknown","action":"root_review_required_no_automatic_retry"}')
        result=1
    sys.exit(result)
