import { Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Tag, Text, useFocusRing } from '@knowscroll/ui';
import {
  continuationIntent,
  continuationLabel,
  continuationName,
  type ReadyContinuation,
} from '../encounter/continuation-intent';
import type { EncounterEntry } from '../encounter/encounter-history';
import type { EncounterSession, EncounterState } from '../encounter/encounter-session';

type Format = 'reel' | 'scroll';

/** One step of the thread: the part that is open, the one before, the one after, or another angle. */
function StepCard({
  tag,
  title,
  tone,
  accessibilityLabel,
  narrow,
  disabled,
  onPress,
}: {
  readonly tag: string;
  readonly title: string;
  /** `now` is the open part (ink, not a control); `next` is the yellow Part cue; `related` is dashed. */
  readonly tone: 'now' | 'previous' | 'next' | 'related';
  readonly accessibilityLabel: string;
  /** A narrow aside (tablet) stacks the tag over the title. */
  readonly narrow: boolean;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
}) {
  const focus = useFocusRing(tone === 'now' ? 'onDark' : 'onLight');
  const dark = tone === 'now';
  const body = (
    <>
      <Tag label={tag} variant={tone === 'related' || tone === 'previous' ? 'neutral' : 'part'} />
      <Text variant="ui" color={dark ? content.paper : content.ink} style={narrow ? undefined : styles.stepTitle}>
        {title}
      </Text>
      {tone === 'now' ? (
        <Text variant="meta" color={content.paper}>
          now
        </Text>
      ) : (
        <Icon name={tone === 'previous' ? 'arrowLeft' : 'arrowRight'} size={20} color={content.ink} />
      )}
    </>
  );
  if (tone === 'now')
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        aria-current="step"
        style={[styles.step, narrow ? styles.stepNarrow : null, stepLook.now]}
      >
        {body}
      </View>
    );
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      aria-disabled={disabled}
      onPress={onPress}
      style={[
        styles.step,
        narrow ? styles.stepNarrow : null,
        stepLook[tone],
        disabled ? styles.disabled : null,
        focus.style,
      ]}
    >
      {body}
    </Pressable>
  );
}

function stepFor(state: ReadyContinuation | undefined) {
  return state === undefined ? undefined : { label: continuationLabel(state), title: state.metadata.title };
}

/** The other format of this explanation: open it, wait for it, or ask for it. */
function FormatSibling({
  entry,
  session,
  disabled,
}: {
  readonly entry: EncounterEntry;
  readonly session: EncounterSession;
  readonly disabled: boolean;
}) {
  const other: Format = entry.kind === 'reel' ? 'scroll' : 'reel';
  const noun = other === 'scroll' ? 'Scroll' : 'Reel';
  const variant = entry.context.variants.find((candidate) => candidate.kind === other);
  const ready = variant?.status === 'ready';
  const preparing = variant?.status === 'pending';
  return (
    <View style={styles.sibling}>
      <Text variant="bodyS">{`Same explanation as a ${noun}:`}</Text>
      {preparing ? (
        <Text variant="meta" color={content.ink2}>{`Your ${noun} is being prepared.`}</Text>
      ) : (
        <Button
          label={ready ? `Open ${noun}` : `Ask for a ${noun}`}
          variant={ready ? 'primary' : 'default'}
          size="sm"
          disabled={disabled}
          onPress={() => {
            if (ready) session.navigate({ mode: 'variant', to: other });
            else session.openRequest(other);
          }}
        />
      )}
    </View>
  );
}

/**
 * The context beside the encounter (D01 "This thread", V01 tablet): where this part sits in its
 * thread, the step before and after, another angle, and the other format. It only offers moves the
 * server already admitted for this exposure, so it never names a part that is not there; the
 * whole list of a thread's parts is not in the exposure context, so it shows the neighbours.
 */
