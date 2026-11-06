/**
 * Web: names the surface Light (`data-ks-appearance="light"`). The appearance style sheet gives
 * every adaptive colour role its Light value on that element, and everything inside inherits it.
 * React Native Web reads every `data-*` attribute from one `dataSet` prop, so the given props'
 * own `dataSet` (a focus ring's `ksFocus`) is merged, never replaced.
 */
export function printedSurface(props: Record<string, unknown> = {}): Record<string, unknown> {
  const own = (props['dataSet'] ?? {}) as Record<string, string>;
  return { ...props, dataSet: { ...own, ksAppearance: 'light' } };
}
