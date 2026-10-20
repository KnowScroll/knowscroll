import { barChart, heatmapChart, horizontalBarChart, lineChart, scatterChart } from '../../fixtures/blocks';
import { formatCellNumber } from '../table-format';
import { linearTicks, logTicks, makeScale, tickLabel } from './scales';
import { chartTable } from './table';

describe('chart scales', () => {
  it('rounds a linear axis out to round numbers, and includes zero for bars', () => {
    const scale = makeScale([5, 9, 7], { scale: 'linear' }, { includeZero: true });
    expect(scale.domain).toEqual([0, 10]);
    expect(scale.at(0)).toBe(0);
    expect(scale.at(10)).toBe(1);
    expect(scale.ticks[0]).toBe(0);
    expect(scale.ticks[scale.ticks.length - 1]).toBe(10);
  });

  it('uses an authored domain as given', () => {
    const scale = makeScale([3, 4], { scale: 'linear', domain: [0, 100] });
    expect(scale.domain).toEqual([0, 100]);
    expect(scale.at(50)).toBe(0.5);
  });

  it('runs a log axis between powers of ten', () => {
    const scale = makeScale([60, 1000], { scale: 'log' });
    expect(scale.domain).toEqual([10, 1000]);
    expect(scale.ticks).toEqual([10, 100, 1000]);
    expect(scale.at(100)).toBeCloseTo(0.5);
    expect(logTicks(1, 100)).toEqual([1, 10, 100]);
  });

  it('gives round ticks and short labels', () => {
    expect(linearTicks(0, 10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(linearTicks(3, 3)).toEqual([3]);
    expect(tickLabel(1000)).toBe('1,000');
    expect(tickLabel(0.25)).toBe('0.25');
    expect(tickLabel(-2)).toBe('−2');
  });
});

describe('the text version of a chart', () => {
  it('is the bars as a table: a row per category, a column per series', () => {
    const table = chartTable(barChart('c').data);
    expect(table.columns).toEqual(['Score', 'Strength (of 10)', 'Cost (of 10)']);
    expect(table.rows).toEqual([
      ['Arch', '8', '6'],
      ['Beam', '5', '3'],
      ['Truss', '7', '5'],
      ['Cable', '9', '8'],
    ]);
  });

  it('is a row per point for a line or scatter, with the axis units in the header', () => {
    const line = chartTable(lineChart('l').data);
    expect(line.columns).toEqual(['Series', 'Span (m)', 'Weight (kN)']);
    expect(line.rows).toHaveLength(8);
    expect(line.rows[0]).toEqual(['Steel', '40', '740']);
    expect(line.rows[7]).toEqual(['Concrete', '160', '5,000']);
    expect(chartTable(scatterChart('s').data).rows).toHaveLength(8);
  });

  it('is a row per row of the grid for a heatmap', () => {
    const table = chartTable(heatmapChart('h').data);
    expect(table.columns).toEqual(['Stress', 'Load', 'Wind', 'Ice', 'Heat']);
    expect(table.rows[1]).toEqual(['Cable', '9', '5', '6', '3']);
  });

  it('keeps a horizontal log chart’s numbers whole', () => {
    expect(chartTable(horizontalBarChart('b').data).rows[3]).toEqual(['Suspension', '1,000']);
  });

  it('formats table numbers with grouping, only the decimals they have, and a true minus', () => {
    expect(formatCellNumber(2220)).toBe('2,220');
    expect(formatCellNumber(1.25)).toBe('1.25');
    expect(formatCellNumber(-3.5)).toBe('−3.5');
    expect(formatCellNumber(0)).toBe('0');
  });
});
