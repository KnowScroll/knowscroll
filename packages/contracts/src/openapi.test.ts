import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { describe, expect, it } from 'vitest';
import {
  CODE_CHALLENGE_PATTERN,
  CODE_VERIFIER_PATTERN,
  ProblemDetailsSchema,
  apiContract,
  problemCatalogue,
  scopeClaimOf,
} from './index.js';

describe('the API contract', () => {
  it('generates an OpenAPI document with every route and the RFC 9457 problem schema', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: { ProblemDetails: { schema: ProblemDetailsSchema, strategy: 'output' } },
    });

    const routes = [
      apiContract.health,
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
    const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
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
    const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
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
    const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
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
