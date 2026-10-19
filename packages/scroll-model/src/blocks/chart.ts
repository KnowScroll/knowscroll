import { z } from 'zod';
import { FIELD_LIMITS, LIMITS } from '../limits.js';
import { FiniteNumber, LocalId, plainText } from '../primitives.js';

export const ChartAxis = z.strictObject({
  label: plainText(1, 40),
  unit: plainText(1, 16).optional(),
  scale: z.enum(['linear', 'log']),
  domain: z.tuple([FiniteNumber, FiniteNumber]).optional(),
});

const SeriesLabel = plainText(1, 40);

const PointSeries = z.strictObject({
  id: LocalId,
  label: SeriesLabel,
  points: z
    .array(z.tuple([FiniteNumber, FiniteNumber]))
    .min(1)
    .max(LIMITS.chartPoints),
});

export const ChartSpec = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('bar'),
    orientation: z.enum(['vertical', 'horizontal']),
    categories: z.array(plainText(1, 24)).min(1).max(FIELD_LIMITS.barCategories),
    series: z
      .array(
        z.strictObject({
          id: LocalId,
          label: SeriesLabel,
          values: z.array(FiniteNumber).min(1).max(FIELD_LIMITS.barCategories),
        }),
      )
      .min(1)
      .max(FIELD_LIMITS.chartSeries),
    valueAxis: ChartAxis,
  }),
  z.strictObject({
    kind: z.literal('line'),
    x: ChartAxis,
    y: ChartAxis,
    series: z.array(PointSeries).min(1).max(FIELD_LIMITS.chartSeries),
  }),
  z.strictObject({
    kind: z.literal('scatter'),
    x: ChartAxis,
    y: ChartAxis,
    series: z.array(PointSeries).min(1).max(FIELD_LIMITS.chartSeries),
  }),
  z.strictObject({
    kind: z.literal('heatmap'),
    rows: z.array(plainText(1, 24)).min(1).max(FIELD_LIMITS.heatmapSide),
    columns: z.array(plainText(1, 24)).min(1).max(FIELD_LIMITS.heatmapSide),
    values: z.array(z.array(FiniteNumber).min(1).max(FIELD_LIMITS.heatmapSide)).min(1).max(FIELD_LIMITS.heatmapSide),
    scale: z.strictObject({ label: plainText(1, 40), min: FiniteNumber, max: FiniteNumber }),
    highlightRow: z
      .number()
      .int()
      .min(0)
      .max(FIELD_LIMITS.heatmapSide - 1)
      .optional(),
  }),
]);

/** A static data figure; its text version is a data table generated from the data. */
export const ChartData = z.strictObject({
  title: plainText(1, 100),
  caption: plainText(1, FIELD_LIMITS.captionChars).optional(),
  spec: ChartSpec,
});
