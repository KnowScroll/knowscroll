import { describe, expect, it } from 'vitest';
import { starterEditorialScrolls } from '../starter/index.js';
import { compileEditorialSource, parseEditorialSource } from './scroll-compiler.js';

function source(): { [key: string]: unknown } & {
  draft: { sections: { blocks: { id: string; data: { spans: unknown } }[] }[] };
  material: string[];
} {
  return structuredClone(starterEditorialScrolls[0].source) as never;
}

function withFirstParagraph(text: string) {
  const edited = source();
  const block = edited.draft.sections[0]?.blocks[0];
  if (block === undefined) throw new Error('fixture paragraph missing');
  block.data.spans = text;
  return edited;
}

describe('the editorial source reader and compiler', () => {
  it('names the asset of a well-formed source', () => {
    expect(parseEditorialSource(source())).toMatchObject({
      kind: 'source',
      assetId: '267de10e-070f-473f-b5d3-1128417cefd7',
    });
  });

  it('reports a malformed source by code and path only, never by its text', () => {
    const parsed = parseEditorialSource({
      schemaVersion: 'editorial-scroll.v1',
      assetId: 'x',
      canary: 'canary-private-text-Q7',
    });
    expect(parsed.kind).toBe('invalid');
    expect(JSON.stringify(parsed)).not.toContain('canary-private-text-Q7');
    if (parsed.kind === 'invalid')
      for (const issue of parsed.issues) expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
  });

  it('refuses a number no claim stands behind, at the evidence stage', () => {
    const refused = compileEditorialSource(
      withFirstParagraph('The sky holds 7 colours and nothing supports that figure.'),
      1,
    );
    expect(refused).toMatchObject({ kind: 'refused', stage: 'evidence' });
    if (refused.kind === 'refused') expect(refused.issues.map((issue) => issue.code)).toContain('number_unbound');
  });

  it('refuses prose copied from the research material (the copy check, D-013)', () => {
    const edited = withFirstParagraph(
      'Look up on a clear afternoon and the sky is blue, almost wherever you stand, and the Sun looks white.',
    );
    edited.material = [
      'Look up on a clear afternoon and the sky is blue, almost wherever you stand, and nothing else follows.',
    ];
    const refused = compileEditorialSource(edited, 1);
    expect(refused).toMatchObject({ kind: 'refused', stage: 'evidence' });
    if (refused.kind === 'refused') expect(refused.issues.map((issue) => issue.code)).toContain('copied_passage');
  });

  it('refuses a draft the schema rejects, and a reading time outside the brief', () => {
    const shortRead = source();
    shortRead.draft.sections = shortRead.draft.sections.slice(0, 1);
    shortRead.draft.sections[0]!.blocks = shortRead.draft.sections[0]!.blocks.slice(0, 1);
    expect(compileEditorialSource(shortRead, 1)).toMatchObject({ kind: 'refused', stage: 'brief' });
    const broken = source();
    broken.draft = { draftVersion: 'scroll-draft.v1', title: 'x' } as never;
    expect(compileEditorialSource(broken, 1)).toMatchObject({ kind: 'refused', stage: 'schema' });
  });

  it('never lets an authored source claim a model produced it: the production record comes from code', () => {
    const edited = source() as { [key: string]: unknown };
    edited['production'] = { kind: 'model', runId: 'run-1', attemptIds: ['a1'], model: 'x', promptVersion: 'v1' };
    expect(parseEditorialSource(edited).kind).toBe('invalid');
  });
});
