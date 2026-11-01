import { useIsFocused } from 'expo-router';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import {
  clockMs,
  positionWords,
  syncSeekSeconds,
  watchPhaseNow,
  watchingLine,
  type AccountScope,
  type RoomWatchController,
  type RoomWatchState,
} from '@knowscroll/client-core';
import type { WatchSessionView } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, IconButton, Skeleton, Text, type ReelControls, type ReelPlaybackView } from '@knowscroll/ui';
import { useDevicePreferences } from '../../providers/device-preferences';
import { ActivatedReelView } from '../reel/activated-reel-view';
import { useReelExposure, type ReelExposure } from '../threads/reel-encounter';
import { steadyClock, useSteadyNow } from './use-launch';

/** After the player is moved to the shared clock, it is left alone this long, so a slow seek is never chased. */
const SEEK_COOLDOWN_MS = 3_000;
/** The ink of the stage at four fifths, behind words that sit over a picture. */
const SCRIM = 'rgba(17, 17, 17, 0.8)';
/** The stage takes this share of a phone's height (R3 A2 draws it over a third of the screen), within these bounds. */
const STAGE_SHARE = 0.42;
const STAGE_MIN = 260;
const STAGE_MAX = 380;

const sharedBy = (session: WatchSessionView): string =>
  session.sharedBy === undefined ? 'REEL · TOGETHER' : `REEL · SHARED BY ${session.sharedBy.displayName.toUpperCase()}`;

/** Words for a command that did not go through, and for a connection that dropped: the stage keeps counting meanwhile. */
function Notices({ state }: { readonly state: RoomWatchState }) {
  return (
    <>
      {state.recordingPaused || state.notSaved === 'recording_paused' ? (
        <Banner
          kind="recordingPaused"
          lead="Recording is paused."
          message="Joining a Reel together is kept in the room, so it can’t be joined while recording is paused. Turn recording back on in Privacy to join."
          testID="watch-paused"
        />
      ) : state.notSaved === 'recording_generation_stale' ? (
        <Banner
          kind="error"
          lead="Couldn’t join."
          message="Your recording setting changed on another device."
          testID="watch-stale"
        />
      ) : null}
      {state.refused ? (
        <Banner
          kind="error"
          lead="Too late for that."
          message="The Reel has moved on. Here is how the stage stands now."
        />
      ) : null}
      {state.offline ? (
        <Banner
          kind="offline"
          lead="Reconnecting…"
          message="The Reel keeps time without the connection. The stage catches up when you’re back."
          testID="watch-offline"
        />
      ) : null}
    </>
  );
}

/** The member who shared the session, or a moderator, ends it for everyone: a small button at the top right, out of the way of Leave stage. */
function EndForEveryone({
  session,
  state,
  controller,
}: {
  readonly session: WatchSessionView;
  readonly state: RoomWatchState;
  readonly controller: RoomWatchController;
}) {
  if (!session.canStop) return null;
  return (
    <Button
      label="End for everyone"
      variant="spaceGhost"
      size="sm"
      surface="dark"
      disabled={state.working}
      onPress={() => void controller.stop()}
      testID="watch-stop"
    />
  );
}

/** What is said to someone who has not joined: what is playing, the count from three, and a Join that is only ever theirs to press. */
function Invitation({
  session,
  state,
  controller,
  line,
}: {
  readonly session: WatchSessionView;
  readonly state: RoomWatchState;
  readonly controller: RoomWatchController;
  readonly line: string;
}) {
  const count = watchingLine(session);
  return (
    <View style={styles.fill} testID="watch-invitation">
      <View style={styles.topRow}>
        <Text variant="monoXs" color={content.paper} style={styles.label}>
          {sharedBy(session)}
        </Text>
        <EndForEveryone session={session} state={state} controller={controller} />
      </View>
      <View style={styles.spacer} />
      <Text variant="title" heading={2} color={content.paper} testID="watch-title">
        {session.reel.title}
      </Text>
      <Text variant="metaS" color={content.paper} testID="watch-line">
        {line}
      </Text>
      {count === undefined ? null : (
        <Text variant="label" color={content.continue} testID="watch-count">
          {count}
        </Text>
      )}
      <View style={styles.row}>
        <Button
          label="Join"
          variant="spacePrimary"
          surface="dark"
          icon="play"
          disabled={state.working || state.recordingPaused}
          onPress={() => void controller.join()}
          testID="watch-join"
        />
      </View>
    </View>
  );
}

