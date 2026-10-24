/** Intersects the actual player view and browser visibility; a hidden/offscreen video records none. */
export function observeMediaVisibility(node: unknown, changed: (visible: boolean) => void): () => void {
  let intersecting = false;
  const update = () => changed(intersecting && document.visibilityState === 'visible');
  const observer = new IntersectionObserver(
    (entries) => {
      intersecting = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5);
      update();
    },
    { threshold: [0, 0.5, 1] },
  );
  if (node instanceof Element) observer.observe(node);
  document.addEventListener('visibilitychange', update);
  // The observer reports once it has measured the stage. Reporting "not visible" before that would
  // cancel a resume owed from a closed sheet, so only a node that cannot be observed reports now.
  if (!(node instanceof Element)) update();
  return () => {
    observer.disconnect();
    document.removeEventListener('visibilitychange', update);
    changed(false);
  };
}
