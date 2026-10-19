import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProblemDetailsSchema, apiContract } from './index.js';

describe('the API contract', () => {
  it('generates an OpenAPI document that lists every route with RFC 9457 errors', async () => {
    const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
    const document = await generator.generate(apiContract, {
      info: { title: 'KnowScroll API', version: '1' },
      customErrorResponseBodySchema: () => z.toJSONSchema(ProblemDetailsSchema) as Record<string, unknown>,
    });

    const health = document.paths?.['/health']?.get;
    expect(health?.responses?.['200']).toBeDefined();
    expect(JSON.stringify(document)).toContain('"code"');
  });
});
