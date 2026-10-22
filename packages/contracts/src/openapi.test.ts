import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { describe, expect, it } from 'vitest';
import {
  StartDirectConversationSchema,
  DirectConversationAcceptanceSchema,
  SendConversationMessageSchema,
  ConversationMessageAcceptanceSchema,
  ReadConversationChangesSchema,
  ConversationChangesPageSchema,
  ResolveContentShareSchema,
  ResolvedContentShareSchema,
  SocialProblemSchema,
  SocialProblemIssueSchema,
  CODE_CHALLENGE_PATTERN,
  CODE_VERIFIER_PATTERN,
  ProblemDetailsSchema,
  ClearExplorationSchema,
  ClearExplorationAcceptanceSchema,
  ReadClearExplorationStatusSchema,
  ClearExplorationStatusSchema,
  PrivacyProblemSchema,
  ReadKeepEntrySchema,
  SetKeepPlaceSchema,
  KeepEntrySnapshotSchema,
  KeepPlaceAcceptanceSchema,
  KeepPlaceProblemSchema,
  RemoveKeepEntrySchema,
  KeepRemovalAcceptanceSchema,
  KeepRemovalProblemSchema,
  RegionEncounterPreviewRequestSchema,
  RegionEncounterPreviewResponseSchema,
  ReadFormationPresentationSchema,
  FormationPresentationReadSchema,
  ClaimFormationPresentationSchema,
  FormationPresentationClaimAcceptanceSchema,
  AcknowledgeFormationPresentationSchema,
  FormationPresentationAcknowledgementSchema,
  FormationPresentationProblemSchema,
  RegionEncounterOpenRequestSchema,
  RegionEncounterOpenResponseSchema,
  RegionEncounterProblemSchema,
  apiContract,
  problemCatalogue,
  scopeClaimOf,
  sceneWireJsonSchemas,
  ReadRecordingPolicySchema,
  RecordingPolicyReadSchema,
  SetRecordingPolicySchema,
  RecordingPolicyAcceptanceSchema,
  RecordingPolicyReceiptSchema,
  RecordingPolicySchema,
  RecordingObservationBatchRequestSchema,
  RecordingObservationBatchResponseSchema,
  ReadFriendsPageSchema,
  ReadFriendRequestsPageSchema,
  FriendsPageSchema,
  FriendRequestsPageSchema,
} from './index.js';

// Supported converter interception keeps canonical scene metadata out of shared runtime imports.
function makeSchemaConverter(): ZodToJsonSchemaConverter {
  return new ZodToJsonSchemaConverter({
    interceptors: [
      (options) => {
        const scene = sceneWireJsonSchemas.find((entry) => entry.schema === options.schema);
        return scene ? [true, scene.jsonSchema] : options.next();
      },
    ],
  });
}

