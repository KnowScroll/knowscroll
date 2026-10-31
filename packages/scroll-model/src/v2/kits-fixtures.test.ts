import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callsOf } from './document.js';
import { kitDefinition, STAGE_KIT_IDS, type StageKitId } from './kits/index.js';
import { validateDocumentV2 } from './validate.js';

const NAMES = {
  'tides.v1': 'tides',
  'greenhouse.v1': 'greenhouse',
  'star.v1': 'star',
  'transit.v1': 'transit',
  'starlight.v1': 'starlight',
  'black-hole.v1': 'black-hole',
} as const;
const KITS = STAGE_KIT_IDS.filter((id): id is Exclude<StageKitId, 'earth-sky.v1'> => id !== 'earth-sky.v1');

const fixture = (kit: keyof typeof NAMES): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/documents/${NAMES[kit]}-stage-ci.json`, import.meta.url), 'utf8'));

/** The labelled CI fixtures the stage reader's end-to-end checks and the kit screenshots read. Not product content. */
describe.each(KITS)('the CI fixture of the kit %s', (kit) => {
  it('is a valid scroll-document.v2 that names its kit, and is short: the reading time is the one thing it fails', () => {
    const outcome = validateDocumentV2(fixture(kit), { verify: false });
    if (outcome.kind !== 'valid') throw new Error(JSON.stringify(outcome.issues));
    expect(outcome.document.kicker).toMatch(/CI fixture/);
    expect(outcome.document.stage?.kit).toBe(kit);
    expect(callsOf(outcome.document).map((call) => call.kind)).toEqual(['call_it', 'call_it', 'final_call']);
    const full = validateDocumentV2(fixture(kit));
    expect(full.kind === 'invalid' ? full.issues.map((issue) => issue.code) : []).toEqual([
      'reading_length_out_of_brief',
    ]);
  });

  it('shows every view of the kit and every state in the words the kit describes it with', () => {
    const outcome = validateDocumentV2(fixture(kit), { verify: false });
    if (outcome.kind !== 'valid') throw new Error('valid');
    const definition = kitDefinition(kit);
    const states = outcome.document.stage?.states ?? [];
    expect(new Set(states.map((entry) => entry.state['view']))).toEqual(new Set(definition.enums['view']));
    for (const entry of states) expect(entry.alt).toBe(definition.describe(entry.state));
    expect(states.length).toBeGreaterThanOrEqual(6);
  });
});
