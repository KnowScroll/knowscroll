/**
 * Web: names a Scroll's page (`data-ks-page`), so it and everything inside it take the page's palette for the person's
 * appearance (D-424; `scrollPageStyleSheet`). Like `printedSurface`, the given props' own `dataSet` is merged, never
 * replaced.
 */
export function scrollPageSurface(props: Record<string, unknown> = {}): Record<string, unknown> {
  const own = (props['dataSet'] ?? {}) as Record<string, string>;
  return { ...props, dataSet: { ...own, ksPage: 'scroll' } };
}
