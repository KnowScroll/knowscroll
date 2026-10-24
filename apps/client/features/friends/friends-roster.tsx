import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type {
  AvailabilityWord,
  FriendsGroups,
  FriendsPair,
  FriendsState,
  ShowMoreFilter,
} from '@knowscroll/client-core';
import { borderWidth, content, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, RowLink, Text, useFocusRing } from '@knowscroll/ui';
import { BlockedRow, FriendRow, IncomingCard, SentRow, type PairCommand } from './friend-rows';

export interface FriendsRosterProps {
  readonly groups: FriendsGroups;
  /** The state of the read that fills the lists: loading, failed, or ready. */
  readonly rosterStatus: FriendsState['roster']['status'];
  readonly canNext: boolean;
  readonly canPrevious: boolean;
  /** The lists with more than the first page; Show more adds the next page in place. */
  readonly moreOf: readonly ShowMoreFilter[];
  readonly onShowMore: (filter: ShowMoreFilter) => void;
  readonly disabled: boolean;
  readonly availabilityOf: (personId: string) => AvailabilityWord | undefined;
  readonly onCommand: PairCommand;
  readonly onVisit: (handle: string) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onRefresh: () => void;
}

function GroupLabel({ children }: { readonly children: string }) {
  return (
    <Text variant="monoXs" color={content.ink2} heading={3}>
      {children}
    </Text>
  );
}

/** "Blocked" stays folded until opened, as C01 draws it: it is a list nobody needs to look at often. */
function BlockedGroup({
  blocked,
  more,
  ...row
}: {
  readonly blocked: readonly FriendsPair[];
  /** Adds the next page of the list; absent when there is none. */
  readonly more: (() => void) | undefined;
  readonly disabled: boolean;
} & Pick<FriendsRosterProps, 'onCommand'>) {
  const [open, setOpen] = useState(false);
  const focus = useFocusRing('onLight');
  return (
    <View style={styles.group}>
      <Pressable
        {...focus.props}
        role="button"
        aria-expanded={open}
        accessibilityLabel="Blocked"
        onPress={() => setOpen(!open)}
        style={[styles.fold, focus.style]}
      >
        <View style={styles.foldText}>
          <Text variant="ui">Blocked</Text>
          <Text variant="meta" color={content.ink2}>
            People who can’t message or find you
          </Text>
        </View>
        <Icon name={open ? 'minus' : 'plus'} size={18} />
      </Pressable>
      {open ? (
        <>
          {blocked.length === 0 && more === undefined ? (
            <Text variant="meta" color={content.ink2}>
              You haven’t blocked anyone.
            </Text>
          ) : (
            <View role="list" accessibilityLabel="Blocked people">
              {blocked.map((pair) => (
                <BlockedRow key={pair.peer.personId} pair={pair} disabled={row.disabled} onCommand={row.onCommand} />
              ))}
            </View>
          )}
          {more === undefined ? null : (
            <Button label="Show more blocked" size="sm" variant="ghost" disabled={row.disabled} onPress={more} />
          )}
        </>
      ) : null}
    </View>
  );
}

/**
 * C01/F01's one list: Friends, then Waiting (people asking, and requests sent), then Blocked folded.
 * Every row's actions bind the page that was read, and nothing here guesses a person: an empty page
 * with more behind it says so and waits for an explicit Next.
 */
