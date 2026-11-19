import { useCallback, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import {
  BottomSheet,
  QuickAnswerCard,
  ReaderDock,
  ReaderTopBar,
  FolioReader,
  readingModelOfV2,
  Text,
  useDisplay,
  type NextPartPeek,
  type PartArrival,
  type ReaderHandle,
  type ReaderView,
  type UnitReadingObserver,
} from '@knowscroll/ui';
import { QUICK_ANSWER_LABEL, QUICK_ANSWER_QUESTION_MAX } from '@knowscroll/contracts';
import type { FeedbackTarget } from '@knowscroll/client-core';
import { FeedbackSheetBody } from '../feedback/feedback-sheet';
import { whyNoMoment } from '@knowscroll/scroll-model';
import { challengeCallOf } from '../sharing/challenge-call';
import { ChallengeSheet } from '../sharing/challenge-sheet';
import { ShareStopSheet, noMomentWords, type MomentThread } from '../threads/share-stop-sheet';
import { MoreSheetBody } from './more-sheet';
import type { OpenedScrollV2 } from './scroll-session';
import { quickAnswerViewOf } from './quick-answer-copy';
import { useQuickAnswers } from './use-quick-answers';

/** Save as a screen offers it: whether this Scroll is kept, whether a save is in flight, and what pressing does. */
export interface SaveMove {
  readonly saved: boolean;
  readonly busy: boolean;
  readonly onPress: () => void;
}

/** Like as a screen offers it (D-429): whether this Scroll is liked, whether the command is in flight, and what pressing does. */
export interface LikeMove {
  readonly liked: boolean;
  readonly busy: boolean;
  readonly onPress: () => void;
}

/** What the surface needs from the screen it is on: where each move goes. Each is also a gesture and a key in the reader. */
export interface ReaderMoves {
  readonly universe: () => void;
  /** Return to the opener of a standalone reader, preserving its navigation stack and scroll position. */
  readonly back?: (() => void) | undefined;
  /** Save, as the dock and the S key offer it; absent where the screen keeps nothing (a thread's reader). */
  readonly save?: SaveMove | undefined;
  /** Like, as the dock and the L key offer it; absent where the screen has none (the direct route, a thread's reader). */
  readonly like?: LikeMove | undefined;
  readonly nextTopic?: (() => void) | undefined;
  /** The next Part: the dock, the end of the essay and the → key (D-425). */
  readonly nextPart?: NextPartPeek | undefined;
  readonly previousPart?: (() => void) | undefined;
  /** The Part before as it is named and titled: the link above the essay's title and the ← key. */
  readonly previous?: NextPartPeek | undefined;
  /** Ask from here, anchored to the stop on screen: the first row of the ••• sheet and the A and ? keys. */
  readonly ask?: (() => void) | undefined;
  /** The Reel/Scroll switch; `format` is the key that moves to the other format. */
  readonly formatSwitch?: ReactNode;
  readonly format?: (() => void) | undefined;
  /** Goes back to the Scroll a new topic left; given only while the note that offers it is on screen (V3 G4). */
  readonly undo?: (() => void) | undefined;
  readonly done?: (() => void) | undefined;
  /**
   * "Make it a full Scroll" under a Quick answer: opens Ask from here anchored to a stop, with the words the reader selected as
   * the first draft of the question (D-244, D-253). Absent where a screen offers no Ask; the Explore encounter
   * and the direct `/scroll/<id>` route both offer it (D-262).
   */
  readonly makeScroll?: ((stopId: string, passage: string, question?: string) => void) | undefined;
}

/** Hands one value to a ref of either kind. */
function assign<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref !== undefined && ref !== null) (ref as { current: T | null }).current = value;
}

