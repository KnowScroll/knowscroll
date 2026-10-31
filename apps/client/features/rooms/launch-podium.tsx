import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LaunchView, RoomSky } from '@knowscroll/contracts';
import { initialsOf, launchDayWords, launchShareText, squaresOf, type AccountScope } from '@knowscroll/client-core';
import { shareLaunchResult } from '@knowscroll/client-core';
import { borderWidth, content, elevation, overlay, radius, space, spacing, status } from '@knowscroll/design-tokens';
import { Banner, Button, Text, dialogHostSemantics, usePageInert } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { skySentence } from './sky-sheet';

type Finished = Extract<LaunchView, { phase: 'finished' }>;
type Entry = Finished['podium'][number];

const STEP_HEIGHT = { 1: 128, 2: 96, 3: 72 } as const;
const STEP_COLOUR = { 1: content.continue, 2: status.hypothetical.background, 3: content.paper } as const;
/** The order the steps stand in: second, first, third, as a podium is drawn. */
const STAND = [2, 1, 3] as const;

/** One step: who stands on it, their score, and the step itself, labelled by place so colour is never the only cue. */
function Step({ entry, place }: { readonly entry: Entry | undefined; readonly place: 1 | 2 | 3 }) {
  const name = entry === undefined ? undefined : entry.blockedByYou ? 'Someone you blocked' : entry.person!.displayName;
  return (
    <View
      style={styles.step}
      role="listitem"
      accessibilityLabel={
        entry === undefined
          ? undefined
          : `${placeWords(place)}, ${name!}${entry.you ? ', you' : ''}, ${String(entry.score)} of 5`
      }
      testID={`podium-step-${String(place)}`}
    >
      {entry === undefined ? null : (
        <>
          <View style={[styles.initial, entry.you ? styles.initialYou : null]} aria-hidden>
            <Text variant="label" color={content.ink}>
              {entry.blockedByYou ? '·' : initialsOf(entry.person!.displayName)}
            </Text>
          </View>
          <Text variant="metaS" color={space.label} numberOfLines={2} style={styles.stepName} aria-hidden>
            {`${entry.you ? 'You' : name!} · ${String(entry.score)}/5`}
          </Text>
        </>
      )}
      <View style={[styles.block, { height: STEP_HEIGHT[place], backgroundColor: STEP_COLOUR[place] }]} aria-hidden>
        <Text variant="displayL" color={content.ink}>
          {String(place)}
        </Text>
      </View>
    </View>
  );
}

const placeWords = (place: number): string => (place === 1 ? 'First' : place === 2 ? 'Second' : 'Third');

/**
 * Tonight's podium (R3 E): the top three of this one Launch, and nothing about any other night; a place without a name for a
 * person the reader blocked, so the order stays true; and, for someone who played, their own result as a share card of squares with
 * no question and no answer in it. The star the room earned is said in words with how the sky stands. No score is a total, a rank
 * across Launches or a level: it is gone after the day (D-178).
 */
