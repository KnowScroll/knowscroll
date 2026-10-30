import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { Button } from '../../actions/button';
import { Icon } from '../../icons/icon';
import { Tag } from '../../status/tag';
import { Text } from '../../text/text';
import type { Payoff } from './payoff';
import { landmarkNoteOf, LandmarkCard, ScoreRow } from './payoff-card';

/** A way on as the end tray and the dock offer it: only an admitted continuation is ever shown. */
export interface NextPartPeek {
  /** "Part 2", or "Related" for another angle. */
  readonly label: string;
  readonly title: string;
  /** Another angle rather than the next Part: drawn dashed. */
  readonly related?: boolean;
  readonly onPress: () => void;
}

/** The limits aside the "Small print" chip opens: its title and its text. */
export interface SmallPrint {
  readonly title: string;
  readonly text: string;
}

export interface EndTrayProps {
  readonly recap: ScrollDocumentV2['recap'];
  /** The Scroll has a stage: only then did the reader "build a picture". */
  readonly hasStage: boolean;
  /** How the person's play went. */
  readonly payoff?: Payoff | undefined;
  readonly nextPart?: NextPartPeek | undefined;
  /** Another angle; drawn dashed, as the thread's related tab is. */
  readonly related?: NextPartPeek | undefined;
  /** Present when the recap links to a limits aside. */
  readonly smallPrint?: SmallPrint | undefined;
  readonly onDone?: (() => void) | undefined;
  readonly onNextTopic?: (() => void) | undefined;
  readonly onUniverse?: (() => void) | undefined;
  /** Takes the reader back to the Final call when it is still open. */
  readonly onPlayFinal?: (() => void) | undefined;
}

/**
 * The end of a v2 Scroll, a payoff and not a menu (D-134, D-189): the recap's captions under the
 * stage still showing its last picture, the score of this Scroll, the landmark the Final call
 * awarded, a peek at the next Part, and the ways out with equal weight: continue the thread, stop for
 * today (no streak, no guilt), or something new. The limits stay one tap away as "Small print".
 * Nothing here moves on by itself: every way out is a button the person presses.
 */
export function EndTray(props: EndTrayProps) {
  const [closing, setClosing] = useState(false);
  const { recap, hasStage, payoff } = props;
  return (
    <View style={styles.tray} testID="end-tray">
      <Text variant="label" color={content.ink2} heading={2}>
        {hasStage ? 'The picture you built' : 'The short version'}
      </Text>
      <View style={styles.captions}>
        {recap.captions.map((caption, index) => (
          <View key={caption} style={styles.caption}>
            <View style={styles.badge} aria-hidden>
              <Text variant="metaS">{String(index + 1)}</Text>
            </View>
            <Text variant="body" style={styles.captionText}>
              {caption}
            </Text>
          </View>
        ))}
      </View>
      {payoff === undefined ? null : <PayoffBlock payoff={payoff} onPlayFinal={props.onPlayFinal} />}
      {closing ? (
        <DoneForToday
          payoff={payoff}
          onUniverse={props.onUniverse}
          onClose={props.onDone}
          onBack={() => setClosing(false)}
        />
      ) : (
        <WaysOn {...props} onDoneForToday={() => setClosing(true)} />
      )}
      {props.smallPrint === undefined ? null : <SmallPrintChip smallPrint={props.smallPrint} />}
    </View>
  );
}

/** The score, then the landmark when the Final call awarded one, or the way back to a Final call still open. */
function PayoffBlock({
  payoff,
  onPlayFinal,
}: {
  readonly payoff: Payoff;
  readonly onPlayFinal?: (() => void) | undefined;
}) {
  return (
    <View style={styles.payoff}>
      <ScoreRow payoff={payoff} />
      {payoff.landmark === undefined ? null : <LandmarkCard landmark={payoff.landmark} note={landmarkNoteOf(payoff)} />}
      {payoff.final === 'open' && onPlayFinal !== undefined ? (
        <Button label="Play the Final call" size="sm" onPress={onPlayFinal} />
      ) : null}
    </View>
  );
}

/**
 * Where to go next, every way with its own button: the peek at the next Part, then "Done for today"
 * and "Something new" side by side at the same size, then another angle if one was admitted.
 */
