import { describe, expect, it } from 'vitest';
import { authoredV2, compileInputV2, FIXTURE_STAGES, MYTH_V2 } from '../../test-support/v2-fixtures.js';
import { EARTH_SKY_KIT } from '../../v2/kit.js';
import { kitDefinition, kitKeys, STAGE_KIT_IDS, type StageKitId } from '../../v2/kits/index.js';
import { computeIntegrityV2, validateDocumentV2 } from '../../v2/validate.js';
import type { ScrollDocumentV2 } from '../../v2/document.js';
import { AuthoredScrollV2 } from './authoring-schema.js';
import { authoringReferenceV2 } from './reference.js';
import { compileAuthoredV2, type CompileV2Outcome } from './compile.js';

const OTHER_KITS = STAGE_KIT_IDS.filter((id): id is Exclude<StageKitId, 'earth-sky.v1'> => id !== EARTH_SKY_KIT);

/** A state for each kit that holds a word its view does not draw: it has to be settled before it is stored. */
const UNSETTLED: Readonly<Record<Exclude<StageKitId, 'earth-sky.v1'>, Record<string, string>>> = {
  'tides.v1': { view: 'bulges', moonAt: 'full', focus: 'none' },
  'greenhouse.v1': { view: 'sunlight', layer: 'none', change: 'just-thickened', focus: 'none' },
  'star.v1': { view: 'balance', balance: 'steady', mass: 'high', stage: 'main-sequence', focus: 'none' },
  'transit.v1': { view: 'compare', planet: 'large', at: 'middle', focus: 'none' },
  'starlight.v1': { view: 'dimming', star: 'giant', distance: 'far', orbit: 'none', focus: 'none' },
  'black-hole.v1': { view: 'pull', star: 'sun-like', stage: 'fusing', hole: 'small', merger: 'apart', focus: 'none' },
};

const issuesOf = (outcome: CompileV2Outcome): string[] =>
  outcome.kind === 'refused' ? outcome.issues.map((issue) => `${issue.code}@${issue.path}`) : [];

