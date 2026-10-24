/**
 * Marks the player's own play/pause surface in the DOM, so a screen's keyboard handling can tell it
 * from other controls without reading a test id. React Native Web writes `dataSet` as `data-*`.
 */
export const playbackToggleMarker: object = { dataSet: { ksPlaybackToggle: 'true' } };
