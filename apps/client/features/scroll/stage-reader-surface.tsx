import { useCallback, useRef, useState, type ReactNode, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import {
  BottomSheet,
  Button,
  QuickAnswerCard,
  ReaderDock,
  ReaderTopBar,
  StageReader,
  useDisplay,
  type NextPartPeek,
  type StageReaderHandle,
  type StageReadingObserver,
} from '@knowscroll/ui';
import { QUICK_ANSWER_LABEL, QUICK_ANSWER_QUESTION_MAX } from '@knowscroll/contracts';
import type { FeedbackTarget } from '@knowscroll/client-core';
import { FeedbackSheetBody } from '../feedback/feedback-sheet';
import { challengeCallOf } from '../sharing/challenge-call';
import { ChallengeSheet } from '../sharing/challenge-sheet';
import type { OpenedStageScroll } from './scroll-session';
import { quickAnswerViewOf } from './quick-answer-copy';
import { useQuickAnswers } from './use-quick-answers';
import { useStagePlay } from './use-stage-play';

/** What the surface needs from the screen it is on: where each move goes. Each is also a gesture and a key in the reader. */
export interface StageMoves {
  readonly universe: () => void;
  readonly nextTopic?: (() => void) | undefined;
  readonly nextPart?: NextPartPeek | undefined;
  /** Another angle on the idea. With no next Part it is the way on (the dock, the → key, a swipe left) (D-184). */
  readonly related?: NextPartPeek | undefined;
  readonly previousPart?: (() => void) | undefined;
  readonly ask?: (() => void) | undefined;
  /** The Reel/Scroll switch; `format` is the key that moves to the other format. */
  readonly formatSwitch?: ReactNode;
  readonly format?: (() => void) | undefined;
  readonly done?: (() => void) | undefined;
  /**
   * "Make it a full Scroll" under a Quick answer: opens Ask from here anchored to a stop, with the words the reader selected as
   * the first draft of the question (D-244, D-253). Absent where there is no Ask (the direct `/scroll/<id>` route): the
   * Quick answer is still offered there, without that way on.
   */
  readonly makeScroll?: ((stopId: string, passage: string, question?: string) => void) | undefined;
}

/** Hands one value to a ref of either kind. */
function assign<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref !== undefined && ref !== null) (ref as { current: T | null }).current = value;
}

/**
 * One Stage + Spine reader for a v2 Scroll, wherever it is shown (the Explore encounter and the
 * direct `/scroll/<id>` route): its top bar, the reader, its dock and the ••• sheet, with the room a
 * screen keeps for the status bar and the tab bar. The screen supplies the moves and what the sheet
 * holds (Save, Share), because those differ by screen. Play (the calls, the sparks in the dock) belongs
 * to the Scroll, so it is the same on both. On a tablet or desktop the reader is a
 * centred column with the stage pinned at its top (D-133).
 */