describe('the API contract', () => {
  it('generates an OpenAPI document with every route and the RFC 9457 problem schema', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: { ProblemDetails: { schema: ProblemDetailsSchema, strategy: 'output' } },
    });

    const routes = [
      apiContract.health,
      ...Object.values(apiContract.keep),
      ...Object.values(apiContract.privacy),
      ...Object.values(apiContract.recording),
      ...Object.values(apiContract.sharing),
      ...Object.values(apiContract.friendPages),
      ...Object.values(apiContract.conversations),
      ...Object.values(apiContract.contentShares),
      ...Object.values(apiContract.formation),
      apiContract.scenes.manifest,
      apiContract.scenes.chunk,
      apiContract.geography.read,
      apiContract.geography.deltas,
      apiContract.media.grant,
      apiContract.supply.create,
      apiContract.supply.read,
      apiContract.supply.cancel,
      apiContract.identity.requestSignIn,
      apiContract.identity.peekSignIn,
      apiContract.identity.redeemSignIn,
      apiContract.identity.session,
      apiContract.identity.signOut,
      apiContract.experience.applyAction,
      apiContract.experience.listSaved,
      apiContract.experience.openExposure,
      apiContract.experience.openRegionEncounter,
      apiContract.experience.previewRegionEncounter,
      apiContract.experience.navigate,
      apiContract.experience.activateExposure,
      apiContract.experience.exposureDocument,
      apiContract.experience.exposureContext,
      apiContract.observations.submit,
      apiContract.observations.submitRecording,
      apiContract.diagnostics.evidence,
    ].map((procedure) => procedure['~orpc'].route);
    for (const route of routes) {
      const method = (route.method ?? 'POST').toLowerCase() as 'get' | 'post';
      expect(
        document.paths?.[route.path ?? '']?.[method]?.responses?.[String(route.successStatus ?? 200)],
        `${route.method} ${route.path}`,
      ).toBeDefined();
    }
    expect(document.components?.schemas?.['ProblemDetails']).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['type', 'title', 'status', 'code']) as unknown,
    });
  });

  it('describes direct and Composer shapes through one open and one activate route', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, { info: { title: 'KnowScroll API', version: '1' } });
    const open = JSON.stringify(document.paths?.['/v1/experience/open']);
    const activate = JSON.stringify(document.paths?.['/v1/experience/activate']);
    const navigate = JSON.stringify(document.paths?.['/v1/experience/navigate']);
    const context = JSON.stringify(document.paths?.['/v1/experience/exposures/{exposureId}/context']);
    const action = JSON.stringify(document.paths?.['/v1/actions']);
    for (const field of [
      'discover',
      'return',
      'assetRevision',
      'capabilities',
      'expectedIntentRevision',
      'exposureId',
      'ready',
      'pending',
      'exhausted',
    ])
      expect(open).toContain(field);
    for (const field of ['offerId', 'sessionId', 'expectedIntentRevision', 'exposureId'])
      expect(activate).toContain(field);
    for (const mode of ['vertical', 'series', 'related', 'variant', 'return']) expect(navigate).toContain(mode);
    for (const field of ['expectedContinuation', 'linkId', 'assetId', 'assetRevision'])
      expect(navigate).toContain(field);
    for (const field of [
      'actions',
      'saved',
      'liked',
      'hidden',
      'sessionId',
      'intentRevision',
      'seriesPrevious',
      'seriesNext',
      'related',
      'requestId',
      'linkId',
    ])
      expect(context).toContain(field);
    expect(action).toContain('exposureId');
    for (const privateField of ['playheadMs', 'blockOffset', 'sources', 'provenance', 'score', 'peerPlayback']) {
      expect(open).not.toContain(`"${privateField}"`);
      expect(navigate).not.toContain(`"${privateField}"`);
      expect(context).not.toContain(`"${privateField}"`);
    }
    expect(context).not.toContain('totalParts');
  });

  it('declares private request commands separately from current status without granting encounter authority', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, { info: { title: 'KnowScroll API', version: '1' } });
    const create = document.paths?.['/v1/content/requests']?.post;
    const read = document.paths?.['/v1/content/requests/{requestId}']?.get;
    const cancel = document.paths?.['/v1/content/requests/cancel']?.post;
    expect(create?.responses?.['200']).toBeDefined();
    expect(read?.responses?.['200']).toBeDefined();
    expect(cancel?.responses?.['200']).toBeDefined();
    expect(read?.parameters).toContainEqual(expect.objectContaining({ name: 'requestId', in: 'path', required: true }));
    expect(read?.requestBody).toBeUndefined();
    const command = JSON.stringify(create?.requestBody);
    const acceptance = JSON.stringify(create?.responses?.['200']);
    const status = JSON.stringify(read?.responses?.['200']);
    const cancellation = JSON.stringify(cancel?.responses?.['200']);
    for (const field of ['commandId', 'topic', 'variant', 'assetRevision', 'capabilities'])
      expect(command).toContain(field);
    for (const field of ['accepted', 'recordedAt', 'privacyEpoch', 'replayed', 'requestId'])
      expect(acceptance).toContain(field);
    expect(acceptance).not.toContain('requestRevision');
    for (const field of ['preparing', 'ready', 'unavailable', 'cancelled', 'requestRevision'])
      expect(status).toContain(field);
    for (const field of ['cancelled', 'already_cancelled', 'already_closed']) expect(cancellation).toContain(field);
    for (const wire of [command, acceptance, status, cancellation])
      for (const field of [
        'ownerId',
        'provider',
        'prompt',
        'draftVersion',
        'sharingKey',
        'grantId',
        'exposureGrant',
        'score',
      ])
        expect(wire).not.toContain(`"${field}"`);
  });

  it('describes bounded read-only geography bodies without a cartography command or caller authority', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, { info: { title: 'KnowScroll API', version: '1' } });
    const snapshot = document.paths?.['/v1/universe/geography/read']?.post;
    const deltas = document.paths?.['/v1/universe/geography/deltas/read']?.post;
    expect(snapshot?.requestBody).toBeDefined();
    expect(deltas?.requestBody).toBeDefined();
    expect(snapshot?.responses?.['200']).toBeDefined();
    expect(deltas?.responses?.['200']).toBeDefined();
    const query = JSON.stringify(snapshot?.requestBody);
    const catchUp = JSON.stringify(deltas?.requestBody);
    for (const field of ['selection', 'limit', 'cursor', 'afterObjectId', 'geographyRevision'])
      expect(query).toContain(field);
    for (const field of ['afterGeographyRevision', 'limit']) expect(catchUp).toContain(field);
    for (const wire of [query, catchUp])
      for (const field of ['accountId', 'commandId', 'resumeRunId', 'desiredRevision', 'provider', 'prompt'])
        expect(wire).not.toContain(`"${field}"`);
    const result = JSON.stringify(snapshot?.responses?.['200']);
    for (const field of ['universeId', 'privacyEpoch', 'personalWatermark', 'geography', 'empty', 'loading', 'lagging'])
      expect(result).toContain(field);
    const changes = JSON.stringify(deltas?.responses?.['200']);
    for (const field of [
      'snapshot_required',
      'transitionId',
      'base',
      'structureRevision',
      'activityRevision',
      'hasMore',
    ])
      expect(changes).toContain(field);
    for (const wire of [result, changes])
      for (const field of ['observations', 'evidenceRefs', 'provider', 'prompt', 'draftVersion', 'score', 'seed'])
        expect(wire).not.toContain(`"${field}"`);
  });

  it('enumerates canonical scene descriptors and bounded own-scope reads through the supported converter', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, { info: { title: 'KnowScroll API', version: '1' } });
    const manifest = document.paths?.['/v1/universe/scenes/manifest/read']?.post;
    const chunk = document.paths?.['/v1/universe/scenes/chunks/read']?.post;
    for (const route of [manifest, chunk]) {
      expect(route?.requestBody).toBeDefined();
      expect(route?.responses?.['200']).toBeDefined();
      const input = JSON.stringify(route?.requestBody);
      for (const field of [
        'selection',
        'capabilities',
        'descriptors',
        'generators',
        'families',
        'reducedMotion',
        'detail',
      ])
        expect(input).toContain(field);
      for (const field of ['accountId', 'ownerId', 'commandId', 'shown', 'skipped', 'returnLocator'])
        expect(input).not.toContain(`"${field}"`);
    }
    const manifestWire = JSON.stringify(manifest?.responses?.['200']);
    for (const field of [
      'empty',
      'loading',
      'lagging',
      'ready',
      'unavailable',
      'unsupported_version',
      'pendingProjection',
      'scope',
      'privacyEpoch',
      'personalWatermark',
      'currentGeography',
      'scene-manifest.v1',
      'objectIds',
    ])
      expect(manifestWire).toContain(field);
    const chunkWire = JSON.stringify(chunk?.responses?.['200']);
    for (const field of [
      'stale_manifest',
      'unknown_chunk',
      'manifestSceneRevision',
      'chunkSceneRevision',
      'scene-chunk.v1',
      'scene-descriptor.v1',
      'silhouette.v1',
      'terraced.v1',
      'ridged.v1',
      'archipelago.v1',
      'anchor',
      'target',
      'originTransitionId',
      'truthStatus',
      'activity',
      'roughness',
      'density',
      'seed',
      'routes',
    ])
      expect(chunkWire).toContain(field);
    expect(chunkWire).not.toContain('"not":{}');
    for (const wire of [manifestWire, chunkWire])
      for (const field of ['evidenceRefs', 'score', 'sources', 'provider', 'prompt', 'assetUrl', 'svg', 'html'])
        expect(wire).not.toContain(`"${field}"`);
    const [, metadata] = makeSchemaConverter().convert(sceneWireJsonSchemas[0]!.schema, { strategy: 'output' });
    expect(metadata).toEqual(sceneWireJsonSchemas[0]!.jsonSchema);
    expect(metadata).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['schemaVersion', 'family', 'seed', 'anchor', 'target']) as unknown,
    });
  });

  it('declares exact Friends paths/methods and strict public projection and secret delivery shapes', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, { info: { title: 'KnowScroll API', version: '1' } });
    const expected = {
      '/v1/social/profile': ['get', 'post'],
      '/v1/social/people/lookup': ['post'],
      '/v1/social/pairs/read': ['post'],
      '/v1/social/friends/read': ['post'],
      '/v1/social/requests/read': ['post'],
      '/v1/social/friends/request': ['post'],
      '/v1/social/friends/accept': ['post'],
      '/v1/social/friends/decline': ['post'],
      '/v1/social/friends/cancel': ['post'],
      '/v1/social/friends/remove': ['post'],
      '/v1/social/friends/block': ['post'],
      '/v1/social/friends/unblock': ['post'],
      '/v1/social/invites/resolve': ['post'],
      '/v1/social/invites': ['get'],
      '/v1/social/invites/create': ['post'],
      '/v1/social/invites/revoke': ['post'],
      '/v1/social/visibility': ['get', 'post'],
      '/v1/social/presence/preference': ['get', 'post'],
      '/v1/social/visits/read': ['post'],
      '/v1/social/conversations/start': ['post'],
      '/v1/social/conversations/inbox': ['post'],
      '/v1/social/conversations/read': ['post'],
      '/v1/social/conversations/history': ['post'],
      '/v1/social/conversations/changes': ['post'],
      '/v1/social/conversations/send': ['post'],
      '/v1/social/conversations/mark-read': ['post'],
      '/v1/social/conversations/mute': ['post'],
      '/v1/social/conversations/leave': ['post'],
      '/v1/social/content-shares/create': ['post'],
      '/v1/social/content-shares/revoke': ['post'],
      '/v1/social/content-shares/read': ['post'],
      '/v1/social/content-shares/resolve': ['post'],
    };
    expect(
      Object.keys(document.paths ?? {})
        .filter((p) => p.startsWith('/v1/social/'))
        .sort(),
    ).toEqual(Object.keys(expected).sort());
    for (const [path, methods] of Object.entries(expected)) {
      const route = document.paths?.[path];
      expect(Object.keys(route ?? {}).sort()).toEqual([...methods].sort());
      for (const method of methods) {
        const operation = route?.[method as 'get' | 'post'];
        expect(operation?.responses?.['200']).toBeDefined();
        if (method === 'post') expect(operation?.requestBody).toBeDefined();
        else expect(operation?.requestBody).toBeUndefined();
        expect(operation?.parameters ?? []).toEqual([]);
      }
    }
    const lookup = JSON.stringify(document.paths?.['/v1/social/people/lookup']?.post);
    expect(lookup).toContain('handle');
    expect(lookup).not.toContain('email');
    const create = JSON.stringify(document.paths?.['/v1/social/invites/create']?.post?.responses?.['200']);
    for (const field of ['acceptance', 'delivery', 'linkId', 'token', 'unavailable', 'replayed'])
      expect(create).toContain(field);
    const status = JSON.stringify(document.paths?.['/v1/social/invites']?.get?.responses?.['200']);
    expect(status).not.toContain('"token"');
    const request = JSON.stringify(document.paths?.['/v1/social/friends/request']?.post?.requestBody);
    for (const field of ['expectedPeerPersonId', 'expectedPairRevision', 'commandId', 'handle', 'token'])
      expect(request).toContain(field);
    const visit = JSON.stringify(document.paths?.['/v1/social/visits/read']?.post?.responses?.['200']);
    for (const field of [
      'publicSystemId',
      'list.v1',
      'pairRevision',
      'visibilityRevision',
      'publishedProjectionRevision',
    ])
      expect(visit).toContain(field);
    for (const field of [
      'universeId',
      'privateIds',
      'geographyRevision',
      'personalWatermark',
      'scene',
      'seed',
      'anchor',
      'coordinates',
      'evidence',
      'playhead',
      'seen',
      'branch',
      'lastSeenAt',
      'hiddenCount',
    ])
      expect(visit).not.toContain(`"${field}"`);
    expect(visit).toContain('"additionalProperties":false');
    for (const [key, procedure] of Object.entries(apiContract.sharing)) {
      const input = procedure['~orpc'].route.path ?? '';
      expect(input, key).not.toContain('{'); // no dynamic path/token parameter
    }
  });

  it('names a scope by account and privacy epoch, refused with a 409 problem', () => {
    expect(scopeClaimOf({ accountId: '0199f0a0-0000-7000-8000-00000000000a', privacyEpoch: 3 })).toBe(
      '0199f0a0-0000-7000-8000-00000000000a:3',
    );
    expect(problemCatalogue.SCOPE_MISMATCH.status).toBe(409);
  });

  it('accepts RFC 7636 S256 challenges and verifiers only', () => {
    expect(CODE_CHALLENGE_PATTERN.test('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(CODE_CHALLENGE_PATTERN.test('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM=')).toBe(false);
    expect(CODE_VERIFIER_PATTERN.test('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(true);
    expect(CODE_VERIFIER_PATTERN.test('short')).toBe(false);
    expect(CODE_VERIFIER_PATTERN.test(`${'a'.repeat(42)} `)).toBe(false);
  });
});

describe('recording376 declaration OpenAPI metadata', () => {
  it('adds exactly three strict private POST declarations with closed direct problems', async () => {
    const errors = apiContract.recording.set['~orpc'].errorMap;
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: {
        ReadRecordingPolicy: { schema: ReadRecordingPolicySchema },
        RecordingPolicyRead: { schema: RecordingPolicyReadSchema },
        SetRecordingPolicy: { schema: SetRecordingPolicySchema },
        RecordingPolicyAcceptance: { schema: RecordingPolicyAcceptanceSchema },
        RecordingPolicyReceipt: { schema: RecordingPolicyReceiptSchema },
        RecordingPolicy: { schema: RecordingPolicySchema },
        RecordingObservationBatchRequest: { schema: RecordingObservationBatchRequestSchema },
        RecordingObservationBatchResponse: { schema: RecordingObservationBatchResponseSchema },
        ...Object.fromEntries(
          Object.entries(errors).map(([code, definition]) => [`RecordingProblem_${code}`, { schema: definition.data }]),
        ),
      },
    });
    const declarations = [
      ['/v1/privacy/recording/read', 'ReadRecordingPolicy', 'RecordingPolicyRead'],
      ['/v1/privacy/recording/set', 'SetRecordingPolicy', 'RecordingPolicyAcceptance'],
      ['/v1/observations/recording-batch', 'RecordingObservationBatchRequest', 'RecordingObservationBatchResponse'],
    ] as const;
    const { recording, ...withoutRecording } = apiContract;
    const { submitRecording, ...legacyObservations } = withoutRecording.observations;
    expect(Object.values(recording)).toHaveLength(2);
    expect(submitRecording).toBe(apiContract.observations.submitRecording);
    const legacy = await generator.generate(
      { ...withoutRecording, observations: legacyObservations },
      {
        info: { title: 'KnowScroll API', version: '1' },
      },
    );
    expect(
      Object.keys(document.paths ?? {})
        .filter((p) => !(p in (legacy.paths ?? {})))
        .sort(),
    ).toEqual(declarations.map(([path]) => path).sort());
    for (const path of Object.keys(legacy.paths ?? {})) expect(document.paths).toHaveProperty(path);
    for (const [path, input, output] of declarations) {
      const operation = document.paths?.[path]?.post;
      expect(Object.keys(document.paths?.[path] ?? {})).toEqual(['post']);
      expect(operation?.parameters ?? []).toEqual([]);
      expect(operation?.requestBody).toEqual({
        required: true,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${input}` },
          },
        },
      });
      expect(operation?.responses?.['200']).toMatchObject({
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${output}` },
          },
        },
      });
      for (const status of new Set(Object.values(errors).map((e) => String(e.status)))) {
        const response = operation?.responses?.[status];
        expect(response && !('$ref' in response) && response.content).toEqual({
          'application/problem+json': {
            schema: {
              oneOf: Object.entries(errors)
                .filter(([, e]) => String(e.status) === status)
                .map(([code]) => ({ $ref: `#/components/schemas/RecordingProblem_${code}` })),
            },
          },
        });
      }
    }
    const schemas = document.components?.schemas;
    expect(schemas?.['SetRecordingPolicy']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'commandId', 'expectedPrivacyEpoch', 'expectedRecordingGeneration', 'on'],
      properties: {
        version: { const: 'recording-policy.v1' },
        expectedRecordingGeneration: { minimum: 1, maximum: 2_147_483_647 },
      },
    });
    expect(schemas?.['ReadRecordingPolicy']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'readId', 'target'],
    });
    expect(schemas?.['RecordingPolicyAcceptance']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'operation', 'outcome', 'receipt', 'replayed'],
      properties: { operation: { const: 'privacy.recording-set' }, outcome: { const: 'accepted' } },
    });
    expect(schemas?.['RecordingObservationBatchRequest']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'recordingGeneration', 'instrumentationVersion', 'events'],
      properties: {
        version: { const: 'observation-batch.v2' },
        recordingGeneration: { minimum: 1, maximum: 2_147_483_647 },
        events: { minItems: 1, maxItems: 50 },
      },
    });
    const response = JSON.stringify(schemas?.['RecordingObservationBatchResponse']);
    for (const token of [
      'processed',
      'not_recorded',
      'recording_paused',
      'recording_generation_stale',
      'currentGeneration',
    ])
      expect(response).toContain(token);
    const read = JSON.stringify(schemas?.['RecordingPolicyRead']);
    for (const token of ['current', 'command', 'recorded', 'not_recorded']) expect(read).toContain(token);
    for (const [code, definition] of Object.entries(errors)) {
      const schema = schemas?.[`RecordingProblem_${code}`];
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: {
          code: { const: code },
          status: { const: definition.status },
          title: { const: definition.message },
        },
      });
      for (const field of ['detail', 'instance', 'received', 'generation', 'commandId', 'message', 'defined'])
        expect(schema && !('$ref' in schema) && schema.properties).not.toHaveProperty(field);
    }
    expect(document.paths?.['/v1/observations/batch']?.post).toBeDefined();
    expect(
      Object.keys(document.paths ?? {})
        .filter((p) => p.startsWith('/v1/privacy/'))
        .sort(),
    ).toEqual([
      '/v1/privacy/clear-exploration',
      '/v1/privacy/clear-exploration/status',
      '/v1/privacy/recording/read',
      '/v1/privacy/recording/set',
    ]);
    expect(document.paths).not.toHaveProperty('/v1/privacy/export');
    expect(document.paths).not.toHaveProperty('/v1/account/delete');
  });
});

