/** Native view is the full active Reel surface; route focus and AppState fence it upstream. */
export function observeMediaVisibility(_node: unknown, changed: (visible: boolean) => void): () => void {
  changed(true);
  return () => changed(false);
}
