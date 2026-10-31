import { StyleSheet, View } from 'react-native';
import { answerStage, chipText, kindWord } from '@knowscroll/client-core';
import type { Assumption, ScenarioCard } from '@knowscroll/contracts';
import { borderWidth, content, elevation, radius, spacing, status } from '@knowscroll/design-tokens';
import { Button, Icon, PendingStripe, Tag, Text } from '@knowscroll/ui';
import { BranchMenu, SPECULATIVE_NOTICE } from './branch-parts';
import { WhatIfCard } from './what-if-card';

/** A chip of what a branch changes (dashed cobalt, as the premise) or keeps (ink). */
function Chip({ prefix, assumption }: { readonly prefix: 'Changed' | 'Kept'; readonly assumption: Assumption }) {
  const changed = prefix === 'Changed';
  return (
    <View style={[styles.chip, changed ? styles.changed : styles.kept]}>
      <Text variant="uiS" color={changed ? status.hypothetical.foreground : content.ink}>
        {chipText(prefix, assumption)}
      </Text>
    </View>
  );
}

/** The card's accessible name: the kind and its status in words, then the title (X02, accessibility). */
export function branchLabel(card: ScenarioCard): string {
  const kind = card.hypothetical ? `${kindWord(card)}, hypothetical` : kindWord(card);
  const state =
    card.status === 'preparing'
      ? 'preparing'
      : card.status === 'failed'
        ? 'could not be prepared'
        : card.status === 'removed'
          ? 'removed'
          : 'ready';
  return `${kind}: ${card.title}, ${state}`;
}

/**
 * A branch in the conversation (X02). A what-if is a dashed cobalt card with its premise; another
 * perspective is solid with its own title. Neither is numbered as a part. Preparing says so plainly
 * and the chat goes on; Ready offers to explore it; unable to prepare says so and offers to remove
 * it. Explore this is the card's one action; asking What if from it and removing it (by whoever started
 * it) are in ⋯. A branch the premise of which the Planner flagged says Speculative. "Opened by you" is the
 * caller's own history, told by the server to them alone; nobody is moved when someone else opens a branch,
 * and the card names no one's position.
 */