describe('Keep declaration OpenAPI metadata', () => {
  it('generates exact private POST bodies, named schemas and direct status-specific RFC9457 responses', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const errors = apiContract.keep.setPlace['~orpc'].errorMap;
    const commonSchemas = {
      ReadKeepEntry: { schema: ReadKeepEntrySchema },
      SetKeepPlace: { schema: SetKeepPlaceSchema },
      KeepEntrySnapshot: { schema: KeepEntrySnapshotSchema },
      KeepPlaceAcceptance: { schema: KeepPlaceAcceptanceSchema },
      KeepPlaceProblem: { schema: KeepPlaceProblemSchema },
      ...Object.fromEntries(
        Object.entries(errors).map(([code, definition]) => [`KeepProblem_${code}`, { schema: definition.data }]),
      ),
    };
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas,
    });
    const paths = Object.keys(document.paths ?? {}).filter((path) => path.includes('/keep/'));
    expect(paths.sort()).toEqual([
      '/v1/experience/keep/place',
      '/v1/experience/keep/read',
      '/v1/experience/keep/remove',
    ]);
    for (const [path, input, output] of [
      ['/v1/experience/keep/read', 'ReadKeepEntry', 'KeepEntrySnapshot'],
      ['/v1/experience/keep/place', 'SetKeepPlace', 'KeepPlaceAcceptance'],
    ]) {
      const item = document.paths?.[path!];
      expect(Object.keys(item ?? {})).toEqual(['post']);
      const operation = item?.post;
      expect(operation?.parameters ?? []).toEqual([]);
      expect(operation?.requestBody).toEqual({
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${input}` } } },
      });
      expect(operation?.responses?.['200']).toMatchObject({
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${output}` } } },
      });
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
        '200',
        '400',
        '401',
        '403',
        '404',
        '409',
        '413',
        '415',
        '422',
        '500',
        '503',
      ]);
      for (const status of ['400', '401', '403', '404', '409', '413', '415', '422', '500', '503']) {
        const response = operation?.responses?.[status];
        expect(response && !('$ref' in response) && response.content).toEqual({
          'application/problem+json': {
            schema: {
              oneOf: Object.entries(errors)
                .filter(([, definition]) => String(definition.status) === status)
                .map(([code]) => ({ $ref: `#/components/schemas/KeepProblem_${code}` })),
            },
          },
        });
      }
    }
    const schemas = document.components?.schemas;
    expect(schemas?.['ReadKeepEntry']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['version', 'target'],
    });
    expect(schemas?.['SetKeepPlace']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['version', 'commandId', 'entry', 'expectedPlaceRevision', 'position'],
    });
    expect(schemas?.['KeepEntrySnapshot']).toBeDefined();
    expect(schemas?.['KeepPlaceAcceptance']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['scope', 'entry', 'basePlaceRevision', 'acceptedPlaceRevision']) as unknown,
    });
    expect(schemas?.['KeepPlaceProblem']).toBeDefined();
    for (const [code, definition] of Object.entries(errors)) {
      const schema = schemas?.[`KeepProblem_${code}`];
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining(['type', 'title', 'status', 'code']) as unknown,
        properties: {
          code: { const: code },
          status: { const: definition.status },
          title: { const: problemCatalogue[code as keyof typeof problemCatalogue].title },
        },
      });
      const encoded = JSON.stringify(schema);
      expect(encoded).not.toContain('"defined"');
      expect(encoded).not.toContain('"message"');
      expect(encoded).not.toContain('"detail"');
      expect(encoded).not.toContain('"instance"');
      expect(encoded.includes('"currentPlaceRevision"')).toBe(code === 'KEEP_PLACE_REVISION_STALE');
      if (code === 'KEEP_PLACE_REVISION_STALE')
        expect(schema).toMatchObject({ required: expect.arrayContaining(['currentPlaceRevision']) as unknown });
    }
  });
});

