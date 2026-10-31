import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { borderWidth, content, dimension, layout, opacity, radius, spacing } from '@knowscroll/design-tokens';
import { IconButton, Icon, Tag, Text, type IconName } from '@knowscroll/ui';
import { afterPendingBack } from '../../platform/after-pending-back';
import type { ContentErrorAnchor } from '@knowscroll/contracts';
import type { FeedbackTarget } from '@knowscroll/client-core';
import { FeedbackSheetBody } from '../feedback/feedback-sheet';
import { NotInterestedRow } from '../feedback/feedback-parts';
import { ShareSheetBody } from '../sharing/share-sheet-body';
import { RequestPanel } from '../requests/request-panel';
import { isStageScroll } from '../scroll/scroll-session';
import { continuationIntent, continuationLabel, type ReadyContinuation } from './continuation-intent';
import { EncounterOverlay } from './encounter-overlay';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession, EncounterState } from './encounter-session';

/**
 * The bottom sheet every encounter overlay shares: grab handle, title, Close, then its content.
 * A sheet about one piece of content (H01) passes `tile`: the kind's glyph on a dark square, and
 * the content's title in the controls' size instead of a page-sized heading.
 */
function SheetPanel({
  title,
  subtitle,
  tile,
  onClose,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly tile?: IconName;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.host} pointerEvents="box-none">
      <ScrollView
        style={styles.viewport}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.sheet, { paddingBottom: spacing[7] + insets.bottom }]}
      >
        <View
          style={styles.grab}
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        />
        <View style={styles.heading}>
          {tile === undefined ? null : (
            <View style={styles.tile} aria-hidden>
              <Icon name={tile} size={24} color={content.paper} />
            </View>
          )}
          <View style={styles.headingText}>
            <Text variant={tile === undefined ? 'displayL' : 'ui'} heading={2}>
              {title}
            </Text>
            {subtitle === undefined ? null : (
              <Text variant="meta" color={content.ink2}>
                {subtitle}
              </Text>
            )}
          </View>
          <IconButton icon="close" label="Close" onPress={onClose} />
        </View>
        {children}
      </ScrollView>
    </View>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
  disabled = false,
  href,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly href?: string;
}) {
  return (
    <Pressable
      accessibilityRole={href === undefined ? 'button' : 'link'}
      accessibilityLabel={label}
      disabled={disabled}
      aria-disabled={disabled}
      onPress={onPress}
      {...(href === undefined ? {} : { href })}
      style={[styles.menuRow, disabled ? styles.disabled : null]}
    >
      <View style={styles.menuIcon}>
        <Icon name={icon} size={20} />
      </View>
      <Text variant="ui">{label}</Text>
    </Pressable>
  );
}

function ContinuationRow({
  state,
  direction,
  session,
}: {
  readonly state: ReadyContinuation;
  readonly direction?: 'previous';
  readonly session: EncounterSession;
}) {
  return (
    <MenuRow
      icon={direction === 'previous' ? 'arrowLeft' : 'arrowRight'}
      label={`${direction === 'previous' ? 'Previous · ' : ''}${continuationLabel(state)} · ${state.metadata.title}`}
      onPress={() => {
        session.setOverlay(false);
        session.navigate(continuationIntent(state, direction));
      }}
    />
  );
}

function trailTag(entry: EncounterEntry): { label: string; variant: 'part' | 'neutral' } {
  const relation = entry.offer.relation;
  if (relation.kind === 'series_step') return { label: `Part ${String(relation.part)}`, variant: 'part' };
  if (relation.kind === 'related_move') return { label: 'Related', variant: 'neutral' };
  return { label: entry.kind === 'reel' ? 'Reel' : 'Scroll', variant: 'neutral' };
}

