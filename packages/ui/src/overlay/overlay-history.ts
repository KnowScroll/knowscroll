/**
 * Native: the platform back (Android back, iOS swipe) reaches the Modal's `onRequestClose`, so
 * overlays need nothing from history.
 */
export function useOverlayHistory(_visible: boolean, _onClose: () => void): void {}
