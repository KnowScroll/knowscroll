"""Synthetic, data-only #343/#232 fixtures; executed only in GitHub Actions.

Select and compile only checked_integration_proof from the disabled source AST.
Never import the launcher or execute guardian/HANDOFF/CLI/SSH/provider/ledger code.
Every commit, receipt, archive and CI result below is fictional test data.
"""
import ast
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
INPUTS = json.loads((HERE / 'fixture-inputs.json').read_text())
BASE = 'packages/backend/src/modules/content/production/'
PACKAGE = ('node_modules/.pnpm/@knowscroll+backend@file++++home+runner+work+'
           'knowscroll+knowscroll+packages+backend/node_modules/@knowscroll/backend/')
PRODUCER = sorted([BASE + name for name in (
    'README.md', 'roles.test.ts', 'roles.ts', 'topics.ts', 'writer-example.ts',
    'writer-profile.test.ts', 'writer-profile.ts')]
    + ['tests/integration/modules/scroll-production.test.ts'])


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def oid(label):
    return hashlib.sha1(('SYNTHETIC:' + label).encode()).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


class Refused(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Refused(code)


def body(raw, mode='100644'):
    return {'mode': mode, 'gitBlob': hashlib.sha1(
        b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest(), 'sha256': sha(raw)}


def entries(mapping):
    return [{'path': name, 'body': copy.deepcopy(value)} for name, value in sorted(mapping.items())]


def git_tree(mapping):
    """Independent bottom-up implementation of Git's directory tree encoding."""
    directories = {'': {}}
    for name, value in mapping.items():
        parts = name.split('/')
        for index in range(len(parts) - 1):
            directories.setdefault('/'.join(parts[:index + 1]), {})
        directories['/'.join(parts[:-1])][parts[-1]] = (value['mode'], value['gitBlob'])
    for directory in sorted(directories, key=lambda key: key.count('/') + (key != ''), reverse=True):
        node = directories[directory]
        ordered = sorted(node, key=lambda name: (name + ('/' if node[name][0] == '40000' else '')).encode())
        raw = b''.join(mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(digest)
                       for name in ordered for mode, digest in [node[name]])
        tree = hashlib.sha1(b'tree ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        if directory:
            parent, _, name = directory.rpartition('/')
            directories[parent][name] = ('40000', tree)
    return tree


def archive(commit, migrations, flavor, mutate=None):
    payload = {}
    for role in ('api', 'worker'):
        prefix = role + '/'
        payload[prefix + 'node_modules/.modules.yaml'] = ('file', 0o644, canonical(
            {'prunedAt': 2 if flavor == 'candidate' else 1, 'modules': ['fixture-only']}))
        payload[prefix + 'node_modules/.pnpm-workspace-state-v1.json'] = ('file', 0o644, canonical(
            {'lastValidatedTimestamp': 2 if flavor == 'candidate' else 1, 'fixture': True}))
        for directory in (PACKAGE + 'node_modules/.bin/', 'node_modules/.pnpm/node_modules/.bin/'):
            for tool in ('pg-boss', 'pino'):
                payload[prefix + directory + tool] = ('file', 0o755,
                    ('# SYNTHETIC inert wrapper\n' + ('/.staging-' + commit + '/fixture\n') * 6).encode())
        for module in ('roles', 'topics', 'writer-example', 'writer-profile'):
            for suffix in ('.js', '.js.map', '.d.ts', '.d.ts.map'):
                payload[prefix + PACKAGE + 'dist/modules/content/production/' + module + suffix] = (
                    'file', 0o644, ('SYNTHETIC NOT EXECUTABLE ' + module + suffix).encode())
    payload['worker/dist/operator.js'] = ('file', 0o644, b'SYNTHETIC OPERATOR NEVER EXECUTED')
    payload['web/index.html'] = ('file', 0o644, b'SYNTHETIC FIXTURE NOT A PRODUCT JOURNEY')
    payload['api/fixture.txt'] = ('file', 0o644, b'same hardlink body')
    payload['api/fixture-hardlink.txt'] = ('hard', 0o644, b'api/fixture.txt')
    payload['api/fixture-symlink'] = ('link', 0o777, b'fixture.txt')
    payload['release.json'] = ('file', 0o644, canonical({
        'schema': 'ks-release.v2', 'commit': commit, 'migrations': migrations}))
    if mutate:
        mutate(payload)
    def hash_value(value):
        kind, _, raw = value
        if kind == 'hard':
            raw = payload.get(raw.decode(), ('file', 0o644, b'INVALID SYNTHETIC HARDLINK'))[2]
        return sha((b'symlink:' if kind == 'link' else b'') + raw)
    manifest = ''.join(hash_value(value) + '  ' + name + '\n' for name, value in sorted(payload.items()))
    payload['files.sha256'] = ('file', 0o644, manifest.encode())
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as target:
        # Real release paths exceed USTAR name limit; use PAX headers for bounded names.
        target.format = tarfile.PAX_FORMAT
        for name, (kind, mode, raw) in sorted(payload.items()):
            member = tarfile.TarInfo(name)
            member.mode = mode
            if kind in ('link', 'hard'):
                member.type = tarfile.SYMTYPE if kind == 'link' else tarfile.LNKTYPE
                member.linkname = raw.decode()
                target.addfile(member)
            else:
                member.size = len(raw)
                target.addfile(member, io.BytesIO(raw))
    return output.getvalue()


class Fixture:
    def __init__(self, root, archive_mutations=None, producer_drift=False):
        self.root = root
        self.mutations = archive_mutations or {}
        self.refs = []
        self.commits = {name: oid(name) for name in (
            'baseline', 'producer-source', 'producer-pr', 'producer-merge',
            'later-source', 'later-pr', 'later-merge', 'candidate')}
        self.registry = [{'name': f'{index:04d}_synthetic', 'sha256': sha(f'SQL FIXTURE {index}'.encode())}
                         for index in range(1, 36)]
        self.baseline = {name: body(('OLD ' + name).encode()) for name in PRODUCER}
        self.baseline['docs/CHECKPOINT.md'] = body(b'OLD SYNTHETIC CHECKPOINT')
        self.baseline['untouched.txt'] = body(b'UNTOUCHED')
        for index, migration in enumerate(self.registry, 1):
            self.baseline['migrations/' + migration['name'] + '.sql'] = body(f'SQL FIXTURE {index}'.encode())
        first = copy.deepcopy(self.baseline)
        for name in PRODUCER:
            first[name] = body(('ACCEPTED PRODUCER ' + name).encode())
        second = copy.deepcopy(first)
        second[BASE + 'README.md'] = body(b'LATER REVIEWED README')
        second['apps/api/src/synthetic.ts'] = body(b'SYNTHETIC LATER FEATURE')
        if producer_drift:
            second[BASE + 'roles.ts'] = body(b'LATER UNACCEPTED PRODUCER DRIFT')
        final = copy.deepcopy(second)
        final['docs/CHECKPOINT.md'] = body(b'NEW REVIEWED ROOT CHECKPOINT')
        self.files = [self.baseline, first, second, final]
        migration_names = [item['name'] for item in self.registry]
        self.archive_refs = {}
        for label, commit, flavor in (
            ('candidate', 'candidate', 'candidate'), ('reference', 'later-pr', 'reference'),
            ('producer', 'producer-source', 'producer')):
            raw = archive(self.commits[commit], migration_names, flavor, self.mutations.get(label))
            self.archive_refs[label] = self.write('archives/' + label + '.tar', raw)
        self.logs = {label: self.evidence(label) for label in (
            'baseline-review', 'producer-review', 'producer-source-logs', 'producer-pr-logs',
            'later-review', 'later-source-logs', 'later-pr-logs', 'checkpoint-review', 'candidate-logs', 'postflight')}
        producer = self.component('producer', first, PRODUCER, 336)
        later_paths = sorted([BASE + 'README.md', 'apps/api/src/synthetic.ts'] +
                             ([BASE + 'roles.ts'] if producer_drift else []))
        later = self.component('later', second, later_paths, 999)
        checkpoint = {
            'id': sha(b'SYNTHETIC checkpoint component'), 'kind': 'checkpoint',
            'sourceCommit': self.commits['candidate'], 'sourceTree': git_tree(final),
            'sourceFiles': entries(final), 'prFiles': None, 'paths': ['docs/CHECKPOINT.md'],
            'sourceCI': None, 'prCI': None, 'pr': None, 'review': self.logs['checkpoint-review']}
        self.components = [producer, later, checkpoint]
        steps = []
        previous = self.commits['baseline']
        for index, (component, commit) in enumerate(zip(self.components, ('producer-merge', 'later-merge', 'candidate'))):
            before, after = self.files[index:index + 2]
            steps.append({'commit': self.commits[commit], 'parent': previous, 'tree': git_tree(after),
                          'component': component['id'], 'changes': [
                              {'path': name, 'before': copy.deepcopy(before.get(name)), 'after': copy.deepcopy(after.get(name))}
                              for name in component['paths']]})
            previous = self.commits[commit]
        candidate_ci = self.ci('candidate', final, 'push', 300, self.archive_refs['candidate'], 'candidate-logs')
        self.proof = {
            'schemaVersion': 'scroll-production-integration-proof.v3',
            'head': self.commits['candidate'], 'tree': git_tree(final),
            'artifactSha256': self.archive_refs['candidate']['sha256'],
            'operatorJsSha256': sha(b'SYNTHETIC OPERATOR NEVER EXECUTED'),
            'actualPostflightSha256': self.logs['postflight']['sha256'],
            'acceptedFeature': self.commits['producer-source'],
            'producerVersions': {'claims': 'scroll-claims.v4', 'writer': 'scroll-writer.v10',
                                 'policy': 'scroll-production.v12'},
            'candidatePushRun': 300, 'candidateArtifactId': candidate_ci['artifactId']}
        context = copy.deepcopy(self.proof)
        context.pop('schemaVersion')
        self.receipt = {
            'schemaVersion': 'scroll-production-composition-receipt.v1', 'context': context,
            'baseline': {'commit': self.commits['baseline'], 'tree': git_tree(self.baseline),
                         'files': entries(self.baseline), 'review': self.logs['baseline-review']},
            'steps': steps, 'components': self.components, 'candidateFiles': entries(final),
            'migrations': copy.deepcopy(self.registry), 'candidateCI': candidate_ci,
            'archives': {
                'candidate': self.archive_record('candidate', None, 'candidate', 'candidate'),
                'api': self.archive_record('reference', later['id'], 'pr', 'later-pr'),
                'worker': self.archive_record('reference', later['id'], 'pr', 'later-pr'),
                'web': self.archive_record('reference', later['id'], 'pr', 'later-pr'),
                'producer': self.archive_record('producer', producer['id'], 'source', 'producer-source')},
            'evidence': self.refs, 'postflight': self.logs['postflight']}
        self.config = {'releaseCommit': self.proof['head'], 'artifactSha256': self.proof['artifactSha256'],
                       'operatorJsSha256': self.proof['operatorJsSha256'], 'migrationRegistry': self.registry,
                       'review': {'reviewedFeatureCommit': self.proof['acceptedFeature'],
                                  'sourcePRHead': self.proof['acceptedFeature'], 'integrationPushRun': 300,
                                  'sourcePRRun': 101}}
        self.seal()

    def write(self, name, raw):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        target.chmod(0o600)
        return {'path': name, 'sha256': sha(raw)}

    def evidence(self, label):
        ref = self.write('evidence/' + label + '.json', canonical({'synthetic': True, 'label': label}))
        self.refs.append(ref)
        return ref

    def ci(self, commit, mapping, event, run, artifact, log):
        return {'run': run, 'event': event, 'head': self.commits[commit],
                'checkout': self.commits[commit], 'tree': git_tree(mapping),
                'jobs': [{'name': name, 'conclusion': 'success'} for name in INPUTS['jobs']],
                'logs': self.logs[log], 'artifactId': run + 1000, 'archiveSha256': artifact['sha256']}

    def component(self, label, mapping, paths, pr):
        source = self.commits[label + '-source']
        artifact = self.archive_refs['producer' if label == 'producer' else 'reference']
        source_ci = self.ci(label + '-source', mapping, 'push', 100 if label == 'producer' else 200,
                            artifact, label + '-source-logs')
        pr_files = copy.deepcopy(mapping)
        # Actual PR merge checkouts can have a different complete tree due to target docs.
        pr_files['docs/PR-TARGET-ONLY.md'] = body(b'SYNTHETIC TARGET OVERLAY')
        pr_ci = self.ci(label + '-source', pr_files, 'pull_request', source_ci['run'] + 1,
                        artifact, label + '-pr-logs')
        pr_ci['checkout'] = self.commits[label + '-pr']
        return {'id': sha(('SYNTHETIC ' + label + ' component').encode()), 'kind': 'feature',
                'sourceCommit': source, 'sourceTree': git_tree(mapping), 'sourceFiles': entries(mapping),
                'prFiles': entries(pr_files), 'paths': paths, 'sourceCI': source_ci, 'prCI': pr_ci,
                'pr': pr, 'review': self.logs[label + '-review']}

    def archive_record(self, label, component, event, commit):
        return {'commit': self.commits[commit], 'file': self.archive_refs[label],
                'component': component, 'ci': event}

    def seal(self):
        self.proof['receipt'] = self.write('coordinator/receipt.json', canonical(self.receipt))
        ref = self.write('coordinator/proof.json', canonical(self.proof))
        self.config['review'].update(rootIntegrationProof=str(self.root / ref['path']),
                                     rootIntegrationProofSha256=ref['sha256'])

    def validator(self):
        source = (HERE / 'launch-v12.proposed.py').read_text()
        parsed = ast.parse(source)
        selected = [node for node in parsed.body if isinstance(node, ast.FunctionDef)
                    and node.name == 'checked_integration_proof']
        require(len(selected) == 1, 'fixture_exactly_one_validator')
        namespace = {'Path': Path, 'json': json, 'sha': sha, 'require': require,
                     'CANDIDATE_SHA': self.proof['head'], 'CANDIDATE_TREE': self.proof['tree'],
                     'ARTIFACT_SHA': self.proof['artifactSha256'], 'OPERATOR_SHA': self.proof['operatorJsSha256'],
                     'ACTUAL35_POSTFLIGHT_SHA256': self.proof['actualPostflightSha256'], 'PUSH_RUN': 300}
        exec(compile(ast.Module(body=selected, type_ignores=[]), '<AST-selected-data-validator>', 'exec'), namespace)
        return namespace['checked_integration_proof']

    def run(self):
        self.seal()
        self.validator()(self.config)


class CompositionProof(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='v12-synthetic-', dir=os.environ['RUNNER_TEMP'])
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Fixture(Path(self.temporary.name) / 'agents')

    def reject(self, code=None):
        with self.assertRaises(Refused) as caught:
            self.fixture.run()
        if code:
            self.assertEqual(str(caught.exception), 'composition_v3_' + code)

    def test_positive_multifeature_checkpoint_distinct_pr_tree_and_all_archives(self):
        self.fixture.run()

    def test_original_v2_still_accepts_its_original_shape(self):
        fixture = self.fixture
        fixture.proof = {'schemaVersion': 'scroll-production-integration-proof.v2',
            'head': fixture.config['releaseCommit'], 'acceptedFeature': fixture.config['review']['reviewedFeatureCommit'],
            'changedPaths': ['synthetic.ts'], 'changedPathCount': 1,
            'allChangedPathsExactAcceptedFeature': True, 'outsideChangedPathsMatchesPreviousIntegration': True,
            'migrations': [{'file': entry['name'] + '.sql', 'sha256': entry['sha256']} for entry in fixture.registry]}
        # v2 has no runtime v3 globals; extract function before replacing the fixture proof.
        parsed = ast.parse((HERE / 'launch-v12.proposed.py').read_text())
        selected = next(node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == 'checked_integration_proof')
        namespace = {'Path': Path, 'json': json, 'sha': sha, 'require': require}
        exec(compile(ast.Module(body=[selected], type_ignores=[]), '<selected-v2>', 'exec'), namespace)
        raw = canonical(fixture.proof)
        ref = fixture.write('coordinator/v2.json', raw)
        fixture.config['review'].update(rootIntegrationProof=str(fixture.root / ref['path']), rootIntegrationProofSha256=ref['sha256'])
        namespace['checked_integration_proof'](fixture.config)

    def test_runtime_bindings_each_fail_independently(self):
        for key in ('head', 'tree', 'artifactSha256', 'operatorJsSha256', 'actualPostflightSha256',
                    'acceptedFeature', 'candidatePushRun', 'producerVersions'):
            with self.subTest(key=key):
                original = copy.deepcopy(self.fixture.config)
                # Mutate config or the globals after sealing, leaving the anchored receipt exact.
                function = self.fixture.validator()
                globals_key = {'head': 'CANDIDATE_SHA', 'tree': 'CANDIDATE_TREE',
                    'artifactSha256': 'ARTIFACT_SHA', 'operatorJsSha256': 'OPERATOR_SHA',
                    'actualPostflightSha256': 'ACTUAL35_POSTFLIGHT_SHA256', 'candidatePushRun': 'PUSH_RUN'}.get(key)
                if globals_key:
                    function.__globals__[globals_key] = 'WRONG'
                elif key == 'acceptedFeature':
                    self.fixture.config['review']['sourcePRHead'] = oid('wrong')
                else:
                    self.fixture.proof['producerVersions']['policy'] = 'scroll-production.v99'
                    self.fixture.seal()
                with self.assertRaisesRegex(Refused, 'runtime_binding'):
                    function(self.fixture.config)
                self.fixture.config = original
                self.fixture.proof['producerVersions']['policy'] = 'scroll-production.v12'
                self.fixture.seal()

    def test_closed_shapes_reject_unknown_fields(self):
        self.fixture.receipt['unreviewedBoolean'] = True
        self.reject('closed_shape')

    def test_context_must_equal_outer_whole_object(self):
        self.fixture.receipt['context']['candidateArtifactId'] += 1
        self.reject('receipt_context')

    def test_self_baseline(self):
        self.fixture.receipt['baseline']['commit'] = self.fixture.proof['head']
        self.reject('self_baseline')

    def test_baseline_tree_mismatch(self):
        self.fixture.receipt['baseline']['files'][0]['body']['gitBlob'] = oid('wrong')
        self.reject('baseline_tree')

    def test_chain_parent_gap(self):
        self.fixture.receipt['steps'][1]['parent'] = oid('gap')
        self.reject('chain_parent_or_component')

    def test_chain_duplicate_commit(self):
        self.fixture.receipt['steps'][1]['commit'] = self.fixture.receipt['steps'][0]['commit']
        self.reject('chain_identity')

    def test_chain_wrong_before_body(self):
        self.fixture.receipt['steps'][0]['changes'][0]['before']['sha256'] = 'a' * 64
        self.reject('change_body')

    def test_chain_wrong_after_body(self):
        self.fixture.receipt['steps'][0]['changes'][0]['after']['sha256'] = 'a' * 64
        self.reject('change_body')

    def test_chain_noop(self):
        change = self.fixture.receipt['steps'][0]['changes'][0]
        change['after'] = copy.deepcopy(change['before'])
        self.reject('change_body')

    def test_omitted_checkpoint_cannot_be_attributed_to_feature(self):
        self.fixture.receipt['components'][2]['kind'] = 'feature'
        self.reject('circular_feature')

    def test_root_checkpoint_cannot_widen_paths(self):
        self.fixture.receipt['components'][2]['paths'] = ['apps/api/src/synthetic.ts']
        self.reject('checkpoint_attribution')

    def test_missing_component(self):
        self.fixture.receipt['components'].pop()
        self.reject('chain_parent_or_component')

    def test_source_circular_attribution(self):
        self.fixture.receipt['components'][0]['sourceCommit'] = self.fixture.receipt['steps'][0]['commit']
        self.reject('circular_feature')

    def test_wrong_source_tree(self):
        self.fixture.receipt['components'][0]['sourceTree'] = oid('wrong')
        self.reject('source_tree')

    def test_pr_changed_owned_body(self):
        component = self.fixture.receipt['components'][0]
        entry = next(entry for entry in component['prFiles'] if entry['path'] == BASE + 'roles.ts')
        entry['body'] = body(b'WRONG PR BODY')
        component['prCI']['tree'] = git_tree({entry['path']: entry['body'] for entry in component['prFiles']})
        self.reject('source_pr_bodies')

    def test_failed_or_missing_or_duplicate_each_required_job(self):
        for ci_name in ('sourceCI', 'prCI'):
            for job in INPUTS['jobs']:
                with self.subTest(ci=ci_name, job=job):
                    record = self.fixture.receipt['components'][0][ci_name]
                    original = copy.deepcopy(record['jobs'])
                    next(entry for entry in record['jobs'] if entry['name'] == job)['conclusion'] = 'failure'
                    self.reject('all_six')
                    record['jobs'] = original
        record = self.fixture.receipt['candidateCI']
        record['jobs'][0] = copy.deepcopy(record['jobs'][1])
        self.reject('all_six')

    def test_ci_wrong_actual_head(self):
        self.fixture.receipt['components'][0]['prCI']['head'] = oid('foreign')
        self.reject('ci_binding')

    def test_ci_wrong_source_checkout(self):
        self.fixture.receipt['components'][0]['sourceCI']['checkout'] = oid('foreign')
        self.reject('ci_binding')

    def test_candidate_run_artifact_binding(self):
        self.fixture.receipt['candidateCI']['artifactId'] += 1
        self.reject('candidate_ci')

    def test_producer_run_binding(self):
        self.fixture.config['review']['sourcePRRun'] += 1
        self.reject('producer_pr_run')

    def test_migration_body_and_registry_not_labels(self):
        self.fixture.receipt['migrations'][0]['sha256'] = 'a' * 64
        self.reject('migration_registry')

    def test_receipt_hash_tamper(self):
        self.fixture.seal()
        target = self.fixture.root / self.fixture.proof['receipt']['path']
        target.write_bytes(target.read_bytes() + b' ')
        with self.assertRaisesRegex(Refused, 'evidence_hash'):
            self.fixture.validator()(self.fixture.config)

    def test_proof_hash_tamper(self):
        target = Path(self.fixture.config['review']['rootIntegrationProof'])
        target.write_bytes(target.read_bytes() + b' ')
        with self.assertRaisesRegex(Refused, 'integration_proof_hash_changed'):
            self.fixture.validator()(self.fixture.config)

    def test_circular_evidence(self):
        self.fixture.receipt['evidence'].append(self.fixture.proof['receipt'])
        self.reject('circular_evidence')

    def test_missing_review_evidence(self):
        self.fixture.receipt['evidence'].pop(0)
        self.reject('uncited_evidence')

    def test_duplicate_evidence(self):
        self.fixture.receipt['evidence'].append(self.fixture.receipt['evidence'][0])
        self.reject('duplicate_evidence')

    def test_evidence_traversal(self):
        self.fixture.receipt['evidence'][0]['path'] = '../outside.json'
        self.reject('path')

    def test_evidence_symlink(self):
        target = self.fixture.root / self.fixture.refs[0]['path']
        raw = target.read_bytes()
        target.unlink()
        sibling = target.with_name('symlink-target.json')
        sibling.write_bytes(raw)
        target.symlink_to(sibling)
        self.reject('symlink_file')

    def test_evidence_writable_by_group(self):
        (self.fixture.root / self.fixture.refs[0]['path']).chmod(0o660)
        self.reject('file_metadata')

    def test_path_duplicate_and_traversal(self):
        self.fixture.receipt['candidateFiles'].append(self.fixture.receipt['candidateFiles'][0])
        self.reject('duplicate_path')

    def test_file_directory_conflict(self):
        mapping = {entry['path']: entry['body'] for entry in self.fixture.receipt['baseline']['files']}
        mapping['packages'] = body(b'CONFLICT')
        self.fixture.receipt['baseline']['files'] = entries(mapping)
        self.reject('file_directory_conflict')

    def test_boolean_is_not_integer(self):
        self.fixture.receipt['components'][0]['sourceCI']['run'] = True
        self.reject('positive_integer')

    def test_sequence_budget(self):
        self.fixture.receipt['steps'] *= 22
        self.reject('sequence_bound')

    def test_json_duplicate_key(self):
        self.fixture.seal()
        raw = canonical(self.fixture.receipt)
        raw = b'{"schemaVersion":"bad",' + raw[1:]
        self.fixture.proof['receipt'] = self.fixture.write('coordinator/duplicate.json', raw)
        ref = self.fixture.write('coordinator/proof.json', canonical(self.fixture.proof))
        self.fixture.config['review']['rootIntegrationProofSha256'] = ref['sha256']
        with self.assertRaisesRegex(Refused, 'duplicate_json_key'):
            self.fixture.validator()(self.fixture.config)

    def test_archive_foreign_reference_cannot_masquerade_as_reviewed(self):
        self.fixture.receipt['archives']['api']['commit'] = oid('foreign')
        self.reject('archive_ci_binding')

    def test_archive_unreviewed_code_difference(self):
        root = Path(self.temporary.name) / 'other-agents'
        self.fixture = Fixture(root, {'candidate': lambda files: files.__setitem__(
            'web/index.html', ('file', 0o644, b'UNREVIEWED CODE'))})
        self.reject('unreviewed_archive_difference')

    def test_archive_thirteenth_packaging_difference(self):
        root = Path(self.temporary.name) / 'other-agents'
        self.fixture = Fixture(root, {'candidate': lambda files: files.__setitem__(
            'api/fixture.txt', ('file', 0o644, b'UNKNOWN 13TH DIFFERENCE'))})
        self.reject('unreviewed_archive_difference')

    def test_archive_timestamp_normalization_cannot_change_other_fields(self):
        root = Path(self.temporary.name) / 'other-agents'
        self.fixture = Fixture(root, {'candidate': lambda files: files.__setitem__(
            'api/node_modules/.modules.yaml', ('file', 0o644, canonical({'prunedAt': 2, 'modules': ['FOREIGN']})))})
        self.reject('packaging_only_timestamp')

    def test_archive_wrapper_requires_six_exact_staging_prefixes(self):
        root = Path(self.temporary.name) / 'other-agents'
        name = 'api/node_modules/.pnpm/node_modules/.bin/pino'
        def mutate(files):
            kind, mode, raw = files[name]
            files[name] = (kind, mode, raw + b'UNREVIEWED EXTRA')
        self.fixture = Fixture(root, {'candidate': mutate})
        self.reject('packaging_wrapper')

    def test_compiled_producer_cannot_be_normalized(self):
        root = Path(self.temporary.name) / 'other-agents'
        name = 'api/' + PACKAGE + 'dist/modules/content/production/roles.js'
        self.fixture = Fixture(root, {'producer': lambda files: files.__setitem__(
            name, ('file', 0o644, b'DIFFERENT ACCEPTED PRODUCER'))})
        self.reject('producer_compiled_body')

    def test_archive_hardlink_escape(self):
        root = Path(self.temporary.name) / 'other-agents'
        self.fixture = Fixture(root, {'candidate': lambda files: files.__setitem__(
            'api/fixture-hardlink.txt', ('hard', 0o644, b'../outside'))})
        self.reject('path')

    def test_later_feature_cannot_change_current_producer_code(self):
        self.fixture = Fixture(Path(self.temporary.name) / 'other-agents', producer_drift=True)
        self.reject('producer_body_drift')

    def test_postflight_receipt_requires_pinned_actual_hash(self):
        self.fixture.receipt['postflight'] = self.fixture.logs['candidate-logs']
        self.reject('postflight_receipt')

    def test_missing_required_job(self):
        self.fixture.receipt['candidateCI']['jobs'].pop()
        self.reject('sequence_bound')

    def test_evidence_parent_symlink(self):
        directory = self.fixture.root / 'evidence'
        replacement = self.fixture.root / 'renamed-evidence'
        directory.rename(replacement)
        directory.symlink_to(replacement, target_is_directory=True)
        self.reject('symlink_ancestor')

    def test_evidence_path_depth_bound(self):
        self.fixture.receipt['evidence'][0]['path'] = '/'.join(['x'] * 33)
        self.reject('path')

    def test_receipt_size_bound_before_json_parse(self):
        self.fixture.seal()
        target = self.fixture.root / self.fixture.proof['receipt']['path']
        with target.open('ab') as stream:
            stream.truncate(32 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(Refused, 'file_metadata'):
            self.fixture.validator()(self.fixture.config)

    def test_archive_hardlink_cycle(self):
        root = Path(self.temporary.name) / 'other-agents'
        def mutate(files):
            files['api/fixture-hardlink.txt'] = ('hard', 0o644, b'api/fixture-hardlink2.txt')
            files['api/fixture-hardlink2.txt'] = ('hard', 0o644, b'api/fixture-hardlink.txt')
        self.fixture = Fixture(root, {'candidate': mutate})
        self.reject('archive_hardlink_cycle')

    def test_archive_symlink_escape(self):
        root = Path(self.temporary.name) / 'other-agents'
        self.fixture = Fixture(root, {'candidate': lambda files: files.__setitem__(
            'api/fixture-symlink', ('link', 0o777, b'../../outside'))})
        self.reject('archive_symlink_target')

    def test_candidate_complete_body_map_cannot_omit_unchanged_file(self):
        self.fixture.receipt['candidateFiles'] = [entry for entry in self.fixture.receipt['candidateFiles']
                                                   if entry['path'] != 'untouched.txt']
        self.reject('candidate_tree')

    def test_declared_step_tree_must_be_reconstructed(self):
        self.fixture.receipt['steps'][1]['tree'] = oid('WRONG TREE')
        self.reject('step_tree')

    def test_frozen_inputs_and_derivative_inverse(self):
        raw = (HERE / 'launch-v12.proposed.py').read_bytes()
        begin = raw.index(b'    # BEGIN V3:')
        end_marker = b'    # END V3: the following original v2 branch is preserved literally.\n'
        end = raw.index(end_marker) + len(end_marker)
        self.assertEqual(sha(raw[:begin] + raw[end:]), INPUTS['parentLauncherSha256'])
        self.assertEqual(sha(raw), INPUTS['derivativeLauncherSha256'])
        parsed = ast.parse(raw)
        values = {node.targets[0].id: ast.literal_eval(node.value) for node in parsed.body
                  if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                  and node.targets[0].id in INPUTS['disabledPins']}
        self.assertEqual(values, INPUTS['disabledPins'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