describe('RegionEncounterOpen declaration OpenAPI metadata', () => {
  it('describes one strict private command and exact direct catalogue problems without mounting a consumer', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const errors = apiContract.experience.openRegionEncounter['~orpc'].errorMap;
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: {
        RegionEncounterOpenRequest: { schema: RegionEncounterOpenRequestSchema },
        RegionEncounterOpenResponse: { schema: RegionEncounterOpenResponseSchema },
        RegionEncounterProblem: { schema: RegionEncounterProblemSchema },
        ...Object.fromEntries(
          Object.entries(errors).map(([code, definition]) => [
            `RegionEncounterProblem_${code}`,
            { schema: definition.data },
          ]),
        ),
      },
    });
    const path = document.paths?.['/v1/experience/region/open'];
    expect(Object.keys(path ?? {})).toEqual(['post']);
    const operation = path?.post;
    expect(operation?.parameters ?? []).toEqual([]);
    expect(operation?.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RegionEncounterOpenRequest' } } },
    });
    expect(operation?.responses?.['200']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RegionEncounterOpenResponse' } } },
    });
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '413',
      '415',
      '422',
      '500',
      '503',
    ]);
    for (const status of ['400', '401', '403', '404', '409', '413', '415', '422', '500', '503']) {
      const response = operation?.responses?.[status];
      expect(response && !('$ref' in response) && response.content).toEqual({
        'application/problem+json': {
          schema: {
            oneOf: Object.entries(errors)
              .filter(([, definition]) => String(definition.status) === status)
              .map(([code]) => ({ $ref: `#/components/schemas/RegionEncounterProblem_${code}` })),
          },
        },
      });
    }
    const schemas = document.components?.schemas;
    expect(schemas?.['RegionEncounterOpenRequest']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['version', 'commandId', 'target', 'capabilities'],
      properties: {
        version: { const: 'region-encounter-open.v1' },
        target: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'regionId', 'expectedObjectRevision', 'expectedGeographyRevision'],
          properties: {
            kind: { const: 'region' },
            expectedObjectRevision: { minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
      },
    });
    expect(schemas?.['RegionEncounterOpenResponse']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['version', 'universeId', 'privacyEpoch', 'target', 'outcome'],
    });
    expect(schemas?.['RegionEncounterProblem']).toBeDefined();
    for (const [code, definition] of Object.entries(errors)) {
      const schema = schemas?.[`RegionEncounterProblem_${code}`];
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining(['type', 'title', 'status', 'code']) as unknown,
        properties: {
          code: { const: code },
          status: { const: definition.status },
          title: { const: problemCatalogue[code as keyof typeof problemCatalogue].title },
        },
      });
      const encoded = JSON.stringify(schema);
      for (const forbidden of ['defined', 'message', 'detail', 'instance', 'universeId'])
        expect(encoded).not.toContain(`"${forbidden}"`);
      expect(schema && !('$ref' in schema) && schema.properties).not.toHaveProperty('regionId');
    }
    // Refinements still require the actual canonical parser; metadata grants no target authority.
  });
});