export function FriendsRoster(props: FriendsRosterProps) {
  const { groups, rosterStatus, disabled, onCommand, availabilityOf } = props;
  const friends = groups.friends;
  if (friends === undefined)
    return rosterStatus === 'unavailable' ? (
      <View style={styles.group}>
        <Banner
          kind="offline"
          lead="Your friends couldn’t be read."
          message="A failed read doesn’t mean you have none. Try again."
        />
        <Button label="Try again" variant="ghost" onPress={props.onRefresh} />
      </View>
    ) : (
      <Text variant="bodyS">Loading friends…</Text>
    );
  const incoming = groups.incoming ?? [];
  const sent = groups.outgoing ?? [];
  const waitingFilter = props.moreOf.find((filter) => filter === 'incoming' || filter === 'outgoing');
  const waitingMore = waitingFilter === undefined ? undefined : () => props.onShowMore(waitingFilter);
  const waiting = incoming.length + sent.length > 0 || waitingFilter !== undefined;
  const row = { disabled, onCommand };
  return (
    <View style={styles.stack}>
      {rosterStatus === 'unavailable' ? (
        <Banner kind="offline" lead="Some of this list is out of date." message="Try again to read it afresh." />
      ) : null}
      <View style={styles.group}>
        <GroupLabel>Friends</GroupLabel>
        {friends.length === 0 ? (
          <Text variant="bodyS" color={content.ink2}>
            {props.canNext
              ? 'No visible people in this part of the list. Show the next page.'
              : props.canPrevious
                ? 'No visible people on this last page.'
                : 'No friends yet. Add one by their handle, or share your invite link.'}
          </Text>
        ) : (
          <View role="list" accessibilityLabel="Friends">
            {friends.map((pair) => {
              const word = availabilityOf(pair.peer.personId);
              return (
                <FriendRow
                  key={pair.peer.personId}
                  pair={pair}
                  availability={word}
                  onVisit={() => props.onVisit(pair.peer.handle)}
                  {...row}
                />
              );
            })}
          </View>
        )}
        {props.canPrevious || props.canNext ? (
          <View style={styles.paging}>
            <Button
              label="Previous page"
              size="sm"
              variant="ghost"
              disabled={!props.canPrevious || disabled}
              onPress={props.onPrevious}
            />
            <Button
              label="Next page"
              size="sm"
              variant="ghost"
              disabled={!props.canNext || disabled}
              onPress={props.onNext}
            />
          </View>
        ) : null}
      </View>
      {waiting ? (
        <View style={styles.group}>
          <GroupLabel>Waiting</GroupLabel>
          <View role="list" accessibilityLabel="Waiting">
            {incoming.map((pair) => (
              <IncomingCard key={pair.peer.personId} pair={pair} {...row} />
            ))}
            {sent.map((pair) => (
              <SentRow key={pair.peer.personId} pair={pair} {...row} />
            ))}
          </View>
          {waitingMore === undefined ? null : (
            <Button label="Show more waiting" size="sm" variant="ghost" disabled={disabled} onPress={waitingMore} />
          )}
        </View>
      ) : null}
      <BlockedGroup
        blocked={groups.blocked ?? []}
        more={props.moreOf.includes('blocked') ? () => props.onShowMore('blocked') : undefined}
        {...row}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing[5] },
  group: { gap: spacing[2] },
  paging: { flexDirection: 'row', gap: spacing[3] },
  fold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[3],
    borderTopWidth: borderWidth.hairline,
    borderBottomWidth: borderWidth.hairline,
    borderColor: content.rule,
  },
  foldText: { flex: 1, gap: spacing[0.5] },
  link: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
});

/** The two quiet places Friends leads to: who may visit (F02) and the person's own public profile. */
export function FriendsLinks({
  profileLine,
  onOpenVisibility,
  onEditProfile,
}: {
  readonly profileLine: string;
  readonly onOpenVisibility: () => void;
  readonly onEditProfile: () => void;
}) {
  return (
    <View>
      <RowLink label="Who can visit your universe" href="/account/privacy/visibility" onPress={onOpenVisibility}>
        <View style={styles.link}>
          <View style={styles.foldText}>
            <Text variant="ui">Who can visit your universe</Text>
            <Text variant="meta" color={content.ink2}>
              Choose who can visit, and what they see
            </Text>
          </View>
          <Icon name="forward" size={18} />
        </View>
      </RowLink>
      <RowLink label="Your public profile" onPress={onEditProfile}>
        <View style={styles.link}>
          <View style={styles.foldText}>
            <Text variant="ui">Your public profile</Text>
            <Text variant="meta" color={content.ink2}>
              {profileLine}
            </Text>
          </View>
          <Icon name="forward" size={18} />
        </View>
      </RowLink>
    </View>
  );
}