/**
 * The chrome drawn over the picture once it plays (R3 A2): who shared it, the title, the line "0:41 / 1:10 · synced for everyone", a thin
 * bar, Pause, sound, who is watching (from three) and Leave stage. The player follows the shared clock: when it has drifted more than a
 * second and a half it is moved to it, and a person who paused comes back to where the room is when they press Play. The line and the bar
 * are the clock's, never a position of anyone's; the device compares its own player with the clock and tells no one.
 */
function Chrome({
  session,
  state,
  controller,
  playback,
  controls,
  line,
  shared,
}: {
  readonly session: WatchSessionView;
  readonly state: RoomWatchState;
  readonly controller: RoomWatchController;
  readonly playback: ReelPlaybackView;
  readonly controls: RefObject<ReelControls | null>;
  readonly line: string;
  readonly shared: number;
}) {
  const lastSeek = useRef(-SEEK_COOLDOWN_MS);
  const { playing, positionMs } = playback;
  useEffect(() => {
    if (!playing) return;
    const seconds = syncSeekSeconds(positionMs, clockMs(session, steadyClock() - state.receivedAt));
    if (seconds === undefined || steadyClock() - lastSeek.current < SEEK_COOLDOWN_MS) return;
    lastSeek.current = steadyClock();
    controls.current?.seekBy(seconds);
  }, [playing, positionMs, session, state.receivedAt, controls]);
  const count = watchingLine(session);
  const share = Math.max(0, Math.min(1, shared / session.reel.durationMs));
  return (
    <View style={styles.chrome} pointerEvents="box-none">
      <View style={styles.top} pointerEvents="box-none">
        <Text variant="monoXs" color={content.paper} style={styles.label}>
          {sharedBy(session)}
        </Text>
        <EndForEveryone session={session} state={state} controller={controller} />
      </View>
      <View style={styles.spacer} pointerEvents="none" />
      {/* The words sit on a dark panel, so they read over any picture. */}
      <View style={styles.scrim} pointerEvents="box-none">
        <Text variant="title" heading={2} color={content.paper} testID="watch-title">
          {session.reel.title}
        </Text>
        <View accessible accessibilityRole="progressbar" accessibilityLabel={line} style={styles.bar}>
          <View style={[styles.barFill, { width: `${String(Math.round(share * 100))}%` }]} />
        </View>
        <Text variant="metaS" color={content.paper} testID="watch-line">
          {line}
        </Text>
        <View style={styles.row} pointerEvents="box-none">
          <IconButton
            icon={playback.playing ? 'pause' : 'play'}
            label={playback.playing ? 'Pause' : 'Play'}
            variant="onMedia"
            size={44}
            onPress={() => controls.current?.toggle()}
            testID="watch-toggle"
          />
          <IconButton
            icon={playback.muted ? 'volumeOff' : 'volume'}
            label={playback.muted ? 'Unmute' : 'Mute'}
            variant="onMedia"
            size={44}
            pressed={playback.muted}
            onPress={playback.toggleMuted}
          />
          {count === undefined ? null : (
            <Text variant="label" color={content.continue} testID="watch-count">
              {count}
            </Text>
          )}
          <View style={styles.spacer} pointerEvents="none" />
          <Button
            label="Leave stage"
            variant="spaceGhost"
            surface="dark"
            disabled={state.working}
            onPress={() => void controller.leave()}
            testID="watch-leave"
          />
        </View>
      </View>
    </View>
  );
}

