import { describe, expect, it } from 'vitest';
import { isPublicLabel } from '@knowscroll/contracts';
import {
  audienceAllows,
  planPublication,
  publicationChanged,
  shareableSystems,
  type GeographyPlace,
  type PublishedSystem,
} from './visibility.js';

const place = (id: string, kind: GeographyPlace['kind'], parentId: string, label: string, hypothetical = false) =>
  ({ id, kind, parentId, label, truthStatus: hypothetical ? 'hypothetical' : 'factual' }) satisfies GeographyPlace;
const places: GeographyPlace[] = [
  place('sys-b', 'system', 'universe', 'Weather'),
  place('sys-a', 'system', 'universe', 'astronomy'),
  place('sys-h', 'system', 'universe', 'What if the Moon were closer', true),
  place('star-a', 'star', 'sys-a', 'The star'),
  place('pl-1', 'planet', 'sys-a', 'Tides'),
  place('pl-2', 'planet', 'sys-a', 'Seasons'),
  place('pl-3', 'planet', 'sys-a', 'A hypothetical planet', true),
  place('pl-4', 'planet', 'sys-b', 'Clouds'),
  place('reg-1', 'region', 'pl-1', 'Neap tides'),
];
let counter = 0;
const newPublicId = () => `public-${(counter += 1)}`;

describe('who may visit', () => {
  it('lets nobody in by default and everybody only on request', () => {
    expect(audienceAllows({ mode: 'nobody' }, 'friend')).toBe(false);
    expect(audienceAllows({ mode: 'all_friends' }, 'friend')).toBe(true);
  });

  it('lets in only the chosen friends', () => {
    const audience = { mode: 'chosen_friends', friendAccountIds: new Set(['friend']) } as const;
    expect(audienceAllows(audience, 'friend')).toBe(true);
    expect(audienceAllows(audience, 'someone-else')).toBe(false);
  });
});

describe('what a visitor is shown', () => {
  it('offers factual systems only, sorted by label and not by formation', () => {
    expect(shareableSystems(places, isPublicLabel).map((s) => s.label)).toEqual(['astronomy', 'Weather']);
  });

  it('offers no system whose label is not fit to show', () => {
    const padded = [place('sys-p', 'system', 'universe', ' padded ')];
    expect(shareableSystems(padded, isPublicLabel)).toEqual([]);
  });

  it('publishes chosen systems with factual planets, and never stars, regions or hypotheticals', () => {
    const published = planPublication(places, new Set(['sys-a', 'sys-h']), [], isPublicLabel, newPublicId);
    expect(published.map((s) => s.label)).toEqual(['astronomy']);
    expect(published[0]?.planets.map((p) => p.label)).toEqual(['Seasons', 'Tides']);
    const everything = JSON.stringify(
      published.map(({ publicSystemId, label, planets }) => ({ publicSystemId, label, planets })),
    );
    for (const privateText of ['star-a', 'Neap tides', 'hypothetical', 'The star'])
      expect(everything).not.toContain(privateText);
  });

  it('gives every public place a fresh identity and keeps it while the place stays shared', () => {
    const first = planPublication(places, new Set(['sys-a']), [], isPublicLabel, newPublicId);
    const again = planPublication(places, new Set(['sys-a', 'sys-b']), first, isPublicLabel, newPublicId);
    const kept = again.find((s) => s.systemId === 'sys-a')!;
    expect(kept.publicSystemId).toBe(first[0]!.publicSystemId);
    expect(kept.planets.map((p) => p.publicPlanetId)).toEqual(first[0]!.planets.map((p) => p.publicPlanetId));
    const ids = again.flatMap((s) => [s.publicSystemId, ...s.planets.map((p) => p.publicPlanetId)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toMatch(/sys-|pl-/);
  });

  it('cannot link a system that is unshared and shared again', () => {
    const first = planPublication(places, new Set(['sys-a']), [], isPublicLabel, newPublicId);
    const withdrawn = planPublication(places, new Set(), first, isPublicLabel, newPublicId);
    const back = planPublication(places, new Set(['sys-a']), withdrawn, isPublicLabel, newPublicId);
    expect(withdrawn).toEqual([]);
    expect(back[0]!.publicSystemId).not.toBe(first[0]!.publicSystemId);
  });

  it('drops a chosen system that is no longer in Geography', () => {
    const published = planPublication(places.slice(2), new Set(['sys-a']), [], isPublicLabel, newPublicId);
    expect(published).toEqual([]);
  });

  it('calls it a change only when a visitor would see something different', () => {
    const before = planPublication(places, new Set(['sys-a']), [], isPublicLabel, newPublicId);
    const same = planPublication([...places].reverse(), new Set(['sys-a']), before, isPublicLabel, newPublicId);
    expect(publicationChanged(before, same)).toBe(false);
    const renamed: PublishedSystem[] = [{ ...before[0]!, label: 'Astronomy and space' }];
    expect(publicationChanged(before, renamed)).toBe(true);
    const grown = planPublication(
      [...places, place('pl-5', 'planet', 'sys-a', 'Eclipses')],
      new Set(['sys-a']),
      before,
      isPublicLabel,
      newPublicId,
    );
    expect(publicationChanged(before, grown)).toBe(true);
  });
});
