/**
 * Where each beat (and the end plate) starts in the essay, in the scroll content's coordinates: what the reader needs to
 * know which beat is being read, to open at a kept place and to jump to a stop. Native: from layout events, which fire
 * whenever a view moves. The web file measures the element when asked instead.
 */
export interface Places {
  /** Native: a place's top from its layout, already in the essay's coordinates. */
  readonly laidOut: (id: string, top: number) => void;
  /** Web: a place's element, measured when asked. */
  readonly attached: (id: string, element: unknown) => void;
  readonly topOf: (id: string) => number | undefined;
}

export function createPlaces(): Places {
  const tops = new Map<string, number>();
  return {
    laidOut: (id, top) => void tops.set(id, top),
    attached: () => undefined,
    topOf: (id) => tops.get(id),
  };
}
