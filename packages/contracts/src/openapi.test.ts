import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { describe, expect, it } from 'vitest';
import { ProblemDetailsSchema, apiContract } from './index.js';

describe('the API contract', () => {
  it('generates an OpenAPI document with every route and the RFC 9457 problem schema', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      commonSchemas: { ProblemDetails: { schema: ProblemDetailsSchema, strategy: 'output' } },
    });

    const routes = Object.values(apiContract).map((procedure) => procedure['~orpc'].route);
    for (const route of routes) {
      const method = (route.method ?? 'POST').toLowerCase() as 'get' | 'post';
      expect(
        document.paths?.[route.path ?? '']?.[method]?.responses?.['200'],
        `${route.method} ${route.path}`,
      ).toBeDefined();
    }
    expect(document.components?.schemas?.['ProblemDetails']).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['type', 'title', 'status', 'code']) as unknown,
    });
  });
});
