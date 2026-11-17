/** Web: React Native Web turns `dataSet` into `data-*` attributes (`ksStageState` becomes `data-ks-stage-state`). */
export function dataSet(values: Readonly<Record<string, string>>): Record<string, unknown> {
  return { dataSet: values };
}