describe('Selective Clear exploration declaration OpenAPI metadata', () => {
  it('generates exact private POST202/200 and direct status-specific closed RFC9457 schemas', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const errors = apiContract.privacy.clearExploration['~orpc'].errorMap;
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: {
        ClearExploration: { schema: ClearExplorationSchema },
        ClearExplorationAcceptance: { schema: ClearExplorationAcceptanceSchema },
        ReadClearExplorationStatus: { schema: ReadClearExplorationStatusSchema },
        ClearExplorationStatus: { schema: ClearExplorationStatusSchema },
        PrivacyProblem: { schema: PrivacyProblemSchema },
        ...Object.fromEntries(
          Object.entries(errors).map(([code, definition]) => [`PrivacyProblem_${code}`, { schema: definition.data }]),
        ),
      },
    });
    expect(
      Object.keys(document.paths ?? {})
        .filter((path) => path.startsWith('/v1/privacy/'))
        .sort(),
    ).toEqual([
      '/v1/privacy/clear-exploration',
      '/v1/privacy/clear-exploration/status',
      '/v1/privacy/recording/read',
      '/v1/privacy/recording/set',
    ]);
    const errorStatuses = ['400', '401', '403', '409', '413', '415', '422', '500', '503'];
    for (const [path, input, output, success] of [
      ['/v1/privacy/clear-exploration', 'ClearExploration', 'ClearExplorationAcceptance', '202'],
      ['/v1/privacy/clear-exploration/status', 'ReadClearExplorationStatus', 'ClearExplorationStatus', '200'],
    ] as const) {
      const item = document.paths?.[path];
      expect(Object.keys(item ?? {})).toEqual(['post']);
      const operation = item?.post;
      expect(operation?.parameters ?? []).toEqual([]);
      expect(operation?.requestBody).toEqual({
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${input}` } } },
      });
      expect(operation?.responses?.[success]).toMatchObject({
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${output}` } } },
      });
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([success, ...errorStatuses].sort());
      for (const status of errorStatuses) {
        const response = operation?.responses?.[status];
        expect(response && !('$ref' in response) && response.content).toEqual({
          'application/problem+json': {
            schema: {
              oneOf: Object.entries(errors)
                .filter(([, definition]) => String(definition.status) === status)
                .map(([code]) => ({ $ref: `#/components/schemas/PrivacyProblem_${code}` })),
            },
          },
        });
      }
    }
    const schemas = document.components?.schemas;
    expect(schemas?.['ClearExploration']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['version', 'commandId', 'expectedPrivacyEpoch', 'confirmation'],
      properties: {
        version: { const: 'clear-exploration.v1' },
        expectedPrivacyEpoch: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        confirmation: { const: 'clear-exploration-preserve-keep-and-social' },
      },
    });
    expect(schemas?.['ClearExplorationAcceptance']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining([
        'version',
        'commandId',
        'fromEpoch',
        'toEpoch',
        'recordedAt',
        'outcome',
        'operation',
        'replayed',
      ]) as unknown,
    });
    expect(schemas?.['ReadClearExplorationStatus']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['version', 'target'],
    });
    const status = JSON.stringify(schemas?.['ClearExplorationStatus']);
    for (const field of [
      'scope',
      'target',
      'receipt',
      'fromEpoch',
      'toEpoch',
      'not_recorded',
      'pending',
      'failed',
      'completed_live',
      'removing_live_data',
      'waiting_for_accounting',
      'verifying_live_removal',
    ])
      expect(status).toContain(`"${field}"`);
    const whole = JSON.stringify(
      Object.fromEntries(
        Object.entries(schemas ?? {}).filter(
          ([key]) =>
            key.startsWith('ClearExploration') ||
            key === 'ReadClearExplorationStatus' ||
            key.startsWith('PrivacyProblem'),
        ),
      ),
    );
    for (const field of [
      'universeId',
      'tables',
      'counts',
      'progress',
      'provider',
      'detail',
      'instance',
      'payload',
      'backupExpiresAt',
      'preservedItems',
      'currentEpoch',
      'requestHash',
    ])
      expect(whole).not.toContain(`"${field}"`);
    for (const [code, definition] of Object.entries(errors)) {
      const schema = schemas?.[`PrivacyProblem_${code}`];
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining(['type', 'title', 'status', 'code']) as unknown,
        properties: {
          code: { const: code },
          status: { const: definition.status },
          title: { const: problemCatalogue[code as keyof typeof problemCatalogue].title },
        },
      });
      for (const forbidden of ['defined', 'message', 'detail', 'instance', 'receipt', 'currentEpoch'])
        expect(JSON.stringify(schema)).not.toContain(`"${forbidden}"`);
    }
    expect(schemas?.['PrivacyProblem']).toBeDefined();
  });
});

