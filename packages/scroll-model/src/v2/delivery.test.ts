import { describe, expect, it } from 'vitest';
import { compileAuthoredV2 } from '../producer/v2/compile.js';
import { authoredV2, compileInputV2 } from '../test-support/v2-fixtures.js';
import { FULL_V1_CAPABILITIES } from '../negotiation.js';
import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION, type ScrollDocumentV2 } from './document.js';
import { negotiateV2, parseDocumentV2 } from './delivery.js';
import { INTERACTION_KINDS_V2 } from './interactions.js';
import { validateDocumentV2 } from './validate.js';

const compiled = compileAuthoredV2(authoredV2(), compileInputV2());
if (compiled.kind !== 'compiled') throw new Error('CI fixture must compile');
const document: ScrollDocumentV2 = compiled.document;
const wire = (): Record<string, unknown> => JSON.parse(JSON.stringify(document)) as Record<string, unknown>;

describe('the client path of a v2 document', () => {
  it('parses a stored document and skips what costs a hash unless asked', () => {
    expect(parseDocumentV2(wire()).kind).toBe('valid');
    const tampered = { ...wire(), integrity: { method: 'canonical-json-sha256.v1', sha256: 'a'.repeat(64) } };
    expect(parseDocumentV2(tampered).kind).toBe('valid');
    expect(parseDocumentV2(tampered, { verify: true })).toMatchObject({ kind: 'invalid' });
    expect(validateDocumentV2(tampered)).toMatchObject({ kind: 'invalid' });
    const measures = { ...wire(), measures: { ...document.measures, totalWeight: document.measures.totalWeight + 1 } };
    expect(parseDocumentV2(measures).kind).toBe('valid');
    expect(parseDocumentV2(measures, { verify: true }).kind).toBe('invalid');
  });

  it('still refuses what is structurally wrong, with codes and paths and never throwing', () => {
    expect(parseDocumentV2(null)).toMatchObject({ kind: 'invalid' });
    expect(parseDocumentV2({ ...wire(), schemaVersion: 'scroll-document.v1' })).toMatchObject({ kind: 'invalid' });
    const extra = parseDocumentV2({ ...wire(), prompt: 'secret' });
    expect(extra).toMatchObject({ kind: 'invalid' });
    const noFinal = { ...wire(), stops: document.stops.slice(0, -1) };
    expect(parseDocumentV2(noFinal)).toMatchObject({ kind: 'invalid' });
  });

  it('offers the document whole to a client that declares the schema, and to no other', () => {
    const v2 = { ...FULL_V1_CAPABILITIES, documentSchemas: [SCROLL_DOCUMENT_V2_SCHEMA_VERSION] };
    expect(negotiateV2(document, v2)).toEqual({ kind: 'negotiated', document });
    expect(negotiateV2(document, FULL_V1_CAPABILITIES)).toEqual({
      kind: 'unsupported-document',
      schemaVersion: SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
    });
    expect(negotiateV2(document, { documentSchemas: 3 }).kind).toBe('invalid-capabilities');
  });

  it('declares only the value-free interactions a call counts by', () => {
    expect(INTERACTION_KINDS_V2).toEqual({ call_it: ['locked', 'revealed'], final_call: ['locked', 'revealed'] });
  });
});
