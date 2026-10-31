import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { useFocusRing } from '../../display/focus-ring';
import { Icon } from '../../icons/icon';
import { Text } from '../../text/text';
import { isSortRight, sortedItems, sortPlacedRight, type SortBlock } from '../model';
import { PlayChip } from '../stage-reader/play-chips';
import { frameStyles } from './frame';
import { moved, shownOrder, type Attempt } from './sort-state';

/** Where a person is with a sort: still ordering, told how close they are, in order, or shown the order. */
type Progress = 'ordering' | 'close' | 'right' | 'shown';

function MoveButton({
  direction,
  item,
  disabled,
  onPress,
}: {
  readonly direction: 'up' | 'down';
  readonly item: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`Move "${item}" ${direction}`}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={[styles.move, disabled ? styles.moveOff : null, focus.style]}
    >
      <Icon name={direction === 'up' ? 'arrowUp' : 'arrowDown'} size={18} />
    </Pressable>
  );
}

/**
 * A sort (D-207): put the items in order with the arrow buttons (each card has them, so it works by
 * keyboard, screen reader and finger alike), then check. The document holds the right order, so the check
 * is made on the device; nothing about the attempt is stored or reported (D-063, D-209). A wrong check says how
 * many cards stand in the right place and offers the order, never a score.
 */
export function SortBody({ sort, asText }: { readonly sort: SortBlock; readonly asText: boolean }) {
  const [attempt, setAttempt] = useState<Attempt>(() => shownOrder(sort.items.length));
  const [progress, setProgress] = useState<Progress>('ordering');
  const [placed, setPlaced] = useState(0);
  const [heard, setHeard] = useState('');
  const settled = progress === 'right' || progress === 'shown';
  const move = (place: number, by: -1 | 1) => {
    setAttempt(moved(attempt, place, by));
    setProgress('ordering');
    const item = sort.items[attempt[place] ?? 0] ?? '';
    setHeard(`${item} is now number ${String(place + by + 1)} of ${String(attempt.length)}.`);
  };
  const check = () => {
    if (isSortRight(sort, attempt)) setProgress('right');
    else {
      setPlaced(sortPlacedRight(sort, attempt));
      setProgress('close');
    }
  };
  const answer = sortedItems(sort);
  return (
    <View style={styles.body}>
      <Text variant="title" heading={3}>
        Put these in order
      </Text>
      {settled || asText ? (
        <View
          role="list"
          accessibilityLabel={settled ? 'The right order' : 'The items to put in order'}
          style={styles.list}
        >
          {(settled ? answer : attempt.map((index) => sort.items[index] ?? '')).map((item, place) => (
            <View key={item} role="listitem" style={styles.row} testID={settled ? 'sort-answer' : undefined}>
              {settled ? (
                <View style={styles.number} aria-hidden>
                  <Text variant="metaS">{String(place + 1)}</Text>
                </View>
              ) : null}
              <Text variant="ui" style={styles.rowText}>
                {settled ? item : `• ${item}`}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <View role="list" accessibilityLabel="Your order, first to last" style={styles.list}>
          {attempt.map((index, place) => {
            const item = sort.items[index] ?? '';
            return (
              <View key={index} role="listitem" style={styles.row} testID="sort-row">
                <View style={styles.number} aria-hidden>
                  <Text variant="metaS">{String(place + 1)}</Text>
                </View>
                <Text variant="ui" style={styles.rowText}>
                  {item}
                </Text>
                <MoveButton direction="up" item={item} disabled={place === 0} onPress={() => move(place, -1)} />
                <MoveButton
                  direction="down"
                  item={item}
                  disabled={place === attempt.length - 1}
                  onPress={() => move(place, 1)}
                />
              </View>
            );
          })}
        </View>
      )}
      <View accessibilityLiveRegion="polite" role="status" style={styles.status}>
        {progress === 'right' ? <PlayChip label="In order!" tone="called_it" testID="sort-right" /> : null}
        {progress === 'close' ? (
          <Text variant="meta" color={content.ink2} testID="sort-close">
            {`${String(placed)} of ${String(attempt.length)} are in the right place. Move them and check again.`}
          </Text>
        ) : null}
        {progress === 'ordering' && heard !== '' && !asText ? (
          <Text variant="meta" color={content.ink2}>
            {heard}
          </Text>
        ) : null}
      </View>
      {settled ? (
        <View style={frameStyles.note} testID="sort-explain">
          <Text variant="bodyS">{sort.explain}</Text>
        </View>
      ) : (
        <View style={styles.actions}>
          {asText ? null : <Button label="Check order" variant="primary" onPress={check} />}
          {asText || progress === 'close' ? (
            <Button label="Show the order" variant="default" onPress={() => setProgress('shown')} />
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  list: { gap: spacing[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 52,
    paddingVertical: spacing[1],
    paddingLeft: spacing[3],
    paddingRight: spacing[2],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  rowText: { flex: 1 },
  number: {
    width: 26,
    height: 26,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.continue,
  },
  move: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  moveOff: { opacity: 0.35 },
  status: { gap: spacing[1], alignItems: 'flex-start' },
  actions: { gap: spacing[2], alignItems: 'flex-start' },
});