describe.each(OTHER_KITS)('a stage Scroll drawn with the kit %s', (kit) => {
  const definition = kitDefinition(kit);

  it('compiles into a document that names the kit and holds only its words, each state described by the kit', () => {
    const outcome = compileAuthoredV2(authoredV2('stage', kit), compileInputV2('stage', MYTH_V2, kit));
    expect(issuesOf(outcome)).toEqual([]);
    if (outcome.kind !== 'compiled') return;
    const stage = outcome.document.stage;
    expect(stage?.kit).toBe(kit);
    expect(stage?.states.length).toBeGreaterThanOrEqual(3);
    for (const entry of stage?.states ?? []) {
      expect(Object.keys(entry.state).sort()).toEqual([...kitKeys(definition)].sort());
      expect(entry.alt).toBe(definition.describe(entry.state));
      expect(definition.settle(entry.state)).toEqual(entry.state);
    }
    expect(validateDocumentV2(JSON.parse(JSON.stringify(outcome.document))).kind).toBe('valid');
  });

  it('is deterministic: the same authoring always gives byte-identical output', () => {
    const first = compileAuthoredV2(authoredV2('stage', kit), compileInputV2('stage', MYTH_V2, kit));
    const second = compileAuthoredV2(authoredV2('stage', kit), compileInputV2('stage', MYTH_V2, kit));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('refuses the words of Earth & sky, and the words of every other kit, because the recipe’s kit is another', () => {
    const earth = compileAuthoredV2(authoredV2('stage', EARTH_SKY_KIT), compileInputV2('stage', MYTH_V2, kit));
    expect(issuesOf(earth)).toContain('stage_choice_invalid@items.0.stage');
    for (const other of OTHER_KITS.filter((candidate) => candidate !== kit)) {
      const foreign = compileAuthoredV2(authoredV2('stage', other), compileInputV2('stage', MYTH_V2, kit));
      expect(issuesOf(foreign), other).toContain('stage_choice_invalid@items.0.stage');
    }
  });

  it('refuses a Scroll whose first stop does not set the first picture, and one that never changes it', () => {
    const quiet = JSON.parse(JSON.stringify(authoredV2('stage', kit))) as { items: Record<string, unknown>[] };
    for (const item of quiet.items) if (item['type'] === 'stop') item['stage'] = {};
    const outcome = compileAuthoredV2(AuthoredScrollV2.parse(quiet), compileInputV2('stage', MYTH_V2, kit));
    expect(issuesOf(outcome)).toContain('stage_first_state_missing@items.0.stage');
  });

  it('refuses a stage on a plain Scroll of the same recipe', () => {
    const outcome = compileAuthoredV2(authoredV2('stage', kit), compileInputV2('plain', MYTH_V2, kit));
    expect(issuesOf(outcome)).toContain('stage_unexpected@items.0.stage');
  });

  it('cannot hand the reader a tilt: a bound Final call needs the Earth & sky kit', () => {
    const outcome = compileAuthoredV2(authoredV2('stage', kit), {
      ...compileInputV2('stage', MYTH_V2, kit),
      recipe: { ...compileInputV2('stage', MYTH_V2, kit).recipe, finalCall: { kind: 'tilt' } },
    });
    const final = authoredV2('stage', kit).items.length - 1;
    expect(issuesOf(outcome)).toContain(`final_call_binding_invalid@items.${String(final)}.binding`);
  });

  it('tells the writer exactly this kit’s keys and words, and no other kit’s', () => {
    const reference = authoringReferenceV2('stage', kit);
    for (const key of kitKeys(definition))
      expect(reference).toContain(`${key}: ${(definition.enums[key] ?? []).join(' | ')}`);
    for (const other of STAGE_KIT_IDS.filter((candidate) => candidate !== kit)) {
      const foreign = kitDefinition(other);
      for (const key of kitKeys(foreign)) {
        const line = `${key}: ${(foreign.enums[key] ?? []).join(' | ')}`;
        const same = (definition.enums[key] ?? []).join(' | ') === (foreign.enums[key] ?? []).join(' | ');
        if (!same) expect(reference, `${other} ${line}`).not.toContain(line);
      }
    }
  });

  it('refuses a stored state that is not settled, and a description that is not the kit’s own', () => {
    const outcome = compileAuthoredV2(authoredV2('stage', kit), compileInputV2('stage', MYTH_V2, kit));
    if (outcome.kind !== 'compiled') throw new Error('expected a compiled Scroll');
    const tamper = (edit: (document: ScrollDocumentV2) => void): string[] => {
      const document = JSON.parse(JSON.stringify(outcome.document)) as ScrollDocumentV2;
      edit(document);
      const unsigned = { ...document, integrity: undefined };
      const signed = { ...document, integrity: { ...document.integrity, sha256: computeIntegrityV2(unsigned) } };
      const checked = validateDocumentV2(signed);
      return checked.kind === 'invalid' ? checked.issues.map((issue) => `${issue.code}@${issue.path}`) : [];
    };
    expect(
      tamper((document) => {
        const entry = document.stage?.states[1];
        if (entry === undefined) throw new Error('the fixture has several states');
        Object.assign(entry, { state: UNSETTLED[kit], alt: definition.describe(UNSETTLED[kit] ?? {}) });
      }),
    ).toEqual(['stage_state_unsettled@stage.states.1.state']);
    expect(
      tamper((document) => {
        const entry = document.stage?.states[1];
        if (entry === undefined) throw new Error('the fixture has several states');
        entry.alt = 'A picture that does not match the state.';
      }),
    ).toEqual(['stage_alt_mismatch@stage.states.1.alt']);
  });

  it('has fixture stages the kit accepts whole, each different from the others', () => {
    const states = FIXTURE_STAGES[kit];
    expect(states).toHaveLength(6);
    expect(new Set(states.map((state) => JSON.stringify(definition.settle(state)))).size).toBe(6);
    for (const state of states) expect(definition.settle(state)).toEqual(state);
  });
});