/**
 * Folio's reader for a v2 Scroll, wherever it is shown (the Explore encounter, the direct `/scroll/<id>` route and a
 * thread): its top bar, the essay, its dock (Like, Share, Save, •••, the next Part) and the ••• sheet, with the room a
 * screen keeps for the status bar and the tab bar. The screen supplies the moves (Like, Save, Ask), because those differ
 * by screen; Share a moment is the reader's own. On a
 * tablet or desktop the essay is a centred column wide enough to set a held figure beside the text (D-425).
 */
export function ScrollReaderSurface({
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
  arrival,
  topNote,
  momentThread,
  topInset,
  bottomInset,
}: {
  readonly scroll: OpenedScrollV2;
  readonly observer?: UnitReadingObserver | undefined;
  readonly paused?: boolean | undefined;
  readonly initialStopId?: string | undefined;
  readonly handleRef?: Ref<ReaderHandle> | undefined;
  readonly onStopChange?: ((stopId: string | undefined) => void) | undefined;
  readonly moves: ReaderMoves;
  /** "Part 1 of 3": a count only when the server counted it. */
  readonly partLabel?: string | undefined;
  /**
   * What the screen adds under the rows of the ••• sheet (sharing the whole Scroll, notices about Save), given a way to
   * close it. The ••• button is always there: the rows are the reader's own.
   */
  readonly moreBody?: ((close: () => void) => ReactNode) | undefined;
  /** A line under the top bar (where the person came from). */
  readonly headerNote?: ReactNode;
  /** Drawn at the end of the Scroll, before the ways on (a thread's "I've finished this part"). */
  readonly endSlot?: ReactNode;
  /** Set when this Scroll was opened by a move from the Part before: a note says the place there is kept. */
  readonly arrival?: PartArrival | undefined;
  /** A note over the top of the reader, below its header (Explore's "Next topic" note). */
  readonly topNote?: ReactNode;
  /** The thread this Scroll is read in, so "Share a moment" sends into it; elsewhere the person chooses one of theirs. */
  readonly momentThread?: MomentThread | undefined;
  readonly topInset: number;
  readonly bottomInset: number;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [challenging, setChallenging] = useState(false);
  // Share a moment (D-292): the stop on screen when the person opened More, shared as a snippet.
  const [momentStop, setMomentStop] = useState<string | undefined>();
  const [sharingMoment, setSharingMoment] = useState(false);
  const [reporting, setReporting] = useState<FeedbackTarget>();
  const [smallPrintOpen, setSmallPrintOpen] = useState(false);
  // What the reader showed when ••• opened, so the rows can say which words and pictures they would switch.
  // The stop on screen now, so the dock's Share says at once whether it can share it (a call cannot be a moment).
  const [stopNow, setStopNow] = useState<string | undefined>(initialStopId);
  const stopChanged = useCallback(
    (stopId: string | undefined) => {
      setStopNow(stopId);
      onStopChange?.(stopId);
    },
    [onStopChange],
  );
  const [readerView, setReaderView] = useState<ReaderView | undefined>();
  // Quick answers on this Scroll: asked from the selection menu, drawn under the stop, never part of the Scroll (D-253).
  const quick = useQuickAnswers(scroll);
  // The reader's own handle is kept here too, because the ••• menu switches the stop on screen to its plainer words.
  const reader = useRef<ReaderHandle | null>(null);
  const readerRef = useCallback(
    (instance: ReaderHandle | null) => {
      reader.current = instance;
      assign(handleRef, instance);
    },
    [handleRef],
  );
  const canChallenge = challengeCallOf(scroll.document) !== undefined;
  const { breakpoint } = useDisplay();
  const { document } = scroll;
  const noMoment = whyNoMoment(document, stopNow);
  const limits = document.asides.find((aside) => aside.id === document.recap.smallPrintAside);
  const model = useMemo(() => readingModelOfV2(document), [document]);
  const openMoment = () => {
    setMomentStop(reader.current?.capture()?.stopId);
    setSharingMoment(true);
  };
  const openReport = () => {
    const stopId = reader.current?.capture()?.stopId;
    setReporting({
      kind: 'asset',
      assetId: scroll.assetId,
      assetRevision: scroll.assetRevision,
      title: document.title,
      format: 'scroll',
      ...(stopId === undefined ? {} : { anchor: { kind: 'scroll' as const, blockId: stopId } }),
    });
  };
  const openMore = () => {
    setReaderView(reader.current?.view());
    setMoreOpen(true);
  };
  return (
    <View style={styles.page}>
      <View style={[styles.column, breakpoint === 'compact' ? null : styles.wide]}>
        <FolioReader
          model={model}
          observer={observer}
          paused={
            paused === true || moreOpen || challenging || sharingMoment || smallPrintOpen || reporting !== undefined
          }
          initialStopId={initialStopId}
          handleRef={readerRef}
          onStopChange={stopChanged}
          nextPart={moves.nextPart}
          previousPart={moves.previous}
          arrival={arrival}
          topNote={topNote}
          onDone={moves.done}
          endSlot={endSlot}
          commands={{
            universe: moves.universe,
            ask: moves.ask,
            format: moves.format,
            wayOn: moves.nextPart?.onPress,
            previousPart: moves.previousPart,
            nextTopic: moves.nextTopic,
            challenge: canChallenge ? () => setChallenging(true) : undefined,
            like: moves.like?.onPress,
            save: moves.save?.onPress,
            shareMoment: openMoment,
            smallPrint: limits === undefined ? undefined : () => setSmallPrintOpen(true),
            report: openReport,
            undo: moves.undo,
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
                onBack={moves.back}
                onNextTopic={moves.nextTopic}
              />
              {headerNote}
            </View>
          }
          dock={
            <View style={{ paddingBottom: bottomInset }}>
              <ReaderDock
                like={
                  moves.like === undefined
                    ? undefined
                    : { on: moves.like.liked, busy: moves.like.busy, onPress: moves.like.onPress }
                }
                share={{
                  onPress: openMoment,
                  unavailable: noMoment === undefined ? undefined : noMomentWords(noMoment),
                }}
                save={
                  moves.save === undefined
                    ? undefined
                    : { on: moves.save.saved, busy: moves.save.busy, onPress: moves.save.onPress }
                }
                onMore={openMore}
                nextPart={moves.nextPart}
              />
            </View>
          }
        />
      </View>
      <BottomSheet visible={moreOpen} title="More" onClose={() => setMoreOpen(false)}>
        <MoreSheetBody
          onClose={() => setMoreOpen(false)}
          input={{
            ask: moves.ask,
            canChallenge,
            hasSmallPrint: limits !== undefined,
            view: readerView,
            act: {
              challenge: () => setChallenging(true),
              toggleTextVersion: () => void reader.current?.toggleTextVersion(),
              toggleSimpler: () => void reader.current?.toggleSimpler(),
              smallPrint: () => setSmallPrintOpen(true),
              report: openReport,
            },
          }}
        >
          {moreBody?.(() => setMoreOpen(false))}
        </MoreSheetBody>
      </BottomSheet>
      <BottomSheet visible={smallPrintOpen} title="Small print" onClose={() => setSmallPrintOpen(false)}>
        {limits === undefined ? null : (
          <View style={styles.smallPrint} testID="more-small-print">
            <Text variant="label" color={content.ink2} heading={3}>
              {limits.title}
            </Text>
            <Text variant="bodyS">{limits.text}</Text>
          </View>
        )}
      </BottomSheet>
      <BottomSheet visible={sharingMoment} title="Share a moment" onClose={() => setSharingMoment(false)}>
        <ShareStopSheet
          scroll={scroll}
          stopId={momentStop}
          thread={momentThread}
          onClose={() => setSharingMoment(false)}
        />
      </BottomSheet>
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
  // The text keeps the reading measure and a held figure sits beside it, so the column needs room for both.
  wide: { maxWidth: Math.round(layout.measureDesktop * 1.7) + 2 * layout.gutter + spacing[8] },
  smallPrint: { gap: spacing[2] },
});