describe('membership-fenced Keep removal OpenAPI declaration', () => {
  it('describes exact body/acknowledgement and closed direct RFC9457 responses without place CAS', async () => {
    const errors = apiContract.keep.remove['~orpc'].errorMap;
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: {
        RemoveKeepEntry: { schema: RemoveKeepEntrySchema },
        KeepRemovalAcceptance: { schema: KeepRemovalAcceptanceSchema },
        KeepRemovalProblem: { schema: KeepRemovalProblemSchema },
        ...Object.fromEntries(
          Object.entries(errors).map(([code, definition]) => [
            `KeepRemovalProblem_${code}`,
            { schema: definition.data },
          ]),
        ),
      },
    });
    const route = document.paths?.['/v1/experience/keep/remove'];
    expect(Object.keys(route ?? {})).toEqual(['post']);
    const operation = route?.post;
    expect(operation?.parameters ?? []).toEqual([]);
    expect(operation?.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RemoveKeepEntry' } } },
    });
    expect(operation?.responses?.['200']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/KeepRemovalAcceptance' } } },
    });
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '413',
      '415',
      '422',
      '500',
      '503',
    ]);
    for (const status of ['400', '401', '403', '404', '409', '413', '415', '422', '500', '503']) {
      const response = operation?.responses?.[status];
      expect(response && !('$ref' in response) && response.content).toEqual({
        'application/problem+json': {
          schema: {
            oneOf: Object.entries(errors)
              .filter(([, definition]) => String(definition.status) === status)
              .map(([code]) => ({ $ref: `#/components/schemas/KeepRemovalProblem_${code}` })),
          },
        },
      });
    }
    const schemas = document.components?.schemas;
    expect(schemas?.['RemoveKeepEntry']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['version', 'commandId', 'entry'],
    });
    expect(schemas?.['KeepRemovalAcceptance']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining([
        'version',
        'scope',
        'commandId',
        'recordedAt',
        'replayed',
        'outcome',
        'operation',
        'entry',
      ]) as unknown,
    });
    for (const [code, definition] of Object.entries(errors))
      expect(schemas?.[`KeepRemovalProblem_${code}`]).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: { code: { const: code }, status: { const: definition.status } },
      });
    expect(schemas?.['KeepRemovalProblem_KEEP_PLACE_REVISION_STALE']).toBeUndefined();
    expect(schemas?.['KeepRemovalProblem_KEEP_PLACE_COUNTER_EXHAUSTED']).toBeUndefined();
  });
});

describe('Saved live paging declaration OpenAPI metadata', () => {
  it('retains one GET query and publishes bounded paging plus direct closed RFC9457 problems', async () => {
    const {
      ListSavedRequestSchema,
      ListSavedResponseSchema,
      SavedPageRequestSchema,
      SavedPageResponseSchema,
      SavedListProblemSchema,
    } = await import('./index.js');
    const errors = apiContract.experience.listSaved['~orpc'].errorMap;
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: {
        ListSavedRequest: { schema: ListSavedRequestSchema },
        ListSavedResponse: { schema: ListSavedResponseSchema },
        SavedPageRequest: { schema: SavedPageRequestSchema },
        SavedPageResponse: { schema: SavedPageResponseSchema },
        SavedListProblem: { schema: SavedListProblemSchema },
        ...Object.fromEntries(
          Object.entries(errors).map(([code, definition]) => [`SavedListProblem_${code}`, { schema: definition.data }]),
        ),
      },
    });
    const operation = document.paths?.['/v1/saved']?.get;
    expect(document.paths?.['/v1/saved']?.post).toBeUndefined();
    expect(
      operation?.parameters?.map((parameter) => ('$ref' in parameter ? parameter.$ref : parameter.name)).sort(),
    ).toEqual(['cursor', 'filter', 'limit', 'pagination']);
    for (const parameter of operation?.parameters ?? [])
      expect(parameter).toMatchObject({ in: 'query', required: false });
    // Per-query-parameter OpenAPI cannot express the cross-field branch selection. The
    // canonical parser and new caller's required response branch remain authoritative.
    expect(operation?.responses?.['200']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ListSavedResponse' } } },
    });
    const statuses = [...new Set(Object.values(errors).map((definition) => String(definition.status)))].sort();
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(['200', ...statuses].sort());
    for (const status of statuses) {
      const response = operation?.responses?.[status];
      expect(response && !('$ref' in response) && response.content).toEqual({
        'application/problem+json': {
          schema: {
            oneOf: Object.entries(errors)
              .filter(([, definition]) => String(definition.status) === status)
              .map(([code]) => ({ $ref: `#/components/schemas/SavedListProblem_${code}` })),
          },
        },
      });
    }
    const schemas = document.components?.schemas;
    expect(schemas?.['SavedPageRequest']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['pagination', 'filter', 'limit'],
      properties: { pagination: { const: 'saved-page.v1' }, filter: { enum: ['all', 'reel', 'scroll'] } },
    });
    expect(schemas?.['SavedPageResponse']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining([
        'pagination',
        'consistency',
        'scope',
        'filter',
        'limit',
        'revision',
        'items',
        'continuation',
      ]) as unknown,
      properties: {
        requestCursor: { pattern: '^ksp1_[A-Za-z0-9_-]{43,1024}$' },
        consistency: { const: 'live' },
        limit: { minimum: 1, maximum: 50 },
        items: { maxItems: 50 },
      },
    });
    for (const [code, definition] of Object.entries(errors)) {
      const schema = schemas?.[`SavedListProblem_${code}`];
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { const: code },
          status: { const: definition.status },
          title: { const: definition.message },
        },
      });
      const encoded = JSON.stringify(schema);
      for (const forbidden of [
        'defined',
        'message',
        'detail',
        'instance',
        'savedAt',
        'savedEntryId',
        'position',
        'total',
      ])
        expect(encoded).not.toContain(`"${forbidden}"`);
    }
  });
});

