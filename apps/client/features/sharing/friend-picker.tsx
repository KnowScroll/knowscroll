import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import type { AvailabilityWord, ShareState, ShareTarget } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing, target as targetSize } from '@knowscroll/design-tokens';
import { Banner, Icon, Text, useFocusRing, useTypeStyle } from '@knowscroll/ui';
import { PersonAvatar } from '../conversations/person-avatar';
import { PersonLine } from './person-line';
import { GroupLabel } from './step-header';

function TargetRow({
  entry,
  word,
  selected,
  disabled,
  onSelect,
}: {
  readonly entry: ShareTarget;
  readonly word: AvailabilityWord | undefined;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      role="radio"
      aria-checked={selected}
      accessibilityLabel={entry.person.displayName}
      disabled={disabled}
      onPress={onSelect}
      style={[styles.target, focus.style]}
    >
      <PersonAvatar person={entry.person} size={40} />
      <View style={styles.targetText}>
        <Text variant="ui" numberOfLines={1}>
          {entry.person.displayName}
        </Text>
        <PersonLine handle={entry.person.handle} word={word} />
      </View>
      <View style={[styles.radio, selected ? styles.radioOn : null]}>
        {selected ? <Icon name="check" size={14} color={content.onAccent} /> : null}
      </View>
    </Pressable>
  );
}

/** What loading the friends is doing: waiting, failed, or nobody to send to. */
function TargetsNotice({ targets }: { targets: ShareState['targets'] }) {
  if (targets.status === 'loading' && targets.items.length === 0)
    return (
      <Text variant="meta" color={content.ink2}>
        Loading your friends…
      </Text>
    );
  if (targets.status === 'failed')
    return <Banner kind="error" lead="Couldn’t load your friends." message="Check your connection and try again." />;
  if (targets.status === 'ready' && targets.items.length === 0)
    return (
      <Text variant="bodyS">
        You haven’t got any friends here yet. Invite a friend from Talk, then share this with them.
      </Text>
    );
  return null;
}

export interface FriendPickerProps {
  readonly targets: ShareState['targets'];
  readonly selected: string | undefined;
  /** True while a send is in flight or its outcome is known: the choice cannot change. */
  readonly locked: boolean;
  readonly onSelect: (personId: string) => void;
  /** Availability words, only for friends who show one (the server decides who does). */
  readonly availabilityOf: (personId: string) => AvailabilityWord | undefined;
}

/**
 * The single-choice list of friends to send to: a search box, people you already talk to under
 * "Recent", then the other friends.
 */
export function FriendPicker({ targets, selected, locked, onSelect, availabilityOf }: FriendPickerProps) {
  const [query, setQuery] = useState('');
  const searchType = useTypeStyle('bodyS');
  const needle = query.trim().toLowerCase();
  const visible = targets.items.filter((entry) =>
    `${entry.person.displayName} ${entry.person.handle}`.toLowerCase().includes(needle),
  );
  const recent = visible.filter((entry) => entry.conversation !== undefined);
  const others = visible.filter((entry) => entry.conversation === undefined);
  const group = (label: string, entries: readonly ShareTarget[]) =>
    entries.length === 0 ? null : (
      <View style={styles.group}>
        <GroupLabel>{label}</GroupLabel>
        <View role="radiogroup" accessibilityLabel={label} style={styles.targets}>
          {entries.map((entry) => (
            <TargetRow
              key={entry.person.personId}
              entry={entry}
              word={availabilityOf(entry.person.personId)}
              selected={entry.person.personId === selected}
              disabled={locked}
              onSelect={() => onSelect(entry.person.personId)}
            />
          ))}
        </View>
      </View>
    );
  return (
    <>
      <TargetsNotice targets={targets} />
      {targets.items.length === 0 ? null : (
        <TextInput
          accessibilityLabel="Search friends"
          placeholder="Search friends by name or @handle"
          placeholderTextColor={content.ink2}
          value={query}
          onChangeText={setQuery}
          allowFontScaling={false}
          style={[
            styles.input,
            { fontFamily: searchType.fontFamily, fontSize: searchType.fontSize, lineHeight: searchType.lineHeight },
          ]}
        />
      )}
      {group('Recent', recent)}
      {group(recent.length === 0 ? 'Friends' : 'More friends', others)}
    </>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing[1] },
  targets: { gap: spacing[1] },
  target: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: targetSize.comfortable,
    paddingVertical: spacing[2],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
  },
  targetText: { flex: 1, gap: spacing[0.5] },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { backgroundColor: content.accent },
  input: {
    minHeight: 48,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    color: content.ink,
    backgroundColor: content.paper,
  },
});
