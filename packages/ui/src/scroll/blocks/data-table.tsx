import { StyleSheet, View } from 'react-native';
import { borderWidth, content, spacing } from '@knowscroll/design-tokens';
import { Text } from '../../text/text';

export interface DataTableColumn {
  readonly label: string;
  readonly align: 'start' | 'end';
}

export interface DataTableProps {
  /** Named for assistive technology. */
  readonly caption: string;
  readonly columns: readonly DataTableColumn[];
  readonly rows: readonly (readonly string[])[];
  /** The first cell of each row labels the row. */
  readonly rowHeader?: boolean;
}

/**
 * Text and numbers in rows and columns, read as a table by assistive technology: `table`,
 * `row`, `columnheader`, `rowheader`, `cell`. Used for table blocks and for the text version of
 * a chart.
 */
export function DataTable({ caption, columns, rows, rowHeader = false }: DataTableProps) {
  return (
    <View role="table" accessibilityLabel={caption}>
      <View role="row" style={[styles.row, styles.headerRow]}>
        {columns.map((column, index) => (
          <View key={index} role="columnheader" style={styles.cell}>
            <Text variant="bodyS" style={[styles.header, column.align === 'end' ? styles.end : null]}>
              {column.label}
            </Text>
          </View>
        ))}
      </View>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} role="row" style={[styles.row, rowIndex < rows.length - 1 ? styles.rule : null]}>
          {row.map((cell, cellIndex) => {
            const header = rowHeader && cellIndex === 0;
            return (
              <View key={cellIndex} role={header ? 'rowheader' : 'cell'} style={styles.cell}>
                <Text
                  variant="bodyS"
                  style={[columns[cellIndex]?.align === 'end' ? styles.end : null, header ? styles.header : null]}
                >
                  {cell}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing[2], paddingVertical: spacing[2] },
  headerRow: { borderBottomWidth: borderWidth.regular, borderBottomColor: content.ink },
  rule: { borderBottomWidth: borderWidth.hairline, borderBottomColor: content.rule },
  cell: { flex: 1 },
  header: { fontWeight: '700' },
  end: { textAlign: 'right' },
});
