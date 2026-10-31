import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AccountScope, RoomController, RoomState } from '@knowscroll/client-core';
import { hereView } from '@knowscroll/client-core';
import type { RoomView } from '@knowscroll/contracts';
import { layout, space, spacing } from '@knowscroll/design-tokens';
import { Icon, IconButton, Text } from '@knowscroll/ui';
import { afterPendingBack } from '../../platform/after-pending-back';
import { AiNoticeCard } from './ai-notice';
import { AwayCard } from './away-card';
import { OpenDiscussion } from './discussion-screen';
import { HereStrip } from './here-strip';
import { discussionHref } from './room-links';
import { RoomMenu } from './room-menu';
import { RULE_WORDS } from './room-parts';
import { ShareIntoRoomSheet } from './share-into-room-sheet';

type Member = Extract<RoomView, { status: 'member' }>;

/**
 * The room's dark band (R3 A1 "Campfire"): Back, the room's name that opens the room menu, a line that names how
 * many are here only from three (never "0 online" or "1 online"), the faces of who has the room open and, when
 * nothing has been said for a while, the honest quiet pill.
 */
export function CampfireHeader({
  view,
  onBack,
  onMenu,
}: {
  readonly view: Member;
  readonly onBack: () => void;
  readonly onMenu: () => void;
}) {
  const count = hereView(view.here).countLabel;
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.band, { paddingTop: insets.top + spacing[2] }]} testID="campfire-header">
      <View style={styles.top}>
        <IconButton icon="back" label="Back" variant="onSpace" onPress={onBack} />
        <View role="heading" aria-level={1} style={styles.name}>
          <Pressable
            role="button"
            accessibilityLabel={`${view.room.name}, room menu`}
            onPress={onMenu}
            style={styles.nameButton}
            testID="room-menu-open"
          >
            <Text variant="title" color={space.label} numberOfLines={1}>
              {view.room.name}
            </Text>
            <Icon name="chevronDown" size={18} color={space.label} />
          </Pressable>
        </View>
        <IconButton icon="menu" label="Room menu" variant="onSpace" onPress={onMenu} />
      </View>
      <Text variant="monoXs" color={space.label2} testID="campfire-subline">
        {count === undefined ? RULE_WORDS[view.room.joinRule] : `A room · ${count}`}
      </Text>
      <HereStrip here={view.here} lastMessageAt={view.lastMessageAt} />
    </View>
  );
}

/**
 * A member's room on a phone: the campfire band, the AI notice until it has been read, and General, the room's
 * place to talk, under them. Everything else (about, guidelines, AI level, members, pins, topics, sharing, activity,
 * moderation, leaving) is behind the room's name.
 */
export function PhoneRoom({
  scope,
  view,
  controller,
  state,
  onBack,
}: {
  readonly scope: AccountScope;
  readonly view: Member;
  readonly controller: RoomController;
  readonly state: RoomState;
  readonly onBack: () => void;
}) {
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [sharing, setSharing] = useState(false);
  return (
    <View style={styles.stage} testID="room-screen">
      <GeneralStage
        scope={scope}
        view={view}
        controller={controller}
        state={state}
        header={<CampfireHeader view={view} onBack={onBack} onMenu={() => setMenu(true)} />}
      />
      <RoomMenu
        scope={scope}
        view={view}
        controller={controller}
        state={state}
        visible={menu}
        onClose={() => setMenu(false)}
        onShare={() => setSharing(true)}
      />
      <ShareIntoRoomSheet
        scope={scope}
        visible={sharing}
        working={state.working}
        onClose={() => setSharing(false)}
        onStart={(start) =>
          void controller.startDiscussion(start).then((discussionId) => {
            if (discussionId === undefined) return;
            // The sheet's close is a Back on the web; navigate once it has landed, or it would undo the push.
            setSharing(false);
            afterPendingBack(() => router.push(discussionHref(view.room.roomId, discussionId)));
          })
        }
      />
    </View>
  );
}

/**
 * General under whatever stands above it (the campfire band on a phone, nothing beside D04's rail). The AI notice
 * is shown here once, until the member says they have read it; afterwards the same words are in the room menu.
 */
export function GeneralStage({
  scope,
  view,
  controller,
  state,
  header,
}: {
  readonly scope: AccountScope;
  readonly view: Member;
  readonly controller: RoomController;
  readonly state: RoomState;
  readonly header: ReactNode;
}) {
  return (
    <View style={styles.stage}>
      {header}
      {view.you.noticeSeenAt === undefined ? (
        <AiNoticeCard
          busy={state.working}
          welcome={view.welcome}
          onAcknowledge={() => void controller.setPreferences({ noticeSeen: true })}
        />
      ) : null}
      {view.away === undefined ? null : (
        <AwayCard
          away={view.away}
          now={new Date()}
          busy={state.working}
          onDismiss={() => void controller.dismissAway()}
        />
      )}
      <OpenDiscussion
        key={view.general.discussionId}
        scope={scope}
        roomId={view.room.roomId}
        discussionId={view.general.discussionId}
        header={null}
        topics={view.discussions}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1 },
  band: {
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing[3],
    backgroundColor: space.s0,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  name: { flex: 1 },
  nameButton: { flexDirection: 'row', alignItems: 'center', gap: spacing[1], minHeight: 48 },
});