/** Before the first frame and after the last: the stage says so in words and keeps the person's place on it. */
function Waiting({
  session,
  state,
  controller,
  heading,
  body,
  testID,
}: {
  readonly session: WatchSessionView;
  readonly state: RoomWatchState;
  readonly controller: RoomWatchController;
  readonly heading: string;
  readonly body: string;
  readonly testID: string;
}) {
  return (
    <View style={styles.fill} testID={testID}>
      <Text variant="monoXs" color={content.paper}>
        {sharedBy(session)}
      </Text>
      <View style={styles.spacer} />
      <View accessibilityLiveRegion="polite" aria-live="polite">
        <Text variant="title" heading={2} color={content.paper} testID="watch-title">
          {heading}
        </Text>
      </View>
      <Text variant="metaS" color={content.paper} testID="watch-line">
        {body}
      </Text>
      <View style={styles.row}>
        <Button
          label="Leave stage"
          variant="spaceGhost"
          surface="dark"
          disabled={state.working}
          onPress={() => void controller.leave()}
          testID="watch-leave"
        />
      </View>
    </View>
  );
}

/**
 * The stage of a person who joined. It opens the Reel as an ordinary encounter of their own (the same open, grant and activation as
 * any Reel, with the same recorder), only now, because they joined; leaving unmounts it, so a Reel watched again is a new encounter and
 * nothing is left open. It plays from the shared clock and moves to it when it drifts. Mounted only while this device joined (`joinedHere`).
 */
function JoinedStage({
  scope,
  session,
  state,
  controller,
}: {
  readonly scope: AccountScope;
  readonly session: WatchSessionView;
  readonly state: RoomWatchState;
  readonly controller: RoomWatchController;
}) {
  const { state: opened, start } = useReelExposure(scope, session.reel.assetId);
  const focused = useIsFocused();
  const now = useSteadyNow(true);
  const since = now - state.receivedAt;
  const phase = watchPhaseNow(session, since);
  const line = positionWords(session, since);
  // Opening the Reel is the person's own encounter beginning; it is asked for once, by their joining, and never again by a re-render.
  const began = useRef(false);
  useEffect(() => {
    if (began.current) return;
    began.current = true;
    start();
  }, [start]);
  if (opened.status === 'unavailable')
    return (
      <Waiting
        session={session}
        state={state}
        controller={controller}
        heading="This Reel isn’t available"
        body="Check your connection, then join again."
        testID="watch-unavailable"
      />
    );
  if (phase === 'over')
    return (
      <Waiting
        session={session}
        state={state}
        controller={controller}
        heading="That’s the Reel."
        body="Back to the conversation."
        testID="watch-ended"
      />
    );
  if (phase === 'starting')
    return (
      <Waiting
        session={session}
        state={state}
        controller={controller}
        heading={line}
        body={opened.status === 'ready' ? 'You’re in. It starts for everyone together.' : 'Opening the Reel…'}
        testID="watch-starting"
      />
    );
  if (opened.status !== 'ready')
    return (
      <View style={styles.fill} testID="watch-opening">
        <Skeleton rows={2} label="Opening the Reel" />
      </View>
    );
  return (
    <Player
      scope={scope}
      session={session}
      state={state}
      controller={controller}
      exposure={opened.exposure}
      focused={focused}
      line={line}
      shared={clockMs(session, since)}
    />
  );
}

/**
 * The picture, mounted once the Reel is open and the first frame is due. It starts where the clock says it is at that moment, and every
 * later correction is a seek by `Chrome`. It plays on because the person joined; a Reel that cannot play on its own (a browser that
 * wants a tap first) shows Play, which is the stage's one control.
 */