describe('Universe357 declaration OpenAPI metadata', () => {
  it('describes a strict read-only preview and compatible optional exact Open expectation', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const errors = apiContract.experience.previewRegionEncounter['~orpc'].errorMap;
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: {
        RegionPreviewRequest: { schema: RegionEncounterPreviewRequestSchema },
        RegionPreviewResponse: { schema: RegionEncounterPreviewResponseSchema },
        RegionOpenRequest: { schema: RegionEncounterOpenRequestSchema },
        ...Object.fromEntries(
          Object.entries(errors).map(([code, definition]) => [
            `RegionPreviewProblem_${code}`,
            { schema: definition.data },
          ]),
        ),
      },
    });
    const path = document.paths?.['/v1/experience/region/preview'];
    expect(Object.keys(path ?? {})).toEqual(['post']);
    expect(path?.post?.parameters ?? []).toEqual([]);
    expect(path?.post?.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RegionPreviewRequest' } } },
    });
    expect(path?.post?.responses?.['200']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RegionPreviewResponse' } } },
    });
    expect(document.components?.schemas?.['RegionPreviewRequest']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'readId', 'target', 'capabilities'],
    });
    expect(document.components?.schemas?.['RegionOpenRequest']).toMatchObject({
      required: ['version', 'commandId', 'target', 'capabilities'],
      properties: { expectedEncounter: { additionalProperties: false, required: ['assetId', 'assetRevision'] } },
    });
    for (const status of new Set(Object.values(errors).map((e) => String(e.status)))) {
      const response = path?.post?.responses?.[status];
      expect(response && !('$ref' in response) && response.content).toEqual({
        'application/problem+json': {
          schema: {
            oneOf: Object.entries(errors)
              .filter(([, e]) => String(e.status) === status)
              .map(([code]) => ({ $ref: `#/components/schemas/RegionPreviewProblem_${code}` })),
          },
        },
      });
    }
  });

  it('describes separate read, durable claim/current status and terminal acknowledgement with closed problems', async () => {
    const errors = apiContract.formation.claim['~orpc'].errorMap;
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: {
        ReadFormation: { schema: ReadFormationPresentationSchema },
        FormationRead: { schema: FormationPresentationReadSchema },
        ClaimFormation: { schema: ClaimFormationPresentationSchema },
        FormationClaim: { schema: FormationPresentationClaimAcceptanceSchema },
        AcknowledgeFormation: { schema: AcknowledgeFormationPresentationSchema },
        FormationAcknowledgement: { schema: FormationPresentationAcknowledgementSchema },
        FormationProblem: { schema: FormationPresentationProblemSchema },
        ...Object.fromEntries(
          Object.entries(errors).map(([code, definition]) => [`FormationProblem_${code}`, { schema: definition.data }]),
        ),
      },
    });
    expect(
      Object.keys(document.paths ?? {})
        .filter((p) => p.startsWith('/v1/universe/formation/'))
        .sort(),
    ).toEqual(['/v1/universe/formation/acknowledge', '/v1/universe/formation/claim', '/v1/universe/formation/read']);
    for (const [name, input, output] of [
      ['read', 'ReadFormation', 'FormationRead'],
      ['claim', 'ClaimFormation', 'FormationClaim'],
      ['acknowledge', 'AcknowledgeFormation', 'FormationAcknowledgement'],
    ] as const) {
      const path = document.paths?.[`/v1/universe/formation/${name}`];
      expect(Object.keys(path ?? {})).toEqual(['post']);
      expect(path?.post?.parameters ?? []).toEqual([]);
      expect(path?.post?.requestBody).toEqual({
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${input}` } } },
      });
      expect(path?.post?.responses?.['200']).toMatchObject({
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${output}` } } },
      });
      for (const status of new Set(Object.values(errors).map((e) => String(e.status)))) {
        const response = path?.post?.responses?.[status];
        expect(response && !('$ref' in response) && response.content).toEqual({
          'application/problem+json': {
            schema: {
              oneOf: Object.entries(errors)
                .filter(([, e]) => String(e.status) === status)
                .map(([code]) => ({ $ref: `#/components/schemas/FormationProblem_${code}` })),
            },
          },
        });
      }
    }
    const schemas = document.components?.schemas;
    expect(schemas?.['ReadFormation']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'readId', 'target', 'capabilities'],
    });
    expect(schemas?.['ClaimFormation']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'commandId', 'transitionId', 'attemptNonce'],
    });
    expect(schemas?.['AcknowledgeFormation']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'commandId', 'transitionId', 'claimId', 'attemptNonce', 'disposition'],
    });
    expect(schemas?.['FormationClaim']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'scope', 'receipt', 'replayed', 'current'],
    });
    const read = JSON.stringify(schemas?.['FormationRead']);
    for (const field of ['fact', 'targets', 'truthStatus', 'eligibility', 'claimable', 'final', 'durationMs', '2400'])
      expect(read).toContain(field);
    for (const [code, definition] of Object.entries(errors)) {
      const schema = schemas?.[`FormationProblem_${code}`];
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: {
          code: { const: code },
          status: { const: definition.status },
          title: { const: definition.message },
        },
      });
      expect(schema && !('$ref' in schema) && schema.properties).not.toHaveProperty('transitionId');
      expect(schema && !('$ref' in schema) && schema.properties).not.toHaveProperty('claimId');
      for (const field of ['defined', 'message', 'instance', 'camera', 'learned'])
        expect(JSON.stringify(schema)).not.toContain(`"${field}"`);
    }
  });
});