/** E05-3: the person's own path, never a progress meter. Rows are "Visited", nothing is graded. */
function PathList({ state, session }: { readonly state: EncounterState; readonly session: EncounterSession }) {
  if (state.trail.length < 2) return null;
  return (
    <View style={styles.path} accessibilityRole="list">
      <Text variant="label" color={content.ink2}>
        Your path · only you see it
      </Text>
      {state.trail.map((entry) => {
        const current = entry.exposureId === state.entry?.exposureId;
        const tag = trailTag(entry);
        return (
          <Pressable
            key={entry.exposureId}
            accessibilityRole="button"
            accessibilityLabel={`${tag.label}: ${entry.offer.metadata.title}`}
            accessibilityState={{ selected: current, disabled: current }}
            aria-disabled={current}
            aria-current={current ? 'step' : undefined}
            disabled={current}
            onPress={() => session.restore(entry.exposureId)}
            style={[
              styles.pathRow,
              tag.variant === 'part' ? styles.pathPart : null,
              entry.offer.relation.kind === 'related_move' ? styles.pathRelated : null,
              current ? styles.pathCurrent : null,
            ]}
          >
            <Tag label={tag.label} variant={tag.variant} />
            <View style={styles.pathCopy}>
              <Text variant="ui">{entry.offer.metadata.title}</Text>
              <Text variant="meta" color={content.ink2}>
                {current ? 'You are here' : 'Visited'}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** ⋯: every move that has a gesture also has a row here (N01), plus the path and the account. */
function MoreSheet({ state, session }: { readonly state: EncounterState; readonly session: EncounterSession }) {
  const router = useRouter();
  const entry = state.entry;
  if (!entry) return null;
  const { seriesNext, seriesPrevious, related } = entry.context.continuations;
  const close = () => session.setOverlay(false);
  const idle = state.phase !== 'active';
  return (
    <SheetPanel title="More" onClose={close}>
      <View style={styles.menu}>
        {session.canBack() ? (
          <MenuRow
            icon="back"
            label="Back"
            onPress={() => {
              close();
              session.back();
            }}
          />
        ) : null}
        {seriesPrevious.status === 'ready' ? (
          <ContinuationRow state={seriesPrevious} direction="previous" session={session} />
        ) : null}
        {seriesNext.status === 'ready' ? <ContinuationRow state={seriesNext} session={session} /> : null}
        {related.status === 'ready' ? <ContinuationRow state={related} session={session} /> : null}
        <MenuRow
          icon="arrowUp"
          label="Next subject"
          disabled={idle}
          onPress={() => {
            close();
            session.navigate({ mode: 'vertical', direction: 'next' });
          }}
        />
        {entry.kind === 'reel' ? (
          <MenuRow
            icon="arrowDown"
            label="Previous subject"
            disabled={idle}
            onPress={() => {
              close();
              session.navigate({ mode: 'vertical', direction: 'previous' });
            }}
          />
        ) : null}
        {entry.context.actions.saved ? (
          <MenuRow
            icon="keep"
            label="Keep this place"
            disabled={idle}
            onPress={() => {
              close();
              void session.keepThisPlace();
            }}
          />
        ) : null}
        <NotInterestedRow run={session.notInterested} disabled={idle} />
        <MenuRow
          icon="alert"
          label="Report a content error"
          disabled={idle}
          onPress={() => session.openFeedback('content_error')}
        />
        <MenuRow icon="shield" label="Report abuse" disabled={idle} onPress={() => session.openFeedback('abuse')} />
        <MenuRow
          icon="person"
          label="Account and settings"
          href="/account"
          onPress={() => {
            close();
            afterPendingBack(() => router.navigate('/account'));
          }}
        />
      </View>
      <PathList state={state} session={session} />
    </SheetPanel>
  );
}

/**
 * H01: send to a conversation, copy the link, or hand it to the system share sheet, all in the
 * sharing feature's body. Playback pauses while the sheet is open and resumes where it was when
 * it closes (D-006 k).
 */
function ShareSheet({ state, session }: { readonly state: EncounterState; readonly session: EncounterSession }) {
  const entry = state.entry;
  if (!entry) return null;
  const close = () => session.setOverlay(false);
  const { kind, title } = entry.offer.metadata;
  const part = entry.context.series ? `Part ${String(entry.context.series.part)} · ` : '';
  return (
    <SheetPanel title={title} subtitle={`${part}${kind === 'reel' ? 'Reel' : 'Scroll'}`} tile={kind} onClose={close}>
      <ShareSheetBody
        target={{ assetId: entry.offer.assetId, assetRevision: entry.offer.assetRevision }}
        title={title}
        kind={kind}
        onClose={close}
      />
    </SheetPanel>
  );
}

/** What a report about the encounter in front names: the exact revision and the place the person was at. */
function feedbackTargetOf(entry: EncounterEntry): FeedbackTarget {
  const position = entry.position;
  const anchor: ContentErrorAnchor | undefined =
    position?.kind === 'reel'
      ? { kind: 'reel', positionMs: Math.min(86_400_000, Math.max(0, Math.round(position.positionMs))) }
      : position?.kind === 'scroll'
        ? { kind: 'scroll', blockId: position.value.blockId }
        : undefined;
  return {
    kind: 'asset',
    assetId: entry.offer.assetId,
    assetRevision: entry.offer.assetRevision,
    title: entry.offer.metadata.title,
    format: entry.kind,
    ...(anchor === undefined ? {} : { anchor }),
  };
}

/** P03 over the encounter: its menu (long-press or right-click) or a form (a row of ⋯). */
function FeedbackSheet({ state, session }: { readonly state: EncounterState; readonly session: EncounterSession }) {
  const entry = state.entry;
  if (!entry) return null;
  return (
    <SheetPanel title="Feedback" onClose={() => session.setOverlay(false)}>
      <FeedbackSheetBody
        target={feedbackTargetOf(entry)}
        start={state.feedbackStart ?? 'menu'}
        onClose={() => session.setOverlay(false)}
        onNotInterested={session.notInterested}
      />
    </SheetPanel>
  );
}

/**
 * The encounter's overlays, one at a time: the ⋯ menu with the person's path, the share sheet
 * and the request composer. They are local overlays, never history entries; Back and Esc close
 * the overlay first and playback stays paused where it was.
 */
export function EncounterSheets({
  state,
  session,
}: {
  readonly state: EncounterState;
  readonly session: EncounterSession;
}) {
  if (!state.overlay || !state.entry) return null;
  const owner = state.overlayOwner;
  const label =
    owner === 'request'
      ? 'Ask for something'
      : owner === 'share'
        ? 'Share'
        : owner === 'feedback'
          ? 'Feedback'
          : 'More';
  return (
    <EncounterOverlay label={label} presentation="sheet" onClose={() => session.back()}>
      {owner === 'request' ? (
        <RequestPanel
          session={session.requests}
          onClose={() => session.setOverlay(false)}
          ask={
            state.entry.kind === 'scroll' && isStageScroll(state.entry.scroll)
              ? { scroll: state.entry.scroll }
              : undefined
          }
        />
      ) : owner === 'share' ? (
        <ShareSheet state={state} session={session} />
      ) : owner === 'feedback' ? (
        <FeedbackSheet state={state} session={session} />
      ) : (
        <MoreSheet state={state} session={session} />
      )}
    </EncounterOverlay>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, justifyContent: 'flex-end' },
  viewport: {
    flexGrow: 0,
    maxHeight: '94%',
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    backgroundColor: content.paper,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
  },
  sheet: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingTop: spacing['2.5'],
    paddingHorizontal: layout.gutter,
    gap: spacing[3],
  },
  grab: {
    alignSelf: 'center',
    width: dimension.grabHandle.width,
    height: dimension.grabHandle.height,
    borderRadius: dimension.grabHandle.radius,
    backgroundColor: content.ink,
    opacity: opacity.grabHandle,
  },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[3] },
  tile: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headingText: { flex: 1, gap: spacing[1] },
  menu: { gap: 0 },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: 56,
    paddingVertical: spacing[2],
    borderTopWidth: 1,
    borderTopColor: content.rule,
    cursor: 'pointer' as const,
  },
  menuIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: opacity.disabled },
  path: { gap: spacing[2], paddingTop: spacing[2] },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    minHeight: 56,
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  pathPart: { backgroundColor: content.highlight },
  pathRelated: { borderStyle: 'dashed' },
  pathCurrent: { borderWidth: borderWidth.current },
  pathCopy: { flex: 1, gap: spacing['0.5'] },
});
