import type { BlockOfType } from '@knowscroll/scroll-model';
import { formatCellNumber } from '../table-format';

type ChartData = BlockOfType<'chart'>['data'];

export interface ChartTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function axisLabel(axis: { label: string; unit?: string | undefined }): string {
  return axis.unit === undefined ? axis.label : `${axis.label} (${axis.unit})`;
}

/**
 * The text version of a chart: its data as a table, generated from the data itself, so it cannot
 * say something the chart does not (bars: a row per category; line and scatter: a row per point;
 * heatmap: a row per row of the grid).
 */
export function chartTable(data: ChartData): ChartTable {
  const spec = data.spec;
  switch (spec.kind) {
    case 'bar': {
      const unit = spec.valueAxis.unit === undefined ? '' : ` (${spec.valueAxis.unit})`;
      return {
        columns: [spec.valueAxis.label, ...spec.series.map((series) => `${series.label}${unit}`)],
        rows: spec.categories.map((category, index) => [
          category,
          ...spec.series.map((series) => formatCellNumber(series.values[index] ?? 0)),
        ]),
      };
    }
    case 'line':
    case 'scatter':
      return {
        columns: ['Series', axisLabel(spec.x), axisLabel(spec.y)],
        rows: spec.series.flatMap((series) =>
          series.points.map((point) => [series.label, formatCellNumber(point[0]), formatCellNumber(point[1])]),
        ),
      };
    case 'heatmap':
      return {
        columns: [spec.scale.label, ...spec.columns],
        rows: spec.rows.map((row, index) => [
          row,
          ...(spec.values[index] ?? []).map((value) => formatCellNumber(value)),
        ]),
      };
  }
}