describe('Social370 declaration OpenAPI metadata', () => {
  it('declares finite direct conversations/full-content shares with JSON selectors and direct closed problems', async () => {
    const errors = apiContract.conversations.send['~orpc'].errorMap;
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: {
        StartDirect: { schema: StartDirectConversationSchema },
        DirectAcceptance: { schema: DirectConversationAcceptanceSchema },
        SendMessage: { schema: SendConversationMessageSchema },
        MessageAcceptance: { schema: ConversationMessageAcceptanceSchema },
        ReadChanges: { schema: ReadConversationChangesSchema },
        ChangesPage: { schema: ConversationChangesPageSchema },
        ResolveShare: { schema: ResolveContentShareSchema },
        ResolvedShare: { schema: ResolvedContentShareSchema },
        SocialProblem: { schema: SocialProblemSchema },
        SocialIssue: { schema: SocialProblemIssueSchema },
        ...Object.fromEntries(
          Object.entries(errors).map(([code, definition]) => [`SocialProblem_${code}`, { schema: definition.data }]),
        ),
      },
    });
    const declarations = [...Object.values(apiContract.conversations), ...Object.values(apiContract.contentShares)];
    expect(declarations).toHaveLength(13);
    expect(new Set(declarations.map((x) => x['~orpc'].route.path)).size).toBe(13);
    for (const declaration of declarations) {
      const route = declaration['~orpc'].route;
      expect(route.method).toBe('POST');
      expect(route.path).not.toContain('{');
      const path = document.paths?.[route.path ?? ''];
      expect(Object.keys(path ?? {})).toEqual(['post']);
      expect(path?.post?.parameters ?? []).toEqual([]);
      expect(path?.post?.requestBody).toMatchObject({
        required: true,
        content: { 'application/json': { schema: expect.any(Object) as unknown } },
      });
      expect(path?.post?.responses?.['200']).toBeDefined();
      for (const status of new Set(Object.values(errors).map((x) => String(x.status)))) {
        const response = path?.post?.responses?.[status];
        expect(response && !('$ref' in response) && response.content).toEqual({
          'application/problem+json': {
            schema: {
              oneOf: Object.entries(errors)
                .filter(([, x]) => String(x.status) === status)
                .map(([code]) => ({ $ref: `#/components/schemas/SocialProblem_${code}` })),
            },
          },
        });
      }
    }
    expect(document.components?.schemas?.['SendMessage']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'commandId', 'conversation', 'body'],
    });
    expect(document.components?.schemas?.['ReadChanges']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'readId', 'conversation', 'limit', 'cursor'],
    });
    expect(document.components?.schemas?.['ResolveShare']).toMatchObject({
      additionalProperties: false,
      required: ['version', 'readId', 'token'],
    });
    const issue = document.components?.schemas?.['SocialIssue'];
    expect(issue).toMatchObject({
      additionalProperties: false,
      required: ['path', 'code'],
      properties: {
        path: { type: 'array', maxItems: 8, items: { enum: expect.arrayContaining(['token', 'unknown']) as unknown } },
      },
    });
    expect(issue && !('$ref' in issue) && Object.keys(issue.properties ?? {})).toEqual(['path', 'code']);
    const wire = JSON.stringify(document.components?.schemas?.['ResolvedShare']);
    for (const value of ['public_metadata', 'conversation', 'corrected', 'unavailable']) expect(wire).toContain(value);
    for (const field of [
      'token',
      'sender',
      'playheadMs',
      'seen',
      'currentBranch',
      'interests',
      'mediaUrl',
      'exposureId',
    ])
      expect(wire).not.toContain(`"${field}"`);
    for (const [code, definition] of Object.entries(errors)) {
      const schema = document.components?.schemas?.[`SocialProblem_${code}`];
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: {
          code: { const: code },
          status: { const: definition.status },
          title: { const: definition.message },
        },
      });
      for (const field of ['detail', 'instance', 'token', 'message', 'sender', 'blocked', 'defined'])
        expect(schema && !('$ref' in schema) && schema.properties).not.toHaveProperty(field);
    }
  });
});

describe('friend-pages378 bounded scan declaration OpenAPI metadata', () => {
  it('adds exactly two strict private POSTs and direct closed Social problems without changing legacy routes', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [makeSchemaConverter()] });
    const errors = apiContract.friendPages.friends['~orpc'].errorMap;
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: {
        ReadFriendsPage: { schema: ReadFriendsPageSchema },
        ReadFriendRequestsPage: { schema: ReadFriendRequestsPageSchema },
        FriendsPage: { schema: FriendsPageSchema },
        FriendRequestsPage: { schema: FriendRequestsPageSchema },
        ...Object.fromEntries(
          Object.entries(errors).map(([code, definition]) => [
            `FriendPagesProblem_${code}`,
            { schema: definition.data },
          ]),
        ),
      },
    });
    const { friendPages, ...withoutFriendPages } = apiContract;
    expect(Object.keys(friendPages)).toEqual(['friends', 'requests']);
    const legacy = await generator.generate(withoutFriendPages, { info: { title: 'KnowScroll API', version: '1' } });
    const declarations = [
      ['/v1/social/friends/page', 'ReadFriendsPage', 'FriendsPage', ['friends', 'blocked']],
      ['/v1/social/requests/page', 'ReadFriendRequestsPage', 'FriendRequestsPage', ['incoming', 'outgoing']],
    ] as const;
    expect(
      Object.keys(document.paths ?? {})
        .filter((path) => !(path in (legacy.paths ?? {})))
        .sort(),
    ).toEqual(declarations.map(([path]) => path).sort());
    for (const path of Object.keys(legacy.paths ?? {})) expect(document.paths).toHaveProperty(path);
    for (const [path, input, output, filters] of declarations) {
      const operation = document.paths?.[path]?.post;
      expect(Object.keys(document.paths?.[path] ?? {})).toEqual(['post']);
      expect(operation?.parameters ?? []).toEqual([]);
      expect(operation?.requestBody).toEqual({
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${input}` } } },
      });
      expect(operation?.responses?.['200']).toMatchObject({
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${output}` } } },
      });
      const schemas = document.components?.schemas;
      expect(schemas?.[input]).toMatchObject({
        additionalProperties: false,
        required: ['version', 'requestId', 'limit', 'filter'],
        properties: {
          version: { const: 'friend-pages.v2' },
          requestId: { type: 'string', format: 'uuid' },
          limit: { minimum: 1, maximum: 50 },
          filter: { enum: [...filters] },
        },
      });
      const response = schemas?.[output];
      expect(response).toMatchObject({
        additionalProperties: false,
        required: ['version', 'requestId', 'scope', 'filter', 'snapshotRevision', 'items'],
        properties: {
          version: { const: 'friend-pages.v2' },
          requestId: { type: 'string', format: 'uuid' },
          filter: { enum: [...filters] },
          snapshotRevision: { minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          items: { type: 'array', maxItems: 50 },
        },
      });
      if (!response || '$ref' in response) throw new Error('Missing friend-pages output schema');
      const items = response.properties?.['items'];
      expect(items && !('$ref' in items) ? (items.minItems ?? 0) : undefined).toBe(0);
      expect(response.required).not.toContain('next');
      for (const field of [
        'total',
        'scanned',
        'anchor',
        'ceiling',
        'peerEpoch',
        'internalPairRevision',
        'presenceRevision',
      ])
        expect(response.properties).not.toHaveProperty(field);
      for (const status of new Set(Object.values(errors).map((e) => String(e.status)))) {
        const error = operation?.responses?.[status];
        expect(error && !('$ref' in error) && error.content).toEqual({
          'application/problem+json': {
            schema: {
              oneOf: Object.entries(errors)
                .filter(([, e]) => String(e.status) === status)
                .map(([code]) => ({ $ref: `#/components/schemas/FriendPagesProblem_${code}` })),
            },
          },
        });
      }
    }
    for (const [code, definition] of Object.entries(errors)) {
      const schema = document.components?.schemas?.[`FriendPagesProblem_${code}`];
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: {
          code: { const: code },
          status: { const: definition.status },
          title: { const: definition.message },
        },
      });
      for (const field of ['detail', 'instance', 'token', 'requestId', 'filter', 'peerEpoch', 'message', 'defined'])
        expect(schema && !('$ref' in schema) && schema.properties).not.toHaveProperty(field);
    }
    expect(document.paths?.['/v1/social/friends/read']?.post).toBeDefined();
    expect(document.paths?.['/v1/social/requests/read']?.post).toBeDefined();
  });
});
