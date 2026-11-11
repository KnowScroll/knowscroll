import { describe, expect, it, vi } from 'vitest';
import type { CoverageHead, CoverageRead } from '../../content/public.js';
import { recordingCoverageKey, type ObservedCoverage, type RecordingCoverageWitness } from '../../evidence/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { CoverageDependencies } from '../application/coverage-ports.js';
import { binding, certificate, digestOnlyHead, hash, head, secondBinding } from '../domain/coverage.fixture.js';
import { fenceCoverage, fenceRecordingCoverage } from './coverage-store.js';

const scope = {} as PersonalScopeTx;
const mapped = (h: CoverageHead): CoverageRead => ({ kind: 'mapped', head: h });
const witnessOf = (c: ObservedCoverage): RecordingCoverageWitness => ({
  version: 'recording-coverage.v1',
  sourceKind: 'segment',
  recordingGeneration: 1,
  activityId: '60000000-0000-4000-8000-000000000001',
  qualificationId: c.evidence!.id,
  certificateSha256: hash('e'),
  certificate: c,
});

/**
 * Fake Content and Evidence ports. `reads` are returned in order (the last repeats), so a test can
 * move the head between the read before the lock and the re-read after the lock wait.
 */
function ports(reads: readonly CoverageRead[], options: { lock?: boolean; evidence?: boolean } = {}) {
  const calls: string[] = [];
  let read = 0;
  const lockAuthorities = vi.fn((_scope: PersonalScopeTx, _expected: unknown) => {
    calls.push('lock');
    return Promise.resolve(options.lock ?? true);
  });
  const readMapping = vi.fn(() => {
    calls.push('read');
    return Promise.resolve(reads[Math.min(read++, reads.length - 1)]!);
  });
  const included = options.evidence ?? true;
  const dependencies: CoverageDependencies = {
    readMapping,
    lockAuthorities,
    checkEvidence: (_scope, input) => {
      calls.push('evidence');
      return Promise.resolve(included ? input.map((c) => c.exposureId) : []);
    },
    checkRecordingEvidence: (_scope, input) => {
      calls.push('evidence');
      return Promise.resolve(included ? input.map(recordingCoverageKey) : []);
    },
  };
  return { dependencies, calls, lockAuthorities };
}

describe.each([
  ['fenceCoverage', (c: ObservedCoverage, p: CoverageDependencies) => fenceCoverage(scope, c, p)],
  [
    'fenceRecordingCoverage',
    (c: ObservedCoverage, p: CoverageDependencies) => fenceRecordingCoverage(scope, witnessOf(c), p),
  ],
])('%s', (_name, fence) => {
  const changed = 'PERSONAL_COVERAGE_AUTHORITY_CHANGED';

  it('accepts a certificate issued on an older head and locks the current head, not the one it names', async () => {
    const current = digestOnlyHead(2);
    const { dependencies, calls, lockAuthorities } = ports([mapped(current)]);
    await expect(fence(certificate(), dependencies)).resolves.toBeUndefined();
    expect(lockAuthorities).toHaveBeenCalledTimes(1);
    expect(lockAuthorities).toHaveBeenCalledWith(scope, [current.authority]);
    // Read, lock the head that was read, then read again and check Evidence under the held lock.
    expect(calls).toEqual(['read', 'lock', 'read', 'evidence']);
  });

  it('accepts a certificate on the current head', async () => {
    const { dependencies, lockAuthorities } = ports([mapped(head())]);
    await expect(fence(certificate(), dependencies)).resolves.toBeUndefined();
    expect(lockAuthorities).toHaveBeenCalledWith(scope, [head().authority]);
  });

  it('refuses a retracted head without locking anything', async () => {
    const retracted: CoverageRead = { kind: 'retracted', authority: head({ headRevision: 2 }).authority };
    const { dependencies, lockAuthorities } = ports([retracted]);
    await expect(fence(certificate(), dependencies)).rejects.toThrow(changed);
    expect(lockAuthorities).not.toHaveBeenCalled();
  });

  it.each<[string, CoverageRead]>([
    ['unmapped', { kind: 'unmapped' }],
    ['unavailable', { kind: 'unavailable' }],
  ])('refuses an asset revision that is %s', async (_kind, read) => {
    const { dependencies, lockAuthorities } = ports([read]);
    await expect(fence(certificate(), dependencies)).rejects.toThrow(changed);
    expect(lockAuthorities).not.toHaveBeenCalled();
  });

  it('refuses a head that corrected the claimed bindings, without locking anything', async () => {
    const corrected = head({ headRevision: 2, mappingSha256: hash('9'), mapping: { bindings: [secondBinding] } });
    const { dependencies, lockAuthorities } = ports([mapped(corrected)]);
    await expect(fence(certificate(), dependencies)).rejects.toThrow(changed);
    expect(lockAuthorities).not.toHaveBeenCalled();
  });

  it('refuses when the current head cannot be locked', async () => {
    const { dependencies } = ports([mapped(digestOnlyHead())], { lock: false });
    await expect(fence(certificate(), dependencies)).rejects.toThrow(changed);
  });

  it('detects a digest-only correction that lands while the lock is awaited', async () => {
    const { dependencies } = ports([mapped(digestOnlyHead(2)), mapped(digestOnlyHead(3))]);
    await expect(fence(certificate(), dependencies)).rejects.toThrow(changed);
  });

  it('detects a retraction that lands while the lock is awaited', async () => {
    const retracted: CoverageRead = { kind: 'retracted', authority: head({ headRevision: 3 }).authority };
    const { dependencies } = ports([mapped(digestOnlyHead(2)), retracted]);
    await expect(fence(certificate(), dependencies)).rejects.toThrow(changed);
  });

  it('detects a correction of the bindings that lands while the lock is awaited', async () => {
    const corrected = head({ headRevision: 3, mappingSha256: hash('9'), mapping: { bindings: [secondBinding] } });
    const { dependencies } = ports([mapped(digestOnlyHead(2)), mapped(corrected)]);
    await expect(fence(certificate(), dependencies)).rejects.toThrow(changed);
  });

  it('refuses when Evidence no longer vouches for the reading', async () => {
    const { dependencies, lockAuthorities } = ports([mapped(digestOnlyHead())], { evidence: false });
    await expect(fence(certificate(), dependencies)).rejects.toThrow(changed);
    expect(lockAuthorities).toHaveBeenCalledTimes(1);
  });

  it('keeps a certificate whose bindings all remain when the head gained another', async () => {
    const wider = head({ headRevision: 2, mappingSha256: hash('9'), mapping: { bindings: [binding, secondBinding] } });
    const { dependencies } = ports([mapped(wider)]);
    await expect(fence(certificate(), dependencies)).resolves.toBeUndefined();
  });
});

describe('fenceCoverage with a certificate that proves nothing', () => {
  it('does nothing and locks nothing', async () => {
    const { dependencies, lockAuthorities, calls } = ports([mapped(head())]);
    await fenceCoverage(scope, { ...certificate(), availability: 'unavailable', mapping: null }, dependencies);
    expect(lockAuthorities).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('fenceRecordingCoverage with a certificate that proves nothing', () => {
  it('refuses it', async () => {
    const { dependencies, lockAuthorities } = ports([mapped(head())]);
    await expect(
      fenceRecordingCoverage(
        scope,
        witnessOf({ ...certificate(), availability: 'unavailable', mapping: null }),
        dependencies,
      ),
    ).rejects.toThrow('PERSONAL_COVERAGE_AUTHORITY_CHANGED');
    expect(lockAuthorities).not.toHaveBeenCalled();
  });
});
