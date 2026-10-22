import { describe, expect, it } from 'vitest';
import {
  FORMATION_PRESENTATION_POLICY,
  FormationPresentationFactSchema,
  ReadFormationPresentationSchema,
  FormationPresentationReadSchema,
  ClaimFormationPresentationSchema,
  FormationPresentationClaimAcceptanceSchema,
  AcknowledgeFormationPresentationSchema,
  FormationPresentationAcknowledgementSchema,
  FormationPresentationProblemSchema,
  FormationPresentationProblemIssueSchema,
  apiContract,
  problemDetails,
} from './index.js';

// Authored wire syntax only; no real formation, claim, display, or learning evidence.
const id = (n: number) => `0199f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const version = 'formation-presentation.v1';
const time = (seconds: number) => new Date(Date.UTC(2026, 9, 22) + seconds * 1000).toISOString();
const capabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};
const geography = { revision: 3, structureRevision: 3, activityRevision: 0 };
const object = (n: number, kind: 'system' | 'star' | 'planet' | 'region', parent: number) => ({
  objectId: id(n),
  parentId: id(parent),
  kind,
  objectRevision: 3,
  label: 'Wire fixture',
  truthStatus: 'factual',
});
const fact = {
  transitionId: id(1),
  recordedAt: time(0),
  geography,
  targets: [object(2, 'system', 9), object(3, 'star', 2), object(4, 'planet', 2)],
  sequence: { kind: 'planet', planetId: id(4), newSystem: { systemId: id(2), starId: id(3) }, durationMs: 2400 },
};
const read = { version, readId: id(10), target: { kind: 'next' }, capabilities };
const scope = { universeId: id(9), privacyEpoch: 1, personalWatermark: 6 };
const snapshot = {
  ...read,
  scope,
  recordedAt: time(1),
  currentGeography: geography,
  sceneRevision: 2,
  status: 'available',
  fact,
  eligibility: { status: 'claimable', until: time(300) },
};
const claim = { version, commandId: id(11), transitionId: id(1), attemptNonce: id(12) };
const receipt = {
  commandId: id(11),
  transitionId: id(1),
  attemptNonce: id(12),
  recordedAt: time(2),
  outcome: 'claimed',
  claim: { claimId: id(13), claimedAt: time(2), expiresAt: time(32) },
};
const accepted = {
  version,
  scope,
  receipt,
  replayed: false,
  current: { status: 'active', observedAt: time(2), claimId: id(13), expiresAt: time(32) },
};
const ack = {
  version,
  commandId: id(14),
  transitionId: id(1),
  claimId: id(13),
  attemptNonce: id(12),
  disposition: 'shown',
};
const acknowledgement = {
  ...ack,
  scope,
  recordedAt: time(5),
  replayed: false,
  requestedDisposition: 'shown',
  outcome: 'recorded',
};

describe('U05 committed formation presentation declaration', () => {
  it('freezes bounded delivery policy and separate read, claim and terminal routes', () => {
    expect(FORMATION_PRESENTATION_POLICY).toEqual({
      version,
      freshnessSeconds: 300,
      claimSeconds: 30,
      fullDurationMs: 2400,
      maxTargets: 8,
    });
    for (const [operation, path] of [
      ['read', 'read'],
      ['claim', 'claim'],
      ['acknowledge', 'acknowledge'],
    ] as const)
      expect(apiContract.formation[operation]['~orpc'].route).toMatchObject({
        method: 'POST',
        path: `/v1/universe/formation/${path}`,
        successStatus: 200,
      });
    expect(ReadFormationPresentationSchema.parse(JSON.parse(JSON.stringify(read)))).toEqual(read);
    expect(FormationPresentationReadSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(ClaimFormationPresentationSchema.parse(claim)).toEqual(claim);
    expect(FormationPresentationClaimAcceptanceSchema.parse(accepted)).toEqual(accepted);
    expect(AcknowledgeFormationPresentationSchema.parse(ack)).toEqual(ack);
    expect(FormationPresentationAcknowledgementSchema.parse(acknowledgement)).toEqual(acknowledgement);
  });

  it('allows existing-system planets and truthful final-only creation facts without inventing beats', () => {
    expect(
      FormationPresentationFactSchema.parse({
        ...fact,
        targets: [object(4, 'planet', 2)],
        sequence: { kind: 'planet', planetId: id(4), durationMs: 2400 },
      }).targets,
    ).toHaveLength(1);
    for (const targets of [[object(2, 'system', 9)], [object(5, 'region', 4)]])
      expect(
        FormationPresentationFactSchema.parse({ ...fact, targets, sequence: { kind: 'final_still' } }).sequence,
      ).toEqual({ kind: 'final_still' });
    const hypothetical = { ...fact, targets: fact.targets.map((t) => ({ ...t, truthStatus: 'hypothetical' })) };
    expect(FormationPresentationFactSchema.parse(hypothetical)).toEqual(hypothetical);
    const bounded = {
      ...fact,
      targets: Array.from({ length: 8 }, (_, n) => object(20 + n, 'region', 99)),
      sequence: { kind: 'final_still' },
    };
    expect(FormationPresentationFactSchema.parse(bounded).targets).toHaveLength(8);
    expect(
      FormationPresentationFactSchema.safeParse({ ...bounded, targets: [...bounded.targets, object(29, 'region', 99)] })
        .success,
    ).toBe(false);
    for (const invalid of [
      { ...fact, targets: [] },
      { ...fact, targets: Array(9).fill(object(4, 'planet', 2)) },
      { ...fact, targets: [object(4, 'planet', 2), object(4, 'planet', 2)] },
      { ...fact, targets: [object(3, 'star', 2)] },
      { ...fact, targets: [object(2, 'system', 9), object(4, 'planet', 2)] },
      { ...fact, targets: [object(2, 'system', 9), object(3, 'star', 99), object(4, 'planet', 2)] },
      { ...fact, targets: fact.targets.map((t) => (t.kind === 'planet' ? { ...t, truthStatus: 'hypothetical' } : t)) },
      { ...fact, targets: fact.targets.map((t) => ({ ...t, objectRevision: 2 })) },
      { ...fact, targets: fact.targets.map((t) => ({ ...t, parentId: t.objectId })) },
      { ...fact, sequence: { ...fact.sequence, durationMs: 2401 } },
      { ...fact, sequence: { ...fact.sequence, planetId: id(3) } },
      { ...fact, geography: { ...geography, structureRevision: 2 } },
    ])
      expect(FormationPresentationFactSchema.safeParse(invalid).success).toBe(false);
  });

  it('binds exact read selection/current scope/projection stamps and fixed freshness without effects', () => {
    const { fact: _fact, eligibility: _eligibility, ...base } = snapshot;
    for (const value of [
      { ...base, status: 'none' },
      { ...base, status: 'unavailable', reason: 'projection_pending' },
      { ...base, status: 'unsupported_version', capabilities: { ...capabilities, generators: [] } },
      { ...snapshot, target: { kind: 'transition', transitionId: id(1) } },
      { ...snapshot, recordedAt: time(500), eligibility: { status: 'final', reason: 'late' } },
      { ...snapshot, eligibility: { status: 'final', reason: 'already_claimed' } },
      { ...snapshot, capabilities: { ...capabilities, reducedMotion: true, detail: 'low' } },
    ])
      expect(FormationPresentationReadSchema.parse(value)).toEqual(value);
    for (const value of [
      { ...snapshot, target: { kind: 'transition', transitionId: id(99) } },
      { ...base, status: 'none', target: { kind: 'transition', transitionId: id(1) } },
      { ...snapshot, scope: { ...scope, universeId: id(99) } },
      { ...snapshot, recordedAt: time(300) },
      { ...snapshot, recordedAt: time(-1) },
      { ...snapshot, eligibility: { status: 'claimable', until: time(301) } },
      { ...snapshot, sceneRevision: 0 },
      { ...snapshot, currentGeography: { revision: 2, structureRevision: 2, activityRevision: 0 } },
      { ...snapshot, capabilities: { ...capabilities, generators: [] } },
      { ...base, status: 'unsupported_version' },
      { ...base, status: 'none', offers: [] },
      { ...snapshot, exposureId: id(99) },
    ])
      expect(FormationPresentationReadSchema.safeParse(value).success).toBe(false);
  });

  it('separates unchanged historical claim receipt from current eligibility after lost acknowledgement/expiry', () => {
    const retry = { ...accepted, replayed: true };
    expect(FormationPresentationClaimAcceptanceSchema.parse(retry).receipt).toEqual(receipt);
    // Original exact body remains retryable. An old claimed receipt after expiry is final,
    // never a renewed claim/animation; a second device receives no competing claim identity.
    const expired = { ...retry, current: { status: 'final', observedAt: time(32), reason: 'expired' } };
    expect(FormationPresentationClaimAcceptanceSchema.parse(expired).receipt).toEqual(receipt);
    for (const reason of ['already_claimed', 'terminal', 'expired', 'unavailable']) {
      const value = {
        ...accepted,
        receipt: { ...claim, version: undefined, recordedAt: time(3), outcome: 'not_claimed', reason },
        current: { status: 'final', observedAt: time(3), reason: 'not_claimed' },
      };
      // Strict receipt contains no version (even an undefined unknown key is forbidden).
      const { version: _version, ...historical } = value.receipt;
      expect(FormationPresentationClaimAcceptanceSchema.parse({ ...value, receipt: historical }).receipt).toEqual(
        historical,
      );
    }
    for (const value of [
      { ...accepted, current: { status: 'final', observedAt: time(2), reason: 'expired' } },
      { ...accepted, current: { status: 'final', observedAt: time(2), reason: 'not_claimed' } },
      { ...accepted, current: { ...accepted.current, observedAt: time(32) } },
      { ...accepted, current: { ...accepted.current, observedAt: time(1) } },
      { ...accepted, current: { ...accepted.current, claimId: id(99) } },
      { ...accepted, current: { ...accepted.current, expiresAt: time(33) } },
      { ...accepted, receipt: { ...receipt, claim: { ...receipt.claim, expiresAt: time(33) } } },
      { ...accepted, receipt: { ...receipt, recordedAt: time(3) } },
      { ...accepted, current: { ...accepted.current, learned: true } },
      {
        ...accepted,
        receipt: {
          commandId: id(11),
          transitionId: id(1),
          attemptNonce: id(12),
          recordedAt: time(2),
          outcome: 'not_claimed',
          reason: 'already_claimed',
        },
      },
    ])
      expect(FormationPresentationClaimAcceptanceSchema.safeParse(value).success).toBe(false);
  });

  it('retains actual terminal disposition on delayed shown and does not claim that a claim was shown', () => {
    for (const disposition of ['shown', 'skipped']) {
      expect(AcknowledgeFormationPresentationSchema.parse({ ...ack, disposition }).disposition).toBe(disposition);
      expect(
        FormationPresentationAcknowledgementSchema.parse({
          ...acknowledgement,
          disposition,
          requestedDisposition: disposition,
        }).disposition,
      ).toBe(disposition);
    }
    const delayed = { ...acknowledgement, outcome: 'already_terminal', disposition: 'skipped', replayed: true };
    expect(FormationPresentationAcknowledgementSchema.parse(delayed)).toEqual(delayed);
    expect(FormationPresentationAcknowledgementSchema.safeParse({ ...delayed, outcome: 'recorded' }).success).toBe(
      false,
    );
    for (const value of [
      { ...ack, disposition: 'claimed' },
      { ...ack, disposition: 'learned' },
      { ...ack, claimedAt: time(2) },
      { ...ack, durationMs: 2400 },
    ])
      expect(AcknowledgeFormationPresentationSchema.safeParse(value).success).toBe(false);
  });

  it('rejects caller authority/private camera/provider/proof fields throughout the new closed boundaries', () => {
    for (const [schema, value] of [
      [ReadFormationPresentationSchema, read],
      [ClaimFormationPresentationSchema, claim],
      [AcknowledgeFormationPresentationSchema, ack],
      [FormationPresentationReadSchema, snapshot],
      [FormationPresentationClaimAcceptanceSchema, accepted],
      [FormationPresentationAcknowledgementSchema, acknowledgement],
    ] as const)
      for (const key of [
        'accountId',
        'universeId',
        'privacyEpoch',
        'camera',
        'playheadMs',
        'sources',
        'evidence',
        'scores',
        'model',
        'learned',
        'shown',
        'expiresAt',
      ])
        expect(schema.safeParse({ ...value, [key]: true }).success).toBe(false);
    for (const key of ['supportRefs', 'geometry', 'seed', 'evidence', 'source', 'model']) {
      expect(FormationPresentationFactSchema.safeParse({ ...fact, [key]: true }).success).toBe(false);
      expect(
        FormationPresentationFactSchema.safeParse({
          ...fact,
          targets: [{ ...object(2, 'system', 9), [key]: true }],
          sequence: { kind: 'final_still' },
        }).success,
      ).toBe(false);
    }
    for (const value of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])
      expect(
        FormationPresentationReadSchema.safeParse({ ...snapshot, scope: { ...scope, privacyEpoch: value } }).success,
      ).toBe(false);
  });

  it('admits only direct static catalogue problems and masked schema-owned tokens', () => {
    for (const operation of Object.values(apiContract.formation))
      for (const code of Object.keys(
        operation['~orpc'].errorMap,
      ) as (keyof (typeof apiContract.formation.claim)['~orpc']['errorMap'])[]) {
        const problem = problemDetails(code);
        expect(FormationPresentationProblemSchema.parse(problem)).toEqual(problem);
        for (const patch of [
          { detail: 'PRIVATE' },
          { instance: id(1) },
          { transitionId: id(1) },
          { title: 'PRIVATE' },
          { status: 200 },
        ])
          expect(FormationPresentationProblemSchema.safeParse({ ...problem, ...patch }).success).toBe(false);
      }
    const issue = { path: ['capabilities', 'families', 'unknown'], code: 'invalid_type' };
    expect(FormationPresentationProblemIssueSchema.parse(issue)).toEqual(issue);
    for (const value of [
      { ...issue, path: ['PRIVATE'] },
      { ...issue, path: ['families', 4] },
      { ...issue, path: Array(9).fill('target') },
      { ...issue, message: 'PRIVATE' },
    ])
      expect(FormationPresentationProblemIssueSchema.safeParse(value).success).toBe(false);
    expect(
      FormationPresentationProblemSchema.safeParse({
        ...problemDetails('INVALID_REQUEST'),
        issues: Array(33).fill(issue),
      }).success,
    ).toBe(false);
    expect(FormationPresentationProblemSchema.safeParse(problemDetails('KEEP_ENTRY_UNAVAILABLE')).success).toBe(false);
  });
});