export function ThreadAside({
  entry,
  state,
  session,
  width,
}: {
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly width: number;
}) {
  const { seriesPrevious, seriesNext, related } = entry.context.continuations;
  const previous = seriesPrevious.status === 'ready' ? seriesPrevious : undefined;
  const next = seriesNext.status === 'ready' ? seriesNext : undefined;
  const angle = related.status === 'ready' ? related : undefined;
  const series = entry.context.series;
  const disabled = state.phase !== 'active';
  const narrow = width < NARROW_ASIDE;
  const previousStep = stepFor(previous);
  const nextStep = stepFor(next);
  const angleStep = stepFor(angle);
  const pending = seriesNext.status === 'pending' || related.status === 'pending';
  return (
    <View role="complementary" aria-label="This thread" style={[styles.aside, { width }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="title" heading={2}>
          {series ? 'This thread' : 'Go deeper'}
        </Text>
        <View style={styles.steps}>
          {previous && previousStep ? (
            <StepCard
              tone="previous"
              tag={previousStep.label}
              title={previousStep.title}
              accessibilityLabel={continuationName(previous, 'previous')}
              narrow={narrow}
              disabled={disabled}
              onPress={() => session.navigate(continuationIntent(previous, 'previous'))}
            />
          ) : null}
          {series ? (
            <StepCard
              tone="now"
              tag={`Part ${String(series.part)}`}
              title={entry.offer.metadata.title}
              accessibilityLabel={`Now: Part ${String(series.part)}, ${entry.offer.metadata.title}`}
              narrow={narrow}
            />
          ) : null}
          {next && nextStep ? (
            <StepCard
              tone="next"
              tag={nextStep.label}
              title={nextStep.title}
              accessibilityLabel={continuationName(next)}
              narrow={narrow}
              disabled={disabled}
              onPress={() => session.navigate(continuationIntent(next))}
            />
          ) : null}
          {angle && angleStep ? (
            <StepCard
              tone="related"
              tag={angleStep.label}
              title={angleStep.title}
              accessibilityLabel={continuationName(angle)}
              narrow={narrow}
              disabled={disabled}
              onPress={() => session.navigate(continuationIntent(angle))}
            />
          ) : null}
        </View>
        {!previous && !next && !angle ? (
          <Text variant="meta" color={content.ink2}>
            {pending
              ? 'Something you asked for is still being prepared.'
              : 'Nothing else is lined up from here. Next subject is always there.'}
          </Text>
        ) : null}
        <FormatSibling entry={entry} session={session} disabled={disabled} />
      </ScrollView>
    </View>
  );
}

/** The aside's width at this window: none on phones and narrow tablets, the V01 and D01 widths above. */
export function asideWidthFor(windowWidth: number): number {
  if (windowWidth >= 1024) return layout.asideDesktop;
  if (windowWidth >= 768) return layout.asideTablet;
  return 0;
}

/** Below this width a step card stacks its tag over its title. */
const NARROW_ASIDE = 300;

const stepLook: Record<'now' | 'previous' | 'next' | 'related', ViewStyle> = {
  now: { backgroundColor: content.ink, borderColor: content.ink },
  previous: { backgroundColor: content.paper, borderColor: content.ink },
  next: { backgroundColor: content.continue, borderColor: content.ink },
  related: { backgroundColor: content.paper, borderColor: content.ink, borderStyle: 'dashed' },
};

const styles = StyleSheet.create({
  aside: {
    borderLeftWidth: borderWidth.regular,
    borderLeftColor: content.ink,
    backgroundColor: content.paper,
  },
  content: { gap: spacing[3], padding: spacing[5] },
  steps: { gap: spacing[2] },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 56,
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
  },
  stepNarrow: { flexDirection: 'column', alignItems: 'flex-start' },
  stepTitle: { flex: 1, minWidth: 0 },
  disabled: { opacity: 0.45 },
  sibling: {
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.card,
    backgroundColor: content.paper2,
    alignItems: 'flex-start',
  },
});