function WaysOn({
  nextPart,
  related,
  onNextTopic,
  onDoneForToday,
}: EndTrayProps & { readonly onDoneForToday: () => void }) {
  return (
    <>
      {nextPart === undefined ? null : (
        <View style={styles.peek} testID="part-peek">
          <Tag label={nextPart.label} variant="part" />
          <Text variant="title">{nextPart.title}</Text>
          <Button
            label={`Continue ${nextPart.label}`}
            icon="arrowRight"
            iconPosition="trailing"
            variant="primary"
            onPress={nextPart.onPress}
          />
        </View>
      )}
      <View style={styles.equal}>
        <View style={styles.equalCell}>
          <Button label="Done for today" fullWidth onPress={onDoneForToday} />
        </View>
        {onNextTopic === undefined ? null : (
          <View style={styles.equalCell}>
            <Button label="Something new" icon="arrowUp" fullWidth onPress={onNextTopic} />
          </View>
        )}
      </View>
      {related === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Another related explanation: ${related.title}`}
          onPress={related.onPress}
          style={styles.relatedRow}
        >
          <Tag label={related.label} variant="neutral" />
          <Text variant="ui" style={styles.relatedTitle} numberOfLines={2}>
            {related.title}
          </Text>
          <Icon name="arrowRight" size={20} color={content.ink} />
        </Pressable>
      )}
    </>
  );
}

/**
 * A good place to stop (E, "Done for today"): said warmly, with what was earned today and no guilt.
 * "Close" leaves the Scroll; "Back to the end" returns to the payoff. Nothing is lost by either.
 */
function DoneForToday({
  payoff,
  onUniverse,
  onClose,
  onBack,
}: {
  readonly payoff: Payoff | undefined;
  readonly onUniverse: (() => void) | undefined;
  readonly onClose: (() => void) | undefined;
  readonly onBack: () => void;
}) {
  const sparks = payoff === undefined ? '' : payoff.sparks === 1 ? '1 spark' : `${String(payoff.sparks)} sparks`;
  return (
    <View style={styles.done} testID="done-for-today" accessibilityLiveRegion="polite" role="status">
      <Text variant="title" heading={3}>
        A good place to stop.
      </Text>
      {payoff === undefined ? null : (
        <Text variant="body">
          {`Today: ${sparks}.`}
          {payoff.landmark === undefined ? '' : ` ${payoff.landmark.name} is yours.`}
        </Text>
      )}
      <View style={styles.actions}>
        {onUniverse === undefined ? null : <Button label="Open your Universe" variant="primary" onPress={onUniverse} />}
        {onClose === undefined ? null : <Button label="Close" onPress={onClose} />}
        <Button label="Back to the end" variant="ghost" size="sm" onPress={onBack} />
      </View>
    </View>
  );
}

/** The limits of the idea, one tap away and never the last word: the chip opens the aside where it stands. */
function SmallPrintChip({ smallPrint }: { readonly smallPrint: SmallPrint }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.smallPrint}>
      <Button label="Small print" variant="ghost" size="sm" onPress={() => setOpen((now) => !now)} />
      {open ? (
        <View style={styles.limits} testID="small-print">
          <Text variant="label" color={content.ink2} heading={3}>
            {smallPrint.title}
          </Text>
          <Text variant="bodyS">{smallPrint.text}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tray: { gap: spacing[4] },
  captions: { gap: spacing[3] },
  caption: { flexDirection: 'row', gap: spacing[3], alignItems: 'flex-start' },
  captionText: { flex: 1 },
  badge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.continue,
  },
  payoff: { gap: spacing[3], alignItems: 'flex-start' },
  peek: {
    gap: spacing[2],
    alignItems: 'flex-start',
    padding: spacing[4],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.continue,
  },
  equal: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  equalCell: { flexGrow: 1, flexBasis: 150 },
  relatedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 48,
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[3],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    backgroundColor: content.paper,
    cursor: 'pointer' as const,
  },
  relatedTitle: { flex: 1 },
  done: {
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  smallPrint: { gap: spacing[2], alignItems: 'flex-start' },
  limits: {
    gap: spacing[1],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
});
