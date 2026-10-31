/**
 * Native: the platform back (Android back, iOS swipe) reaches the Modal's `onRequestClose`, so
 * overlays need nothing from history.
 */
export function useOverlayHistory(_visible: boolean, _onClose: () => void): void {}

/** Native: there is no history marker to claim. */
export function claimOverlayEntry(state: unknown): {
  readonly state: Record<string, unknown>;
  readonly replace: boolean;
} {
  return {
    state: typeof state === 'object' && state !== null ? { ...(state as Record<string, unknown>) } : {},
    replace: false,
  };
}
