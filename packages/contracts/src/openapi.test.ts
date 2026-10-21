import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { describe, expect, it } from 'vitest';
import {
  CODE_CHALLENGE_PATTERN,
  CODE_VERIFIER_PATTERN,
  ProblemDetailsSchema,
  ReadKeepEntrySchema,
  SetKeepPlaceSchema,
  KeepEntrySnapshotSchema,
  KeepPlaceAcceptanceSchema,
  KeepPlaceProblemSchema,
  RegionEncounterOpenRequestSchema,
  RegionEncounterOpenResponseSchema,
  RegionEncounterProblemSchema,
  apiContract,
  problemCatalogue,
  scopeClaimOf,
  sceneWireJsonSchemas,
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
      ...Object.values(apiContract.sharing),
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
      apiContract.experience.navigate,
      apiContract.experience.activateExposure,
      apiContract.experience.exposureDocument,
      apiContract.experience.exposureContext,
      apiContract.observations.submit,
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
    expect(paths.sort()).toEqual(['/v1/experience/keep/place', '/v1/experience/keep/read']);
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
