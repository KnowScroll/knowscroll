import { describe, expect, it } from 'vitest';
import { parseDocumentV3 } from '@knowscroll/scroll-model';
import { ScrollProvenanceV3 } from '@knowscroll/scroll-model/internal';
import fence from '../fixtures/document-v3/fence.editorial-scroll-v3.json' with { type: 'json' };
import seasons from '../fixtures/document-v3/seasons.editorial-scroll-v3.json' with { type: 'json' };
import broadStreet from '../fixtures/document-v3/broad-street.editorial-scroll-v3.json' with { type: 'json' };
import { compileEditorialSourceFile, parseEditorialSourceFile } from './editorial-sources.js';
import { compileEditorialSourceV3, EDITORIAL_SOURCE_V3_VERSION } from './scroll-compiler-v3.js';

const FIXTURES = { fence, seasons, 'broad-street': broadStreet } as const;

describe('the hand-written document v3 fixtures', () => {
  it.each(Object.entries(FIXTURES))('%s compiles, validates and derives facts v4', (_name, source) => {
    const compiled = compileEditorialSourceV3(source, 1);
    if (compiled.kind === 'refused') throw new Error(`${compiled.stage}: ${JSON.stringify(compiled.issues)}`);
    expect(compiled.documentVersion).toBe('scroll-document.v3');
    expect(compiled.provenanceVersion).toBe('scroll-provenance.v3');
    expect(parseDocumentV3(compiled.document, { verify: true }).kind).toBe('valid');
    expect(ScrollProvenanceV3.safeParse(compiled.provenance).success).toBe(true);
    expect(compiled.document['kicker']).toBe('Fixture');
    expect(compiled.readingFacts.v).toBe(4);
    expect(compiled.readingFacts.blocks.every((block) => block.type === 'beat')).toBe(true);
  });

  it('compiles the same source to the same bytes, so a repeated import is a no-op', () => {
    const first = compileEditorialSourceV3(seasons, 3);
    const second = compileEditorialSourceV3(JSON.parse(JSON.stringify(seasons)) as unknown, 3);
    expect(first.kind === 'compiled' && second.kind === 'compiled' && first.documentSha256).toBe(
      second.kind === 'compiled' && second.documentSha256,
    );
  });

  it('refuses a figure that no cited passage writes', () => {
    const changed = JSON.parse(JSON.stringify(seasons)) as { scroll: { sections: { beats: { text: string }[] }[] } };
    const first = changed.scroll.sections[0]?.beats[1];
    if (first === undefined) throw new Error('fixture shape');
    first.text = first.text.replace('147.1', '147');
    const compiled = compileEditorialSourceV3(changed, 1);
    expect(compiled).toMatchObject({
      kind: 'refused',
      stage: 'evidence',
      issues: [{ code: 'authoring_number_not_in_evidence', path: 'beats.1' }],
    });
  });

  it('refuses a quotation that is not word for word in its passage', () => {
    const changed = JSON.parse(JSON.stringify(fence)) as { scroll: { sections: { beats: { text: string }[] }[] } };
    const quote = changed.scroll.sections[0]?.beats[3];
    if (quote === undefined) throw new Error('fixture shape');
    quote.text = quote.text.replace('Go away and think.', 'Go and think.');
    expect(compileEditorialSourceV3(changed, 1)).toMatchObject({
      kind: 'refused',
      stage: 'evidence',
      issues: [{ code: 'quote_not_in_evidence', path: 'beats.3' }],
    });
  });

  it('reads either source version through one parse and one compile', () => {
    expect(parseEditorialSourceFile(fence)).toMatchObject({ kind: 'source', assetId: fence.assetId });
    expect(compileEditorialSourceFile(fence, 1).kind).toBe('compiled');
    expect(parseEditorialSourceFile({ schemaVersion: EDITORIAL_SOURCE_V3_VERSION })).toMatchObject({ kind: 'invalid' });
  });
});
