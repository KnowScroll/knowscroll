import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AccountScope, RoomController, RoomState } from '@knowscroll/client-core';
import { hereView, launchStripOf } from '@knowscroll/client-core';
import type { RoomView } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing, status } from '@knowscroll/design-tokens';
import { Icon, IconButton, Text } from '@knowscroll/ui';
import { afterPendingBack } from '../../platform/after-pending-back';
import { AiNoticeCard } from './ai-notice';
import { RoomEmblem } from './identity/room-emblem';
import { RoomBand } from './identity/room-band';
import { AwayCard } from './away-card';
import { OpenDiscussion } from './discussion-screen';
import { HereStrip } from './here-strip';
import { LaunchPodium } from './launch-podium';
import { LaunchStage } from './launch-stage';
import { LaunchStartSheet } from './launch-start-sheet';
import { NowStrip } from './now-strip';
import { discussionHref } from './room-links';
import { RoomMenu } from './room-menu';
import { RULE_WORDS } from './room-parts';
import { ShareIntoRoomSheet } from './share-into-room-sheet';
import { useRoomLaunch } from './use-launch';

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
  const { identity } = view.room;
  return (
    <RoomBand
      identity={identity}
      style={[styles.band, { paddingTop: insets.top + spacing[2] }]}
      testID="campfire-header"
    >
      {(tone) => (
        <>
          <View style={styles.top}>
            <IconButton icon="back" label="Back" variant="onSpace" onPress={onBack} />
            {identity === undefined ? null : <RoomEmblem kit={identity.kit} size={36} testID="room-emblem" />}
            <View role="heading" aria-level={1} style={styles.name}>
              <Pressable
                role="button"
                accessibilityLabel={`${view.room.name}, room menu`}
                onPress={onMenu}
                style={styles.nameButton}
                testID="room-menu-open"
              >
                <Text variant="title" color={tone.ink} numberOfLines={1}>
                  {view.room.name}
                </Text>
                <Icon name="chevronDown" size={18} color={tone.ink} />
              </Pressable>
            </View>
            <IconButton icon="menu" label="Room menu" variant="onSpace" onPress={onMenu} />
          </View>
          <View style={styles.subline}>
            <Text variant="monoXs" color={tone.inkSoft} testID="campfire-subline">
              {count === undefined ? RULE_WORDS[view.room.joinRule] : `A room · ${count}`}
            </Text>
            {view.launch?.state === 'lobby' || view.launch?.state === 'live' ? (
              <View style={styles.live} accessible accessibilityLabel="A Launch is live" testID="band-live">
                <Text variant="monoXs" color={content.paper}>
                  LIVE · LAUNCH
                </Text>
              </View>
            ) : null}
          </View>
          <HereStrip here={view.here} lastMessageAt={view.lastMessageAt} />
        </>
      )}
    </RoomBand>
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
  const roomId = view.room.roomId;
  // The Launch is read only while the room says there is one to read: a room with no deck and no Launch asks nothing.
  const { controller: launchController, state: launchState } = useRoomLaunch(scope, roomId, view.launch !== undefined);
  const launch = launchState.view?.launch;
  const [starting, setStarting] = useState(false);
  const [podiumFor, setPodiumFor] = useState<string>();
  const sawLive = useRef(new Set<string>());
  // The podium opens by itself only for a person who watched this Launch go by: coming back to a room hours later does not.
  useEffect(() => {
    if (launch === undefined) return;
    if (launch.phase !== 'finished') sawLive.current.add(launch.launchId);
    else if (launch.youIn && sawLive.current.has(launch.launchId)) {
      sawLive.current.delete(launch.launchId);
      setPodiumFor(launch.launchId);
    }
  }, [launch]);
  const strip = launchStripOf(launch, view.launch);
  const onLaunch = () => {
    if (strip?.state === 'ready') {
      void launchController.load();
      setStarting(true);
    } else if (strip?.state === 'finished' && launch?.phase === 'finished') setPodiumFor(launch.launchId);
  };
  return (
    <View style={styles.stage}>
      {header}
      {launch === undefined || launch.phase === 'finished' || launchState.view === undefined ? null : (
        <LaunchStage launch={launch} host={launchState.view.host} state={launchState} controller={launchController} />
      )}
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
        // The Now strip stands first in the list, so it scrolls away with the conversation and the messages keep the screen (D-140).
        listHeader={
          <NowStrip
            scope={scope}
            roomId={roomId}
            today={view.today}
            sky={view.sky}
            launch={strip}
            feed={view.feed}
            onLaunch={onLaunch}
          />
        }
        startAtEnd
      />
      {launchState.view === undefined ? null : (
        <LaunchStartSheet
          visible={starting}
          host={launchState.view.host}
          view={launchState.view}
          state={launchState}
          onStart={() => void launchController.start().then((began) => began && setStarting(false))}
          onClose={() => setStarting(false)}
        />
      )}
      {launch?.phase !== 'finished' ? null : (
        <LaunchPodium
          scope={scope}
          launch={launch}
          roomId={roomId}
          roomName={view.room.name}
          generalId={view.general.discussionId}
          sky={view.sky}
          visible={podiumFor === launch.launchId}
          onClose={() => setPodiumFor(undefined)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1 },
  subline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
  live: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing['0.5'],
    borderRadius: radius.pill,
    borderWidth: borderWidth.hairline,
    borderColor: content.paper,
    backgroundColor: status.danger.fill,
  },
  band: {
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing[3],
    overflow: 'hidden',
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  name: { flex: 1 },
  nameButton: { flexDirection: 'row', alignItems: 'center', gap: spacing[1], minHeight: 48 },
});
