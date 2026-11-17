import { useCallback, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import {
  BottomSheet,
  QuickAnswerCard,
  ReaderDock,
  ReaderTopBar,
  FolioReader,
  StageReader,
  readingModelOfV2,
  Text,
  useDisplay,
  type NextPartPeek,
  type PartArrival,
  type ReaderHandle,
  type StageReaderProps,
  type ReaderView,
  type StageReadingObserver,
} from '@knowscroll/ui';
import { QUICK_ANSWER_LABEL, QUICK_ANSWER_QUESTION_MAX } from '@knowscroll/contracts';
import type { FeedbackTarget } from '@knowscroll/client-core';
import { FeedbackSheetBody } from '../feedback/feedback-sheet';
import { whyNoMoment } from '@knowscroll/scroll-model';
import { challengeCallOf } from '../sharing/challenge-call';
import { ChallengeSheet } from '../sharing/challenge-sheet';
import { ShareStopSheet, type MomentThread } from '../threads/share-stop-sheet';
import type { SaveMove } from './more-rows';
import { MoreSheetBody } from './more-sheet';
import type { OpenedScrollV2 } from './scroll-session';
import type { ScrollV2Reader } from './scroll-readers';
import { quickAnswerViewOf } from './quick-answer-copy';
import { useQuickAnswers } from './use-quick-answers';
import { useScrollPlay } from './use-scroll-play';

/** What the surface needs from the screen it is on: where each move goes. Each is also a gesture and a key in the reader. */
export interface ReaderMoves {
  readonly universe: () => void;
  /** Return to the opener of a standalone reader, preserving its navigation stack and scroll position. */
  readonly back?: (() => void) | undefined;
  /** Save, as the ••• sheet and the S key offer it; absent where the screen keeps nothing (a thread's reader). */
  readonly save?: SaveMove | undefined;
  readonly nextTopic?: (() => void) | undefined;
  readonly nextPart?: NextPartPeek | undefined;
  /** Another angle on the idea. With no next Part it is the way on (the dock, the → key, a swipe left) (D-184). */
  readonly related?: NextPartPeek | undefined;
  readonly previousPart?: (() => void) | undefined;
  /** The Part before as it is named and titled: the tab at the picture's left edge and what a swipe right brings in. */
  readonly previous?: NextPartPeek | undefined;
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
 * One Stage + Spine reader for a v2 Scroll, wherever it is shown (the Explore encounter and the
 * direct `/scroll/<id>` route): its top bar, the reader, its dock and the ••• sheet, with the room a
 * screen keeps for the status bar and the tab bar. The screen supplies the moves and what the sheet
 * holds (Save, Share), because those differ by screen. Play (the calls, the sparks in the dock) belongs
 * to the Scroll, so it is the same on both. On a tablet or desktop the reader is a
 * centred column with the stage pinned at its top (D-133).
 */
export function ScrollReaderSurface({
  kind,
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
  /** Which reader draws the Scroll: the Stage reader, or Folio's essay while it is a trial (#732). */
  readonly kind: ScrollV2Reader;
  readonly scroll: OpenedScrollV2;
  readonly observer?: StageReadingObserver | undefined;
  readonly paused?: boolean | undefined;
  readonly initialStopId?: string | undefined;
  readonly handleRef?: Ref<ReaderHandle> | undefined;
  readonly onStopChange?: ((stopId: string | undefined) => void) | undefined;
  readonly moves: ReaderMoves;
  /** "Part 1 of 3": a count only when the server counted it. */
  readonly partLabel?: string | undefined;
  /**
   * What the screen adds under the seven rows of the ••• sheet (Like and Ask in Explore, notices about Save), given a way to
   * close it. The ••• button is always there: the rows are the reader's own.
   */
  readonly moreBody?: ((close: () => void) => ReactNode) | undefined;
  /** A line under the top bar (where the person came from). */
  readonly headerNote?: ReactNode;
  /** Drawn at the end of the Scroll, before the ways on (a thread's "I've finished this part"). */
  readonly endSlot?: ReactNode;
  /** Set when this Scroll was opened by a move from the Part before: it comes in from the right and says the place there is kept. */
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
  const noMoment = whyNoMoment(document, momentStop);
  const limits = document.asides.find((aside) => aside.id === document.recap.smallPrintAside);
  // Play on this Scroll: the person's own calls, sparks and combo, kept unless recording is paused (D-063, D-083).
  const play = useScrollPlay(scroll);
  // Folio offers no related move (#732: no Related control); the Stage reader keeps it as the way on.
  const wayOn = kind === 'folio' ? moves.nextPart : (moves.nextPart ?? moves.related);
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
    setMomentStop(reader.current?.capture()?.stopId);
    setReaderView(reader.current?.view());
    setMoreOpen(true);
  };
  return (
    <View style={styles.page}>
      <View
        style={[styles.column, breakpoint === 'compact' ? null : kind === 'folio' ? styles.wideEssay : styles.wide]}
      >
        <V2Reader
          kind={kind}
          document={document}
          observer={observer}
          paused={
            paused === true || moreOpen || challenging || sharingMoment || smallPrintOpen || reporting !== undefined
          }
          initialStopId={initialStopId}
          handleRef={readerRef}
          onStopChange={onStopChange}
          nextPart={moves.nextPart}
          related={moves.related}
          previousPart={moves.previous}
          arrival={arrival}
          topNote={topNote}
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
                onAsk={moves.ask}
                sparks={
                  kind === 'stage' && document.stops.some((stop) => stop.kind !== 'read') ? play?.sparks : undefined
                }
                onMore={openMore}
                nextPart={wayOn}
              />
            </View>
          }
        />
      </View>
      <BottomSheet visible={moreOpen} title="More" onClose={() => setMoreOpen(false)}>
        <MoreSheetBody
          onClose={() => setMoreOpen(false)}
          input={{
            save: moves.save,
            noMoment,
            canChallenge,
            hasSmallPrint: limits !== undefined,
            view: readerView,
            act: {
              shareMoment: () => setSharingMoment(true),
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

/**
 * The reader the surface draws. Both take the same commands, handle, header and dock; Folio draws the document as an
 * essay (`readingModelOfV2`) and has no related move and no played calls (#732).
 */
function V2Reader({ kind, document, related, play, ...shared }: StageReaderProps & { readonly kind: ScrollV2Reader }) {
  const model = useMemo(() => (kind === 'folio' ? readingModelOfV2(document) : undefined), [kind, document]);
  if (model !== undefined) return <FolioReader model={model} {...shared} />;
  return <StageReader document={document} related={related} play={play} {...shared} />;
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: content.paper, alignItems: 'center' },
  column: { flex: 1, minHeight: 0, width: '100%' },
  wide: { maxWidth: layout.measureDesktop + 2 * layout.gutter + spacing[8] },
  // Folio keeps its text at the reading measure and sets a held figure beside it, so it needs room for both.
  wideEssay: { maxWidth: Math.round(layout.measureDesktop * 1.7) + 2 * layout.gutter + spacing[8] },
  smallPrint: { gap: spacing[2] },
});