export function BranchCard({
  card,
  starterIsYou,
  startedLine,
  openedByYou,
  now = new Date(),
  onOpen,
  onRemove,
  onContinue,
}: {
  readonly card: ScenarioCard;
  readonly starterIsYou: boolean;
  /** "from the thread", "from Ravi’s message", "from a moment": where it began, in words. */
  readonly startedLine: string;
  /** The time the card is judged at (how long a short answer has been waited for). */
  readonly now?: Date;
  /** This member opened the branch's Scroll (their own history; the server tells no one else's). */
  readonly openedByYou: boolean;
  readonly onOpen: (card: ScenarioCard) => void;
  readonly onRemove: (card: ScenarioCard) => void;
  /** Asks What if… from this branch (the new branch continues it). Offered once its Scroll exists. */
  readonly onContinue: (card: ScenarioCard) => void;
}) {
  if (card.status === 'removed')
    return (
      <View style={styles.removed} role="article" accessibilityLabel={branchLabel(card)}>
        <Text variant="meta" color={content.ink2}>
          A branch was removed · nothing else changed
        </Text>
      </View>
    );
  const stage = answerStage(card, now);
  // A what-if with a short answer, being made or ready, is the T3 card (D-211); every other branch is the card it was.
  if (stage === 'making' || stage === 'slow' || stage === 'ready')
    return (
      <WhatIfCard
        card={card}
        now={now}
        starterIsYou={starterIsYou}
        startedLine={startedLine}
        openedByYou={openedByYou}
        onOpen={onOpen}
        onRemove={onRemove}
        onContinue={onContinue}
      />
    );
  const failed = card.status === 'failed';
  const asker = starterIsYou
    ? 'Asked by you'
    : card.startedBy === undefined
      ? 'Asked in this thread'
      : `Asked by ${card.startedBy.displayName}`;
  return (
    <View
      role="article"
      accessibilityLabel={branchLabel(card)}
      style={[styles.card, card.hypothetical ? styles.hypothetical : styles.perspective, failed ? styles.failed : null]}
      testID="branch-card"
    >
      <View style={styles.kicker}>
        <Text variant="monoXs" color={card.hypothetical ? status.hypothetical.foreground : content.ink2}>
          {kindWord(card).toUpperCase()}
        </Text>
        {card.hypothetical ? (
          <Tag variant="hypothetical" label={card.speculative ? 'Speculative' : 'Hypothetical'} />
        ) : null}
      </View>
      <Text variant="title" heading={3}>
        {card.title}
      </Text>
      {card.lens === undefined ? null : (
        <Text variant="bodyS" color={content.ink2}>
          Through the lens of {card.lens}
        </Text>
      )}
      {card.changes.length === 0 && card.kept.length === 0 ? null : (
        <View style={styles.chips}>
          {card.changes.map((change) => (
            <Chip key={`c-${change.subject}`} prefix="Changed" assumption={change} />
          ))}
          {card.kept.map((keep) => (
            <Chip key={`k-${keep.subject}`} prefix="Kept" assumption={keep} />
          ))}
        </View>
      )}
      {card.speculative ? (
        <Text variant="uiS" color={status.hypothetical.foreground}>
          {SPECULATIVE_NOTICE}
        </Text>
      ) : null}
      <Text variant="meta" color={content.ink2}>
        {asker} · {startedLine}
      </Text>
      {stage === 'unavailable' ? (
        <Text variant="meta" color={content.ink2} testID="no-short-answer">
          No short answer this time.
        </Text>
      ) : null}
      {openedByYou ? (
        <View style={styles.opened}>
          <Icon name="check" size={14} color={content.freshInk} />
          <Text variant="metaS" color={content.freshInk}>
            Opened by you
          </Text>
        </View>
      ) : null}

      {card.status === 'preparing' ? (
        <>
          <View style={styles.preparing} role="status" accessibilityLabel="Preparing the first Scroll">
            <PendingStripe compact />
            <Text variant="uiS">Preparing the first Scroll</Text>
          </View>
          <Text variant="meta" color={content.ink2}>
            The chat goes on. This card changes when it is ready.
          </Text>
        </>
      ) : null}
      {failed ? (
        <View style={styles.failure} role="alert">
          <Icon name="retry" size={16} color={status.danger.foreground} />
          <Text variant="uiS" color={status.danger.foreground}>
            Couldn’t prepare this branch
          </Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        {card.status === 'ready' ? (
          <Button
            label="Explore this"
            variant="ghost"
            size="sm"
            icon="forward"
            iconPosition="trailing"
            onPress={() => onOpen(card)}
          />
        ) : null}
        {(failed || card.status === 'preparing') && starterIsYou ? (
          <Button label="Remove" variant="ghost" size="sm" onPress={() => onRemove(card)} />
        ) : null}
        {card.status === 'ready' ? (
          <BranchMenu card={card} starterIsYou={starterIsYou} onRemove={onRemove} onContinue={onContinue} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing[2], padding: spacing[4], borderRadius: radius.panel, maxWidth: '100%', width: 340 },
  hypothetical: {
    backgroundColor: status.hypothetical.background,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: status.hypothetical.edge,
  },
  perspective: {
    backgroundColor: content.paper,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    boxShadow: elevation.raised,
  },
  failed: { borderColor: status.danger.edge, backgroundColor: content.paper },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: {
    maxWidth: '100%',
    flexShrink: 1,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radius.card,
    borderWidth: borderWidth.light,
  },
  changed: { borderStyle: 'dashed', borderColor: status.hypothetical.edge, backgroundColor: content.paper },
  kept: { borderColor: content.ink, backgroundColor: content.paper },
  preparing: {
    alignSelf: 'flex-start',
    overflow: 'hidden',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
  },
  failure: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  actions: { flexDirection: 'row', gap: spacing[2], flexWrap: 'wrap', alignItems: 'center' },
  opened: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  removed: {
    alignSelf: 'center',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radius.pill,
    borderWidth: borderWidth.light,
    borderColor: content.muted,
  },
});
