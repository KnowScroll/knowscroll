import { useRef, useState, type ComponentRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { EssayCover, Skeleton, Text, useDisplay } from '@knowscroll/ui';
import { useEncounterMetrics } from '../encounter/encounter-metrics';
import { readResume } from '../encounter/encounter-history';
import type { CoverHand, EncounterSession, EncounterState } from '../encounter/encounter-session';
import { coverFigureOf } from './cover-figure';
import { useCoverPaging } from './cover-paging';

/**
 * Explore's hand of covers (#745): one Scroll at a time, opened only when the person taps it. Turning to the next
 * cover, asking for more and going back are all moves of the encounter session; this view draws the cover and
 * binds the web's swipe, wheel and keys to those moves.
 */
export function CoverFeed({
  scope,
  session,
  state,
  hand,
  foreground,
}: {
  readonly scope: AccountScope;
  readonly session: EncounterSession;
  readonly state: EncounterState;
  readonly hand: CoverHand;
  readonly foreground: boolean;
}) {
  const { reducedMotion } = useDisplay();
  const metrics = useEncounterMetrics();
  const root = useRef<ComponentRef<typeof View>>(null);
  const [height, setHeight] = useState(0);
  const offer = hand.offers[hand.index]!;
  const following = hand.offers[hand.index + 1];
  // While a cover opens or more covers are on their way, the cover stays where it is and takes no more moves.
  const waiting = state.phase !== 'covers';
  useCoverPaging(root, foreground && !waiting && !state.overlay, {
    onNext: () => session.nextCover(),
    onPrevious: () => session.previousCover(),
    onOpen: () => session.openCover(),
    onBack: () => session.back(),
  });
  // A Scroll read part of the way before opens where it was left, so its cover says Continue.
  const continues = readResume(scope, offer.assetId, offer.assetRevision)?.kind === 'scroll';
  const position = { index: hand.index + 1, count: hand.offers.length };
  return (
    <View
      ref={root}
      style={styles.fill}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
      testID="cover-feed"
    >
      {/* The cover's content ends where the floating tab bar begins, so its strip and Read button are never under it. */}
      {height > metrics.bottom ? (
        <EssayCover
          kicker={offer.cover.kicker}
          title={offer.metadata.title}
          dek={offer.metadata.summary}
          minutes={offer.cover.readingMinutes}
          figure={coverFigureOf(offer)}
          way={continues ? 'continue' : 'read'}
          position={position}
          next={following ? { kicker: following.cover.kicker, title: following.metadata.title } : 'more'}
          onOpen={() => session.openCover()}
          onNext={() => session.nextCover()}
          {...(hand.index > 0 ? { onPrevious: () => session.previousCover() } : {})}
          reducedMotion={reducedMotion}
          height={height}
          bottomInset={metrics.bottom}
        />
      ) : null}
      <View style={styles.announcer} accessibilityLiveRegion="polite">
        <Text variant="uiS">{`Cover ${String(position.index)} of ${String(position.count)}: ${offer.metadata.title}`}</Text>
      </View>
      {waiting ? (
        <View style={styles.waiting} pointerEvents="none">
          <Skeleton rows={1} label={state.phase === 'activating' ? 'Opening the Scroll' : 'Finding more covers'} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  waiting: { position: 'absolute', top: '45%', left: 24, right: 24 },
  // Heard by a screen reader as the cover changes, never seen: the cover itself shows the same words.
  announcer: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
});