export function StageReaderSurface({
  scroll,
  observer,
  paused,
  initialStopId,
  handleRef,
  onStopChange,
  moves,
  partLabel,
  moreBody,
  headerNote,
  endSlot,
  topInset,
  bottomInset,
}: {
  readonly scroll: OpenedStageScroll;
  readonly observer?: StageReadingObserver | undefined;
  readonly paused?: boolean | undefined;
  readonly initialStopId?: string | undefined;
  readonly handleRef?: Ref<StageReaderHandle> | undefined;
  readonly onStopChange?: ((stopId: string | undefined) => void) | undefined;
  readonly moves: StageMoves;
  /** "Part 1 of 3": a count only when the server counted it. */
  readonly partLabel?: string | undefined;
  /** What the ••• sheet holds, given a way to close it; without it there is no ••• button. */
  readonly moreBody?: ((close: () => void) => ReactNode) | undefined;
  /** A line under the top bar (where the person came from). */
  readonly headerNote?: ReactNode;
  /** Drawn at the end of the Scroll, before the ways on (a thread's "I've finished this part"). */
  readonly endSlot?: ReactNode;
  readonly topInset: number;
  readonly bottomInset: number;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [challenging, setChallenging] = useState(false);
  const [reporting, setReporting] = useState<FeedbackTarget>();
  // Quick answers on this Scroll: asked from the selection menu, drawn under the stop, never part of the Scroll (D-253).
  const quick = useQuickAnswers(scroll);
  // The reader's own handle is kept here too, because the ••• menu switches the stop on screen to its plainer words.
  const reader = useRef<StageReaderHandle | null>(null);
  const readerRef = useCallback(
    (instance: StageReaderHandle | null) => {
      reader.current = instance;
      assign(handleRef, instance);
    },
    [handleRef],
  );
  const canChallenge = challengeCallOf(scroll.document) !== undefined;
  const { breakpoint } = useDisplay();
  const { document } = scroll;
  // Play on this Scroll: the person's own calls, sparks and combo, kept unless recording is paused (D-063, D-083).
  const play = useStagePlay(scroll);
  const wayOn = moves.nextPart ?? moves.related;
  return (
    <View style={styles.page}>
      <View style={[styles.column, breakpoint === 'compact' ? null : styles.wide]}>
        <StageReader
          document={document}
          observer={observer}
          paused={paused === true || moreOpen || challenging || reporting !== undefined}
          initialStopId={initialStopId}
          handleRef={readerRef}
          onStopChange={onStopChange}
          nextPart={moves.nextPart}
          related={moves.related}
          onDone={moves.done}
          endSlot={endSlot}
          play={play}
          commands={{
            universe: moves.universe,
            ask: moves.ask,
            format: moves.format,
            wayOn: wayOn?.onPress,
            previousPart: moves.previousPart,
            nextTopic: moves.nextTopic,
            challenge: canChallenge ? () => setChallenging(true) : undefined,
            askAbout:
              quick === undefined ? undefined : (stopId, passage) => void quick.session.ask({ stopId, passage }),
          }}
          stopFooter={(stopId) => {
            const card = quick?.snapshot.cards[stopId];
            if (quick === undefined || card === undefined) return null;
            return (
              <QuickAnswerCard
                view={quickAnswerViewOf(card, moves.makeScroll !== undefined)}
                label={card.phase === 'answered' ? card.label : QUICK_ANSWER_LABEL}
                followUpMax={QUICK_ANSWER_QUESTION_MAX}
                onMakeScroll={() =>
                  moves.makeScroll?.(stopId, card.passage, card.phase === 'answered' ? card.question : undefined)
                }
                onReport={() => {
                  if (card.phase !== 'answered') return;
                  setReporting({
                    kind: 'asset',
                    assetId: scroll.assetId,
                    assetRevision: scroll.assetRevision,
                    title: document.title,
                    format: 'scroll',
                    anchor: { kind: 'scroll', blockId: stopId },
                    quickAnswerId: card.id,
                  });
                }}
                onFollowUp={(question) => void quick.session.ask({ stopId, passage: card.passage, question })}
                onClose={() => quick.session.dismiss(stopId)}
              />
            );
          }}
          header={
            <View style={{ paddingTop: topInset }}>
              <ReaderTopBar
                title={document.title}
                kicker={document.kicker}
                partLabel={partLabel}
                formatSwitch={moves.formatSwitch}
                onUniverse={moves.universe}
                onNextTopic={moves.nextTopic}
              />
              {headerNote}
            </View>
          }
          dock={
            <View style={{ paddingBottom: bottomInset }}>
              <ReaderDock
                onAsk={moves.ask}
                sparks={play?.sparks}
                onMore={moreBody === undefined ? undefined : () => setMoreOpen(true)}
                nextPart={wayOn}
              />
            </View>
          }
        />
      </View>
      {moreBody === undefined ? null : (
        <BottomSheet visible={moreOpen} title="More" onClose={() => setMoreOpen(false)}>
          <View style={styles.more}>
            <Button
              label="Simpler (this screen)"
              icon="info"
              size="sm"
              onPress={() => {
                setMoreOpen(false);
                reader.current?.toggleSimpler();
              }}
              testID="more-simpler"
            />
            {canChallenge ? (
              <Button
                label="Challenge a friend"
                icon="send"
                size="sm"
                onPress={() => {
                  setMoreOpen(false);
                  setChallenging(true);
                }}
                testID="more-challenge"
              />
            ) : null}
            {moreBody(() => setMoreOpen(false))}
          </View>
        </BottomSheet>
      )}
      <BottomSheet visible={reporting !== undefined} title="Report" onClose={() => setReporting(undefined)}>
        {reporting === undefined ? null : (
          <FeedbackSheetBody target={reporting} start="content_error" onClose={() => setReporting(undefined)} />
        )}
      </BottomSheet>
      <BottomSheet visible={challenging} title="Challenge a friend" onClose={() => setChallenging(false)}>
        <ChallengeSheet scroll={scroll} onClose={() => setChallenging(false)} />
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: content.paper, alignItems: 'center' },
  column: { flex: 1, minHeight: 0, width: '100%' },
  wide: { maxWidth: layout.measureDesktop + 2 * layout.gutter + spacing[8] },
  more: { gap: spacing[3], alignItems: 'flex-start' },
});
