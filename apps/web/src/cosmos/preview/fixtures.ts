/**
 * ILLUSTRATIVE FIXTURES for the isolated cosmos preview only. They are hand-written Atlas
 * responses so every star condition can be seen side by side; they are not anyone's universe,
 * never reach the API and are not evidence of world evolution. Names are generic physics topics.
 */
import type { WebAtlasResponse } from '@knowscroll/contracts/atlas';
import type { RelationKind } from '../starView.ts';

type Place = WebAtlasResponse['places'][number];

let counter = 0;
const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const at = '2026-10-10T09:00:00.000Z';

function place(partial: Partial<Place> & Pick<Place, 'kind' | 'anchor'>): Place {
  return {
    placeId: id(),
    parentPlaceId: null,
    basis: null,
    attention: partial.kind === 'sighting' ? null : { state: 'anchored', episodes: 4, daysActive: 2 },
    scrolls: { total: 4, seen: 2 },
    formedAt: at,
    formedBy: 'cartographer-v2',
    foundation: null,
    rooms: [],
    demand: null,
    ...partial,
  };
}

const anchor = (code: string, name: string, description: string) => ({ code, name, description });

export function conditionsFixture(): WebAtlasResponse {
  counter = 100;
  const tides = place({ kind: 'planet', anchor: anchor('tides', 'Tides', 'The rise and fall of the sea, driven by the Moon and Sun.') });
  const gravity = place({ kind: 'planet', anchor: anchor('gravity', 'Gravity', 'The attraction between masses.') });
  const energy = place({ kind: 'planet', anchor: anchor('energy', 'Energy', 'What lets a system do work.') });
  const light = place({ kind: 'planet', anchor: anchor('light', 'Light', 'Electromagnetic radiation we can see.') });
  const orbit = place({ kind: 'region', parentPlaceId: gravity.placeId, anchor: anchor('orbit', 'Orbit', 'A curved path around a mass.') });
  const colour = place({ kind: 'region', parentPlaceId: light.placeId, anchor: anchor('colour', 'Colour', 'How wavelengths look to us.') });
  const spectra = place({ kind: 'region', parentPlaceId: light.placeId, anchor: anchor('spectra', 'Spectra', 'Light split by wavelength.') });
  const entropy = place({ kind: 'region', parentPlaceId: energy.placeId, anchor: anchor('entropy', 'Entropy', 'How spread out energy is.') });
  gravity.rooms = [{
    roomId: id(),
    question: 'Why does the Moon not fall into the Earth?',
    state: 'opened',
    openedAt: at,
    inhabitants: [{ role: 'reader_of_record', claims: [{ key: 'g1', statement: 'The Moon is falling, but it moves sideways fast enough to keep missing.', truthState: 'documented', supportKind: 'supports' }] }],
  }];
  energy.rooms = [{
    roomId: id(),
    question: 'Can energy ever be fully recovered?',
    state: 'arguing',
    openedAt: at,
    inhabitants: [
      { role: 'reader_of_record', claims: [{ key: 'e1', statement: 'Energy is conserved in a closed system.', truthState: 'documented', supportKind: 'supports' }] },
      { role: 'doubter', claims: [{ key: 'e2', statement: 'Useful energy is not: some always spreads out as heat.', truthState: 'documented', supportKind: 'qualifies' }] },
    ],
  }];
  light.foundation = {
    holdsUp: [colour.placeId, spectra.placeId, tides.placeId],
    relations: [
      { kind: 'explains', from: 'Light', to: 'Colour', claim: { text: 'Colour is how we perceive different wavelengths of light.' }, bridge: null },
      { kind: 'explains', from: 'Light', to: 'Spectra', claim: { text: 'A spectrum is light spread out by wavelength.' }, bridge: null },
      { kind: 'applies_to', from: 'Light', to: 'Tides', claim: null, bridge: { mechanism: 'Satellite altimetry measures tides with reflected light.' } },
    ],
  };
  const sight = (parent: Place, code: string, name: string, kind: RelationKind) =>
    place({ kind: 'sighting', parentPlaceId: parent.placeId, anchor: anchor(code, name, `${name}, not met yet.`), basis: { kind, from: parent.anchor.name, to: name, claim: null, bridge: { mechanism: `${parent.anchor.name} and ${name} are connected.` } } });
  const places = [
    tides, gravity, energy, light, orbit, colour, spectra, entropy,
    sight(tides, 'moon', 'The Moon', 'explains'),
    sight(tides, 'coastline', 'Coastlines', 'applies_to'),
    sight(tides, 'resonance', 'Resonance', 'analogous_in'),
    sight(gravity, 'spacetime', 'Curved spacetime', 'compares_mechanism'),
    sight(energy, 'heat-engine', 'Heat engines', 'applies_to'),
  ];
  return {
    policyVersion: 'cartographer-v2',
    places,
    relations: [
      { fromPlaceId: gravity.placeId, toPlaceId: tides.placeId, kind: 'explains', claim: { text: 'Tides are caused by the gravitational pull of the Moon and the Sun.' }, bridge: null },
      { fromPlaceId: energy.placeId, toPlaceId: entropy.placeId, kind: 'contradicts', claim: { text: 'A perpetual machine would need entropy never to rise.' }, bridge: null },
      { fromPlaceId: light.placeId, toPlaceId: tides.placeId, kind: 'applies_to', claim: null, bridge: { mechanism: 'Satellite altimetry measures tides with reflected light.' } },
      { fromPlaceId: energy.placeId, toPlaceId: light.placeId, kind: 'explains', claim: { text: 'Light carries energy.' }, bridge: null },
    ],
    chronicle: [
      { deltaId: id(), placeId: light.placeId, parentPlaceId: null, kind: 'foundation_recognised', causalClass: 'substrate_neighbourhood', at, line: 'Light holds up Colour, Spectra and Tides.' },
      { deltaId: id(), placeId: orbit.placeId, parentPlaceId: gravity.placeId, kind: 'place_formed', causalClass: 'personal_exploration', at, line: 'A place formed around Orbit.' },
    ],
  };
}
