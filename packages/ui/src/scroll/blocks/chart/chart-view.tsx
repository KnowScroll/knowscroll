import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, radius, spacing } from '@knowscroll/design-tokens';
import type { BlockOfType } from '@knowscroll/scroll-model';
import { Button } from '../../../actions/button';
import { Text } from '../../../text/text';
import { useScrollRender } from '../../context';
import { DataTable } from '../data-table';
import { BlockFrame } from '../frame';
import { BlockActions, BlockLabel } from '../parts';
import { CHART_WIDTH, ChartSvg, chartDrawing, seriesStyle } from './chart-svg';
import { chartTable } from './table';

function legendLabels(spec: BlockOfType<'chart'>['data']['spec']): readonly string[] {
  return spec.kind === 'heatmap' ? [] : spec.series.map((series) => series.label);
}

/**
 * A static data figure: bar, line, scatter or heatmap, drawn from the document's numbers with
 * scales the renderer derives (nothing model-written is drawn as a number). It takes no gesture.
 * Its text version is the same data as a table, generated from the data, shown for the whole
 * article ("Text version") or for this chart ("Show data as a table"). No chart "inspect" or
 * comparison glyph exists in v1.
 */
export function ChartView({ block }: { readonly block: BlockOfType<'chart'> }) {
  const context = useScrollRender();
  const [asTable, setAsTable] = useState(false);
  const { title, caption, spec } = block.data;
  const showTable = context.textVersion || asTable;
  const table = showTable ? chartTable(block.data) : null;
  const legend = legendLabels(spec);
  const drawing = showTable ? null : chartDrawing(spec);

  return (
    <BlockFrame accessibilityLabel={block.a11y.label} description={block.a11y.description}>
      <BlockLabel>{title}</BlockLabel>
      {drawing === null ? null : (
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={block.a11y.label}
          accessibilityHint={block.a11y.description}
          style={{ aspectRatio: CHART_WIDTH / drawing.height }}
        >
          <ChartSvg spec={spec} />
        </View>
      )}
      {drawing !== null && legend.length > 1 ? (
        <View style={styles.legend}>
          {legend.map((name, index) => (
            <View key={name} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: seriesStyle(index).color }]} />
              <Text variant="meta">{name}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {table === null ? null : (
        <DataTable
          caption={title}
          columns={table.columns.map((name, index) => ({ label: name, align: index === 0 ? 'start' : 'end' }))}
          rows={table.rows}
          rowHeader
        />
      )}
      {caption === undefined ? null : (
        <Text variant="meta" color={content.ink2}>
          {caption}
        </Text>
      )}
      {context.textVersion ? null : (
        <BlockActions>
          <Button
            label={asTable ? 'Show the chart' : 'Show data as a table'}
            size="sm"
            variant="ghost"
            toggled={asTable}
            onPress={() => {
              setAsTable((value) => !value);
              if (!table) context.report(block.id, 'chart', 'text-version-opened');
            }}
          />
        </BlockActions>
      )}
    </BlockFrame>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  swatch: { width: spacing[3], height: spacing[3], borderRadius: radius.xs },
});
