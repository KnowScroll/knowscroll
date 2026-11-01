import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  WATCH_START_BLOCK_WORDS,
  clockWords,
  lastOnStageWords,
  type RoomWatchController,
  type RoomWatchState,
} from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Button, Skeleton, Text } from '@knowscroll/ui';

/**
 * The room's stage when nothing is on it (R3 A2 "Nothing live"): it says so, says what was last on the stage, and offers what can go on
 * it: a Reel to watch together, from the Reels the room's topic rests on, or a quiz. It is a sheet from the Now strip, so a room with
 * nothing on its stage keeps the whole screen for the conversation (D-140). Nothing starts without a tap, and a Reel offered here is a
 * library Reel: the room never makes one up. While recording is paused it says so before any tap, since joining is kept in the room (D-258).
 */
export function WatchSheet({
  visible,
  state,
  controller,
  canStartQuiz,
  onStartQuiz,
  onClose,
}: {
  readonly visible: boolean;
  readonly state: RoomWatchState;
  readonly controller: RoomWatchController;
  /** A Launch can be started from here: the room's deck is ready and its stage is free. */
  readonly canStartQuiz: boolean;
  readonly onStartQuiz: () => void;
  readonly onClose: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="On stage" onClose={onClose} testID="watch-sheet">
      <SheetBody
        state={state}
        controller={controller}
        canStartQuiz={canStartQuiz}
        onStartQuiz={onStartQuiz}
        onClose={onClose}
      />
    </BottomSheet>
  );
}

/** The sheet's content, mounted only while the sheet is open, so each opening starts from "Nothing on stage right now". */
function SheetBody({
  state,
  controller,
  canStartQuiz,
  onStartQuiz,
  onClose,
}: {
  readonly state: RoomWatchState;
  readonly controller: RoomWatchController;
  readonly canStartQuiz: boolean;
  readonly onStartQuiz: () => void;
  readonly onClose: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const view = state.view;
  const start = view?.start;
  const blocked = start?.allowed === false ? WATCH_START_BLOCK_WORDS[start.reason] : undefined;
  const last = view === undefined ? undefined : lastOnStageWords(view.last, new Date());
  const pick = () => {
    setChoosing(true);
    void controller.loadReels();
  };
  return (
    <View style={styles.body}>
      <View style={styles.empty} testID="watch-nothing-live">
        <Text variant="title" heading={2}>
          Nothing on stage right now
        </Text>
        <Text variant="bodyS" color={content.ink2} testID="watch-last">
          {last ?? 'Nothing has been on this room’s stage yet.'}
        </Text>
      </View>
      {blocked === undefined ? null : (
        <Banner kind="info" lead="Not just yet." message={blocked} testID="watch-blocked" />
      )}
      {state.recordingPaused || state.notSaved === 'recording_paused' ? (
        <Banner
          kind="recordingPaused"
          lead="Recording is paused."
          message="Joining a Reel together is kept in the room, so it can’t be started while recording is paused. Turn recording back on in Privacy."
          testID="watch-sheet-paused"
        />
      ) : null}
      {state.refused ? (
        <Banner kind="error" lead="Couldn’t start it." message="Something changed. Here is how the room stands now." />
      ) : null}
      {choosing ? (
        <Reels state={state} controller={controller} disabled={start?.allowed !== true} onStarted={onClose} />
      ) : (
        <>
          <Button
            label="Watch a Reel together"
            variant="default"
            icon="play"
            disabled={start?.allowed !== true || state.recordingPaused}
            onPress={pick}
            testID="watch-choose"
          />
          {canStartQuiz ? (
            <Button label="Start a quiz" variant="default" onPress={onStartQuiz} testID="watch-quiz" />
          ) : null}
        </>
      )}
      <Button label="Not now" variant="ghost" onPress={onClose} />
    </View>
  );
}

/** The Reels the room's topic rests on, one tap each. The Reel starts for the room and the starter is in; everyone else is asked to join. */
function Reels({
  state,
  controller,
  disabled,
  onStarted,
}: {
  readonly state: RoomWatchState;
  readonly controller: RoomWatchController;
  readonly disabled: boolean;
  readonly onStarted: () => void;
}) {
  const reels = state.reels;
  if (state.reelsFailed && reels === undefined)
    return (
      <Banner
        kind="error"
        lead="Couldn’t load the Reels."
        message="Check your connection."
        action={{ label: 'Retry', onPress: () => void controller.loadReels() }}
      />
    );
  if (reels === undefined) return <Skeleton rows={3} label="Loading the Reels" />;
  if (reels.length === 0)
    return (
      <Text variant="bodyS" color={content.ink2} testID="watch-no-reels">
        This room has no Reel to watch together yet.
      </Text>
    );
  return (
    <View role="list" accessibilityLabel="Reels to watch together" style={styles.list} testID="watch-reels">
      {reels.map((reel) => (
        <View key={reel.assetId} role="listitem" style={styles.reel}>
          <View style={styles.reelText}>
            <Text variant="ui" numberOfLines={2}>
              {reel.title}
            </Text>
            <Text variant="metaS" color={content.ink2}>
              {`Reel · ${clockWords(reel.durationMs)}`}
            </Text>
          </View>
          <Button
            label="Watch"
            variant="primary"
            size="sm"
            icon="play"
            accessibilityLabel={`Watch ${reel.title} together`}
            disabled={disabled || state.working || state.recordingPaused}
            onPress={() => void controller.start(reel.assetId).then((began) => began && onStarted())}
            testID={`watch-reel-${reel.assetId}`}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  // The design draws the empty stage as a dashed card (R3 A2).
  empty: {
    gap: spacing[1],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    borderRadius: radius.lg,
  },
  list: { gap: spacing[2] },
  reel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.paper,
  },
  reelText: { flex: 1, gap: spacing['0.5'] },
});
