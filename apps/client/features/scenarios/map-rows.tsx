import { Pressable, StyleSheet, View } from 'react-native';
import { kindedTitle, type MapRow } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Icon, Text } from '@knowscroll/ui';
import { SPECULATIVE_NOTICE } from './branch-parts';

const INDENT = spacing[4];

/** "You" marks only the member's own position, never anyone else's. */
function YouBadge() {
  return (
    <View style={styles.you} accessible accessibilityLabel="You are here">
      <Text variant="monoXs" color={content.paper}>
        YOU
      </Text>
    </View>
  );
}

/** What a branch row says under its title, in words: where it stands, then that its premise is speculative. */
function notesOf(row: Extract<MapRow, { kind: 'branch' }>): readonly string[] {
  if (row.status === 'removed') return [];
  return [
    row.status === 'preparing' ? 'Preparing' : row.status === 'failed' ? 'Couldn’t prepare this branch' : undefined,
    row.speculative ? SPECULATIVE_NOTICE : undefined,
  ].filter((note): note is string => note !== undefined);
}

/**
 * One line of the map's outline (X04). A nested list, not a canvas: each line is a real control with its
 * place in the tree spoken (`level`). Episodes and ready branches open; a suggestion is dashed, says it was
 * not made and carries no number; a preparing, failed or removed branch says so and does not open.
 */
export function MapLine({
  row,
  onOpenEpisode,
  onOpenBranch,
  onOpenOffer,
  onShowMore,
}: {
  readonly row: MapRow;
  readonly onOpenEpisode: (assetId: string) => void;
  readonly onOpenBranch: (nodeId: string) => void;
  readonly onOpenOffer: (draftId: string, optionId: string) => void;
  readonly onShowMore: (groupKey: string) => void;
}) {
  const level = row.depth + 1;
  const indent = { marginLeft: INDENT * row.depth };
  if (row.kind === 'episode')
    return (
      <Pressable
        role="treeitem"
        aria-level={level}
        accessibilityLabel={`${row.part === undefined ? '' : `Part ${String(row.part)}: `}${row.title}${row.unavailable ? ', no longer available' : ''}${row.here ? ', you are here' : ''}`}
        onPress={() => onOpenEpisode(row.assetId)}
        style={[styles.line, styles.episode, row.here ? styles.hereEdge : null]}
      >
        {row.part === undefined ? null : (
          <Text variant="ui" style={styles.number}>
            {row.part}
          </Text>
        )}
        <Text variant="ui" numberOfLines={2} style={styles.grow}>
          {row.title}
        </Text>
        {row.here ? <YouBadge /> : null}
      </Pressable>
    );
  if (row.kind === 'more')
    return (
      <Pressable
        role="button"
        aria-level={level}
        accessibilityLabel={`${String(row.hidden)} more from ${row.parentTitle}. Show`}
        onPress={() => onShowMore(row.groupKey)}
        style={[styles.line, styles.more, indent]}
      >
        <Text variant="uiS" style={styles.grow} numberOfLines={1}>
          More from {row.parentTitle}
        </Text>
        <Text variant="ui">Show</Text>
      </Pressable>
    );
  if (row.kind === 'suggestion')
    return (
      <Pressable
        role="treeitem"
        aria-level={level}
        accessibilityLabel={`Suggestion, not made: ${row.title}`}
        onPress={() => onOpenOffer(row.draftId, row.optionId)}
        style={[styles.line, styles.suggestion, indent]}
      >
        <View style={styles.grow}>
          <Text variant="monoXs" color={content.ink2}>
            SUGGESTION · NOT MADE
          </Text>
          <Text variant="bodyS" color={content.ink2}>
            {row.title}
          </Text>
        </View>
      </Pressable>
    );
  const notes = notesOf(row);
  const perspective = row.branchKind === 'perspective';
  const removed = row.status === 'removed';
  // A removed branch's title is gone from the map; it is only named as removed.
  const name = removed ? row.title : kindedTitle({ kind: row.branchKind, title: row.title });
  return (
    <Pressable
      role="treeitem"
      aria-level={level}
      aria-disabled={!row.openable}
      accessibilityLabel={`${name}${notes.map((note) => `, ${note}`).join('')}${row.here ? ', you are here' : ''}`}
      disabled={!row.openable}
      onPress={() => onOpenBranch(row.nodeId)}
      style={[
        styles.line,
        indent,
        removed ? styles.removed : perspective && !row.hypothetical ? styles.perspective : styles.whatIf,
        row.here ? styles.hereEdge : null,
      ]}
    >
      {removed || perspective ? null : <Icon name="hypothetical" size={16} color={status.hypothetical.foreground} />}
      <View style={styles.grow}>
        <Text variant="ui" color={removed ? content.ink2 : content.ink} numberOfLines={2}>
          {row.title}
        </Text>
        {notes.map((note) => (
          <Text key={note} variant="meta" color={status.hypothetical.foreground}>
            {note}
          </Text>
        ))}
      </View>
      {perspective ? (
        <Text variant="monoXs" color={content.ink2}>
          PERSPECTIVE
        </Text>
      ) : null}
      {row.here ? <YouBadge /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 48,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  grow: { flex: 1 },
  number: { minWidth: 18 },
  episode: {},
  whatIf: {
    borderStyle: 'dashed',
    borderColor: status.hypothetical.edge,
    backgroundColor: status.hypothetical.background,
  },
  perspective: {},
  removed: { borderStyle: 'dashed', borderColor: content.muted, backgroundColor: content.paper2 },
  suggestion: { borderStyle: 'dashed', borderColor: content.muted, backgroundColor: content.paper2 },
  more: { borderStyle: 'dashed' },
  /** Where the member is: the yellow ring of the artboard, around the line and never on someone else's. */
  hereEdge: { boxShadow: `0 0 0 3px ${content.continue}` },
  you: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing['0.5'],
    borderRadius: radius.tag,
    backgroundColor: content.ink,
  },
});
