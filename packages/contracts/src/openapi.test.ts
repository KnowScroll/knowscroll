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
      apiContract.media.grant,
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
    for (const field of [
      'discover',
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
    for (const privateField of ['playheadMs', 'blockOffset', 'sources', 'provenance', 'score', 'peerPlayback']) {
      expect(open).not.toContain(`"${privateField}"`);
      expect(navigate).not.toContain(`"${privateField}"`);
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
