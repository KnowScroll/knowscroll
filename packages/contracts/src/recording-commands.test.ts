import { describe, expect, it } from 'vitest';
import {
  ActivateExposureRequestSchema,
  ActivateOfferRequestSchema,
  ApplyActionRequestSchema,
  DirectActivateExposureRequestSchema,
  DirectOpenExposureRequestSchema,
  NavigateExperienceRequestSchema,
  OpenDiscoveryRequestSchema,
  OpenExposureRequestSchema,
  OpenRevisitRequestSchema,
  RecordingGenerationSchema,
  RegionEncounterOpenRequestSchema,
  RegionEncounterProblemIssueSchema,
  RegionEncounterProblemSchema,
  RemoveKeepEntrySchema,
  KeepRemovalAcceptanceSchema,
  KeepRemovalProblemIssueSchema,
  SetKeepPlaceSchema,
  ReadKeepEntrySchema,
  problemDetails,
} from './index.js';

// Synthetic wire fixtures only; no current recording policy, authority, action or encounter.
const id = (n: number) => `0199f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const capabilities = { documentSchemas: ['scroll-document.v1'], blocks: { fallback: [1] } };
const action = { commandId: id(1), kind: 'save', target: { assetId: id(2), assetRevision: 1 }, exposureId: id(3) };
const directActivation = { commandId: id(1), exposureId: id(3) };
const keepRemoval = {
  version: 'keep-remove.v1',
  commandId: id(1),
  entry: { assetId: id(2), assetRevision: 1, savedEntryId: id(7) },
};
const offerActivation = {
  commandId: id(1),
  target: { kind: 'offer', sessionId: id(4), offerId: id(5), expectedIntentRevision: 0 },
};
const discovery = { commandId: id(1), target: { kind: 'discover' }, capabilities };
const revisit = { commandId: id(1), target: { kind: 'return', assetId: id(2), assetRevision: 1 }, capabilities };
const navigation = {
  commandId: id(1),
  sessionId: id(4),
  expectedIntentRevision: 0,
  from: { offerId: id(5), exposureId: id(3) },
  intent: { mode: 'related' },
};
const region = {
  version: 'region-encounter-open.v1',
  commandId: id(1),
  target: { kind: 'region', regionId: id(6), expectedObjectRevision: 2, expectedGeographyRevision: 3 },
  capabilities,
};
const directOpen = {
  commandId: id(1),
  target: { kind: 'scroll', assetId: id(2) },
  origin: { kind: 'direct' },
  capabilities,
};
const commands = [
  ['ApplyAction', ApplyActionRequestSchema, action],
  ['DirectActivate', DirectActivateExposureRequestSchema, directActivation],
  ['ActivateOffer', ActivateOfferRequestSchema, offerActivation],
  ['OpenDiscovery', OpenDiscoveryRequestSchema, discovery],
  ['OpenRevisit', OpenRevisitRequestSchema, revisit],
  ['Navigate', NavigateExperienceRequestSchema, navigation],
  ['RegionEncounterOpen', RegionEncounterOpenRequestSchema, region],
  ['RemoveKeepEntry', RemoveKeepEntrySchema, keepRemoval],
] as const;
const invalidGenerations = [0, -1, 2_147_483_648, 1.5, '1', null, undefined, true, {}, [], NaN, Infinity];

describe('recording-generation command prerequisite381 (synthetic declarations only)', () => {
  for (const [name, schema, original] of commands) {
    it(`${name} preserves the exact omitted legacy body without adding a current-generation default`, () => {
      const parsed = schema.parse(original);
      expect(parsed).toEqual(original);
      expect(parsed).not.toHaveProperty('recordingGeneration');
      expect(Object.hasOwn(original, 'recordingGeneration')).toBe(false);
      expect(schema.shape.recordingGeneration.unwrap()).toBe(RecordingGenerationSchema);
    });

    it(`${name} retains valid supplied generations, including even/off and the exact counter maximum`, () => {
      for (const recordingGeneration of [1, 2, 3, 2_147_483_646, 2_147_483_647]) {
        const command = { ...original, recordingGeneration };
        const parsed = schema.parse(command);
        expect(parsed).toEqual(command);
        expect(parsed).toHaveProperty('recordingGeneration', recordingGeneration);
      }
    });

    it(`${name} refuses every malformed supplied generation rather than stripping it into absence`, () => {
      for (const recordingGeneration of invalidGenerations) {
        const command = { ...original, recordingGeneration };
        expect(Object.hasOwn(command, 'recordingGeneration')).toBe(true);
        expect(schema.safeParse(command).success).toBe(false);
      }
    });
  }

  it('keeps unrelated unknown-field stripping on necessary legacy action/activation bodies', () => {
    for (const recordingGeneration of [undefined, 1, 2, 2_147_483_647]) {
      const field = recordingGeneration === undefined ? {} : { recordingGeneration };
      for (const [schema, original] of [
        [ApplyActionRequestSchema, action],
        [DirectActivateExposureRequestSchema, directActivation],
      ] as const) {
        expect(schema.parse({ ...original, ...field, futureLegacyField: 'ignored' })).toEqual({
          ...original,
          ...field,
        });
      }
    }
    expect(DirectOpenExposureRequestSchema.parse({ ...directOpen, futureLegacyField: 'ignored' })).toEqual(directOpen);
    expect(OpenExposureRequestSchema.parse({ ...directOpen, futureLegacyField: 'ignored' })).toEqual(directOpen);
  });

  it('keeps new command branches strict apart from the expressly reserved optional field', () => {
    for (const [schema, original] of [
      [ActivateOfferRequestSchema, offerActivation],
      [OpenDiscoveryRequestSchema, discovery],
      [OpenRevisitRequestSchema, revisit],
      [NavigateExperienceRequestSchema, navigation],
      [RegionEncounterOpenRequestSchema, region],
      [RemoveKeepEntrySchema, keepRemoval],
    ] as const)
      expect(schema.safeParse({ ...original, recordingGeneration: 3, futureLegacyField: true }).success).toBe(false);
  });

  it('retains optional fields in the actual activation/open unions without a malformed-generation fallback', () => {
    for (const [schema, original] of [
      [ActivateExposureRequestSchema, directActivation],
      [ActivateExposureRequestSchema, offerActivation],
      [OpenExposureRequestSchema, discovery],
      [OpenExposureRequestSchema, revisit],
    ] as const) {
      expect(schema.parse(original)).toEqual(original);
      for (const recordingGeneration of [1, 2, 2_147_483_647])
        expect(schema.parse({ ...original, recordingGeneration })).toEqual({ ...original, recordingGeneration });
      for (const recordingGeneration of invalidGenerations)
        expect(schema.safeParse({ ...original, recordingGeneration }).success).toBe(false);
    }
  });

  it('keeps Saved removal membership-bound and its immutable acknowledgement free of current policy', () => {
    const accepted = {
      ...keepRemoval,
      scope: { accountId: id(8), privacyEpoch: 1 },
      recordedAt: '2026-10-22T20:00:00Z',
      replayed: false,
      outcome: 'accepted',
      operation: 'keep.entry.remove',
    };
    expect(KeepRemovalAcceptanceSchema.parse(accepted)).toEqual(accepted);
    for (const recordingGeneration of [1, 2, 3, undefined]) {
      expect(KeepRemovalAcceptanceSchema.safeParse({ ...accepted, recordingGeneration }).success).toBe(false);
      expect(
        RemoveKeepEntrySchema.safeParse({ ...keepRemoval, recordingGeneration, entry: action.target }).success,
      ).toBe(false);
      expect(RemoveKeepEntrySchema.safeParse({ ...keepRemoval, recordingGeneration, exposureId: id(3) }).success).toBe(
        false,
      );
    }
    const replacement = {
      ...keepRemoval,
      recordingGeneration: 3,
      entry: { ...keepRemoval.entry, savedEntryId: id(9) },
    };
    expect(RemoveKeepEntrySchema.parse(replacement)).toEqual(replacement);
    expect(replacement.entry).not.toEqual(keepRemoval.entry);
    expect(KeepRemovalAcceptanceSchema.parse({ ...accepted, replayed: true })).toEqual({ ...accepted, replayed: true });
  });

  it('does not add recording authority to Keep reads or position-only writes', () => {
    const read = { version: 'keep-place.v1', target: action.target };
    const place = {
      version: 'keep-place.v1',
      commandId: id(1),
      entry: keepRemoval.entry,
      expectedPlaceRevision: 0,
      position: { kind: 'reel', positionMs: 12 },
    };
    expect(ReadKeepEntrySchema.parse(read)).toEqual(read);
    expect(SetKeepPlaceSchema.parse(place)).toEqual(place);
    for (const recordingGeneration of [1, 2, 3, undefined]) {
      expect(ReadKeepEntrySchema.safeParse({ ...read, recordingGeneration }).success).toBe(false);
      expect(SetKeepPlaceSchema.safeParse({ ...place, recordingGeneration }).success).toBe(false);
    }
  });

  it('forbids the reserved field on nonevidence direct open, including own undefined and mixed union bodies', () => {
    for (const recordingGeneration of [1, 2, 2_147_483_647, ...invalidGenerations]) {
      const body = { ...directOpen, recordingGeneration };
      expect(Object.hasOwn(body, 'recordingGeneration')).toBe(true);
      expect(DirectOpenExposureRequestSchema.safeParse(body).success).toBe(false);
      expect(OpenExposureRequestSchema.safeParse(body).success).toBe(false);
      expect(
        OpenExposureRequestSchema.safeParse({ ...body, session: { sessionId: id(4), expectedIntentRevision: 0 } })
          .success,
      ).toBe(false);
    }
    expect(OpenExposureRequestSchema.parse(directOpen)).toEqual(directOpen);
  });

  it('does not turn a reserved generation into permission for wrong original or mixed command branches', () => {
    const malformed = [
      [ApplyActionRequestSchema, { ...action, kind: 'return' }],
      [DirectActivateExposureRequestSchema, { ...directActivation, target: offerActivation.target }],
      [ActivateOfferRequestSchema, { ...offerActivation, target: { kind: 'direct', exposureId: id(3) } }],
      [OpenDiscoveryRequestSchema, { ...discovery, target: revisit.target }],
      [OpenRevisitRequestSchema, { ...revisit, target: discovery.target }],
      [NavigateExperienceRequestSchema, { ...navigation, intent: { mode: 'pause' } }],
      [RegionEncounterOpenRequestSchema, { ...region, target: { ...region.target, kind: 'scroll' } }],
      [RemoveKeepEntrySchema, { ...keepRemoval, entry: action.target }],
      [ActivateExposureRequestSchema, { ...offerActivation, exposureId: id(3) }],
      [
        OpenExposureRequestSchema,
        { ...discovery, target: { ...discovery.target, assetId: id(2) }, origin: directOpen.origin },
      ],
      [OpenExposureRequestSchema, { ...revisit, target: { kind: 'return', assetId: id(2) } }],
    ] as const;
    for (const [schema, body] of malformed)
      for (const recordingGeneration of [1, 2, undefined, 0, '3'])
        expect(schema.safeParse({ ...body, recordingGeneration }).success).toBe(false);
  });

  it('allows only the added static region problem token, with no rejected value or dynamic path disclosure', () => {
    const issue = { path: ['recordingGeneration'], code: 'custom' };
    expect(RegionEncounterProblemIssueSchema.parse(issue)).toEqual(issue);
    expect(KeepRemovalProblemIssueSchema.parse(issue)).toEqual(issue);
    const problem = { ...problemDetails('INVALID_REQUEST'), issues: [issue] };
    expect(RegionEncounterProblemSchema.parse(problem)).toEqual(problem);
    for (const path of [
      ['recordingGeneration', 0],
      ['recordingGeneration', 'private-key'],
      ['recordingGeneration', '0'],
    ])
      expect(RegionEncounterProblemIssueSchema.safeParse({ ...issue, path }).success).toBe(false);
    for (const path of [
      ['recordingGeneration', 0],
      ['recordingGeneration', 'private-key'],
      ['recordingGeneration', '0'],
    ])
      expect(KeepRemovalProblemIssueSchema.safeParse({ ...issue, path }).success).toBe(false);
    expect(RegionEncounterProblemIssueSchema.safeParse({ ...issue, received: 'private' }).success).toBe(false);
    expect(KeepRemovalProblemIssueSchema.safeParse({ ...issue, received: 'private' }).success).toBe(false);
  });
});
