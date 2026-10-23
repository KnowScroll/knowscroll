import type { BlockOfType } from '@knowscroll/scroll-model';
import { content } from '@knowscroll/design-tokens';
import { Text } from '../../text/text';
import { DataTable } from './data-table';
import { BlockFrame } from './frame';
import { formatCellNumber } from './table-format';

type Cell = BlockOfType<'table'>['data']['rows'][number][number];

function cellText(cell: Cell): string {
  return typeof cell === 'number' ? formatCellNumber(cell) : cell;
}

/**
 * A table: its caption, a header row, and up to 12 rows of text and numbers (numbers formatted
 * by the renderer, grouped and with a true minus). When the first cell labels the row it is the
 * row header. A table has no gesture and is its own text version.
 */
export function TableView({ block }: { readonly block: BlockOfType<'table'> }) {
  const { caption, columns, rows, rowHeader } = block.data;
  return (
    <BlockFrame accessibilityLabel={block.a11y.label} description={block.a11y.description}>
      <Text variant="bodyS" color={content.ink2}>
        {caption}
      </Text>
      <DataTable
        caption={caption}
        rowHeader={rowHeader}
        columns={columns.map((column) => ({
          label: column.unit === undefined ? column.label : `${column.label} (${column.unit})`,
          align: column.align,
        }))}
        rows={rows.map((row) => row.map(cellText))}
      />
    </BlockFrame>
  );
}