export function LaunchPodium({
  scope,
  launch,
  roomId,
  roomName,
  generalId,
  sky,
  visible,
  onClose,
}: {
  readonly scope: AccountScope;
  readonly launch: Finished;
  readonly roomId: string;
  readonly roomName: string;
  /** The discussion the card is shared into. */
  readonly generalId: string;
  readonly sky: RoomSky;
  readonly visible: boolean;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  usePageInert(visible);
  const [shared, setShared] = useState<'idle' | 'sending' | 'shared' | 'failed'>('idle');
  const [copied, setCopied] = useState(false);
  const when = launchDayWords(launch.day);
  const text = launch.you === undefined ? undefined : launchShareText({ roomName, when, squares: launch.you.squares });
  const others = Math.max(0, launch.played - launch.podium.length);
  const stands = STAND.map((place) => launch.podium.find((entry) => entry.place === place));
  const share = async () => {
    if (text === undefined) return;
    setShared('sending');
    const sent = await shareLaunchResult(scope, { roomId, discussionId: generalId, text, commandId: newCommandId() });
    setShared(sent ? 'shared' : 'failed');
  };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      {...dialogHostSemantics("Tonight's podium")}
    >
      <View
        style={[styles.screen, { paddingTop: insets.top + spacing[5], paddingBottom: insets.bottom + spacing[5] }]}
        testID="launch-podium"
      >
        <View style={styles.column}>
          <Text variant="monoXs" color={content.continue}>
            {`LAUNCH · ${when.toUpperCase()} · ${String(launch.played)} PLAYED`}
          </Text>
          <Text variant="displayL" color={space.label} heading={1}>
            Tonight’s podium
          </Text>
          <Text variant="bodyS" color={overlay.onDarkMuted}>
            Top 3 of this quiz only. Gone after tonight; tomorrow starts empty.
          </Text>
          {launch.podium.length === 0 ? (
            <Text variant="ui" color={space.label} testID="podium-empty">
              Nobody got a question right this time. The next Launch starts empty.
            </Text>
          ) : (
            <View role="list" accessibilityLabel="Podium" style={styles.steps}>
              {STAND.map((place, index) => (
                <Step key={place} entry={stands[index]} place={place} />
              ))}
            </View>
          )}
          <Text variant="metaS" color={overlay.onDarkMuted}>
            {`Ties go to the faster total time. ${others === 0 ? 'Nobody' : `${String(others)} ${others === 1 ? 'other' : 'others'} played too; nobody`} below third is listed.`}
          </Text>
          {launch.star ? (
            <View style={styles.star} testID="podium-star">
              <Text variant="ui" color={space.label}>
                +1 star for the room
              </Text>
              <Text variant="metaS" color={overlay.onDarkMuted}>
                {skySentence(sky)}
              </Text>
            </View>
          ) : null}
          {launch.you === undefined || text === undefined ? (
            <Text variant="ui" color={space.label} testID="podium-watched">
              You watched this one. Join the next Launch to get a card of your own.
            </Text>
          ) : (
            <View style={styles.card} testID="launch-share-card">
              <Text variant="monoXs" color={content.ink2}>
                YOUR SHARE CARD
              </Text>
              <Text variant="ui" heading={2}>{`${roomName} · Launch ${when} · ${String(launch.you.score)}/5`}</Text>
              <View style={styles.squares} aria-hidden>
                {launch.you.squares.map((right, index) => (
                  <View key={String(index)} style={[styles.square, right ? styles.squareRight : null]} />
                ))}
              </View>
              <Text variant="metaS" color={content.ink2}>
                {`Copies as text: ${squaresOf(launch.you.squares)}. No answers in it, so it can’t spoil anything.`}
              </Text>
            </View>
          )}
          {shared === 'failed' ? (
            <Banner
              kind="error"
              lead="Couldn’t share it."
              message="Check your connection and try again."
              testID="podium-share-failed"
            />
          ) : null}
          <View style={styles.actions}>
            {text === undefined ? null : (
              <>
                <Button
                  label={shared === 'shared' ? 'Shared in General' : 'Share into General'}
                  variant="continue"
                  disabled={shared === 'sending' || shared === 'shared'}
                  onPress={() => void share()}
                  testID="launch-share"
                />
                <Button
                  label={copied ? 'Copied' : 'Copy result'}
                  variant="spaceGhost"
                  onPress={() => {
                    void Clipboard.setStringAsync(text);
                    setCopied(true);
                  }}
                  testID="launch-copy"
                />
              </>
            )}
            <Button label="Back to chat" variant="spaceGhost" onPress={onClose} testID="launch-close" />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: space.s0, paddingHorizontal: spacing[5] },
  column: { width: '100%', maxWidth: 520, alignSelf: 'center', gap: spacing[3] },
  steps: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: spacing[2],
    paddingTop: spacing[3],
  },
  step: { flex: 1, alignItems: 'center', gap: spacing[1] },
  stepName: { textAlign: 'center' },
  initial: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: content.paper,
    borderWidth: borderWidth.regular,
    borderColor: content.paper,
  },
  initialYou: { backgroundColor: content.continue },
  block: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
  },
  star: {
    gap: spacing[1],
    padding: spacing[3],
    borderRadius: radius.lg,
    borderWidth: borderWidth.regular,
    borderColor: content.continue,
  },
  card: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.lg,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    boxShadow: elevation.raised,
  },
  squares: { flexDirection: 'row', gap: spacing[2] },
  square: {
    width: 34,
    height: 34,
    borderRadius: radius.thumb,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  squareRight: { backgroundColor: content.fresh },
  actions: { gap: spacing[2] },
});
