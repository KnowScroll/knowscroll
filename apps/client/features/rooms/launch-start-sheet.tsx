import { StyleSheet, View } from 'react-native';
import { LAUNCH_ANSWER_SECONDS, LAUNCH_QUESTIONS, type LaunchHost, type RoomLaunch } from '@knowscroll/contracts';
import { START_BLOCK_WORDS, type RoomLaunchState } from '@knowscroll/client-core';
import { content, spacing } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';

type Ready = Extract<RoomLaunch, { status: 'ready' }>;

/**
 * Start a Launch (R3 E): what it is in a few words, who hosts it, and whether it can start now; if not, why not, from the server's
 * own reason. Nothing starts without this tap, and nobody is put in a Launch they did not choose: the starter is in, and the rest
 * of the room is asked to join. While recording is paused it says so here, since a Launch keeps each answer (D-220).
 */
export function LaunchStartSheet({
  visible,
  host,
  view,
  state,
  onStart,
  onClose,
}: {
  readonly visible: boolean;
  readonly host: LaunchHost;
  readonly view: Ready | undefined;
  readonly state: RoomLaunchState;
  readonly onStart: () => void;
  readonly onClose: () => void;
}) {
  const start = view?.start;
  const blocked = start?.allowed === false ? START_BLOCK_WORDS[start.reason] : undefined;
  return (
    <BottomSheet visible={visible} title="Start a Launch" onClose={onClose} testID="launch-start-sheet">
      <View style={styles.body}>
        <View style={styles.host}>
          <Text variant="ui">{host.name}</Text>
          <AiLabel label={host.label} />
        </View>
        <Text variant="bodyS">
          {`${String(LAUNCH_QUESTIONS)} questions from the Scrolls this room is about, ${String(LAUNCH_ANSWER_SECONDS)} seconds each. It starts 20 seconds after you press Start, and anyone in the room can join. ${host.name} hosts; no one is picked for you.`}
        </Text>
        <Text variant="metaS" color={content.ink2}>
          The room earns a star when two people play. The podium is for this Launch only.
        </Text>
        {blocked === undefined ? null : (
          <Banner kind="info" lead="Not just yet." message={blocked} testID="launch-start-blocked" />
        )}
        {state.notSaved === 'recording_paused' ? (
          <Banner
            kind="recordingPaused"
            lead="Recording is paused."
            message="A Launch keeps your answers, so it can’t be played while recording is paused. Turn recording back on in Privacy to start one."
            testID="launch-start-paused"
          />
        ) : null}
        {state.refused ? (
          <Banner
            kind="error"
            lead="Couldn’t start it."
            message="Something changed. Here is how the room stands now."
          />
        ) : null}
        <Button
          label="Start the Launch"
          variant="primary"
          disabled={start?.allowed !== true || state.working}
          onPress={onStart}
          testID="launch-start"
        />
        <Button label="Not now" variant="ghost" onPress={onClose} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  host: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
});
