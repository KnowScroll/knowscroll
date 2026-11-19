import { describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '../negotiation.js';
import { validDocumentV3 } from '../test-support/v3-fixtures.js';
import { negotiateV3, parseDocumentV3 } from './delivery.js';
import { SCROLL_DOCUMENT_V3_SCHEMA_VERSION } from './document.js';
import { validateDocumentV3 } from './validate.js';

const document = validDocumentV3();
const wire = (): Record<string, unknown> => JSON.parse(JSON.stringify(document)) as Record<string, unknown>;

describe('the client path of a v3 document', () => {
  it('parses a stored document and skips what costs a hash unless asked', () => {
    expect(parseDocumentV3(wire())).toMatchObject({ kind: 'valid', notices: [] });
    const tampered = { ...wire(), integrity: { method: 'canonical-json-sha256.v1', sha256: 'a'.repeat(64) } };
    expect(parseDocumentV3(tampered).kind).toBe('valid');
    expect(parseDocumentV3(tampered, { verify: true })).toEqual({
      kind: 'invalid',
      issues: [{ code: 'integrity_mismatch', path: 'integrity' }],
    });
    expect(validateDocumentV3(tampered).kind).toBe('invalid');
    const measures = { ...wire(), measures: { ...document.measures, totalWeight: document.measures.totalWeight + 1 } };
    expect(parseDocumentV3(measures).kind).toBe('valid');
    expect(parseDocumentV3(measures, { verify: true }).kind).toBe('invalid');
  });

  it('still refuses what is structurally wrong, with codes and paths and never throwing', () => {
    expect(parseDocumentV3(null)).toMatchObject({ kind: 'invalid' });
    expect(parseDocumentV3({ ...wire(), schemaVersion: 'scroll-document.v2' })).toMatchObject({ kind: 'invalid' });
    expect(parseDocumentV3({ ...wire(), prompt: 'secret' })).toMatchObject({ kind: 'invalid' });
    expect(parseDocumentV3({ ...wire(), asides: [] })).toMatchObject({ kind: 'invalid' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(parseDocumentV3(cyclic)).toEqual({ kind: 'invalid', issues: [{ code: 'document_not_object', path: '$' }] });
  });

  it('still applies the rules that cost nothing, so a client never draws a document that breaks them', () => {
    const noLimits = { ...wire(), asides: [{ ...document.asides[1], id: 'aside-two' }] };
    expect(parseDocumentV3(noLimits)).toEqual({
      kind: 'invalid',
      issues: [{ code: 'limits_aside_missing', path: 'asides' }],
    });
  });

  it('offers the document whole to a client that declares the schema, and to no other', () => {
    const v3 = { ...FULL_V1_CAPABILITIES, documentSchemas: [SCROLL_DOCUMENT_V3_SCHEMA_VERSION] };
    expect(negotiateV3(document, v3)).toEqual({ kind: 'negotiated', document });
    expect(negotiateV3(document, FULL_V1_CAPABILITIES)).toEqual({
      kind: 'unsupported-document',
      schemaVersion: SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
    });
  });

  it('refuses capabilities that are not capabilities', () => {
    expect(negotiateV3(document, { documentSchemas: 3 }).kind).toBe('invalid-capabilities');
    expect(negotiateV3(document, null).kind).toBe('invalid-capabilities');
  });
});
