/**
 * Data attributes a block puts on its text so a selection can be mapped back to passage offsets
 * (`text-projection.v1`). Native has no DOM, so nothing is added there; React Native Web turns
 * `dataSet` into `data-*` attributes (`data-ks-block`, `data-ks-offset`).
 */
export function passageAttributes(_blockId: string, _offset: number): Record<string, unknown> {
  return {};
}

/** The same for the container of a block's text. */
export function blockAttributes(_blockId: string): Record<string, unknown> {
  return {};
}