function Player({
  scope,
  session,
  state,
  controller,
  exposure,
  focused,
  line,
  shared,
}: {
  readonly scope: AccountScope;
  readonly session: WatchSessionView;
  readonly state: RoomWatchState;
  readonly controller: RoomWatchController;
  readonly exposure: ReelExposure;
  readonly focused: boolean;
  readonly line: string;
  readonly shared: number;
}) {
  const { preferences } = useDevicePreferences();
  const controlsRef = useRef<ReelControls>(null);
  const [startAt] = useState(() => Math.max(0, shared));
  return (
    <ActivatedReelView
      scope={scope}
      exposureId={exposure.exposureId}
      document={exposure.document}
      recorder={exposure.recorder}
      active={focused}
      initialPositionMs={startAt}
      initialPlaying
      initialMuted={!preferences.reelSound}
      controls={{ tapToToggle: false, controlsRef }}
    >
      {(playback) => (
        <Chrome
          session={session}
          state={state}
          controller={controller}
          playback={playback}
          controls={controlsRef}
          line={line}
          shared={shared}
        />
      )}
    </ActivatedReelView>
  );
}

/**
 * Watch together on the room's stage (R3 A2 "Stage first"): a Reel the room watches on one clock, above General, which goes on below as
 * the crowd. Someone who has not joined **on this device** sees what is playing and a Join (a second device of the same person, or a room
 * reopened while their place still stands, shows Join again and opens nothing); someone who joined here sees the Reel, from where the room is. The
 * server holds only the Reel and when it began; every position here is worked out on this device from the server's clock counted by a
 * steady clock, and "N watching" appears only from three people who joined. Nothing says who is watching or where anyone is.
 */
export function WatchStage({
  scope,
  session,
  state,
  controller,
}: {
  readonly scope: AccountScope;
  readonly session: WatchSessionView;
  readonly state: RoomWatchState;
  readonly controller: RoomWatchController;
}) {
  const { height, width } = useWindowDimensions();
  // The Reel is opened on this device only when this device's own Join was accepted, not because the server says the person is in.
  const joinedHere = session.youIn && state.joinedHere.includes(session.sessionId);
  const now = useSteadyNow(!joinedHere);
  const since = now - state.receivedAt;
  const stageHeight = Math.round(Math.max(STAGE_MIN, Math.min(STAGE_MAX, height * STAGE_SHARE)));
  const wide = width >= layout.measureDesktop + spacing[8];
  return (
    <View style={wide ? styles.outer : styles.outerFlush}>
      <View
        style={[wide ? styles.stage : styles.stageFlush, { height: wide ? STAGE_MAX - 40 : stageHeight }]}
        testID="watch-stage"
        role="region"
        accessibilityLabel="A Reel watched together"
      >
        {joinedHere ? (
          <JoinedStage key={session.sessionId} scope={scope} session={session} state={state} controller={controller} />
        ) : (
          <Invitation session={session} state={state} controller={controller} line={positionWords(session, since)} />
        )}
      </View>
      <View style={wide ? undefined : styles.notices}>
        <Notices state={state} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The stage keeps the reading measure, centred, on wide screens.
  outer: { alignItems: 'center', gap: spacing[2], paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
  // On a phone the stage runs edge to edge under the band, as R3 A2 draws it.
  outerFlush: { gap: spacing[2] },
  notices: { gap: spacing[2], paddingHorizontal: spacing[4] },
  stageFlush: { width: '100%', overflow: 'hidden', backgroundColor: content.ink },
  stage: {
    width: '100%',
    maxWidth: layout.measureDesktop,
    overflow: 'hidden',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.lg,
    backgroundColor: content.ink,
  },
  fill: { flex: 1, gap: spacing[2], padding: spacing[4] },
  chrome: { ...StyleSheet.absoluteFill },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
    padding: spacing[3],
  },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
  label: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing['0.5'],
    borderRadius: radius.pill,
    backgroundColor: SCRIM,
  },
  scrim: { gap: spacing[2], padding: spacing[4], backgroundColor: SCRIM },
  spacer: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
  // A cream track at a third of its strength on the ink stage, so the bar reads without a second colour.
  bar: { height: 4, borderRadius: radius.pill, backgroundColor: 'rgba(255, 251, 240, 0.35)' },
  barFill: { height: 4, borderRadius: radius.pill, backgroundColor: content.continue },
});
