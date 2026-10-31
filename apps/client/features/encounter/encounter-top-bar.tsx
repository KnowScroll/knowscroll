import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { FormatSwitch, IconButton, Tag, useDisplay, type FormatAvailability } from '@knowscroll/ui';
import { spacing } from '@knowscroll/design-tokens';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession } from './encounter-session';

type Format = 'reel' | 'scroll';

/** What the switch offers for the other format: open it, watch it prepare, or ask for it. */
export function formatAvailability(entry: EncounterEntry): Record<Format, FormatAvailability> {
  const availability: Record<Format, FormatAvailability> = { reel: 'requestable', scroll: 'requestable' };
  for (const variant of entry.context.variants)
    availability[variant.kind] =
      variant.status === 'ready' ? 'ready' : variant.status === 'pending' ? 'preparing' : 'requestable';
  return availability;
}

/** The Reel/Scroll switch: choosing a ready sibling opens it, a missing one opens the request sheet (E06). */
export function EncounterFormatSwitch({
  entry,
  session,
  showIcons = true,
  terse = false,
}: {
  readonly entry: EncounterEntry;
  readonly session: EncounterSession;
  readonly showIcons?: boolean;
  /** Only "Reel" and "Scroll" are drawn, for a bar with no room for their state (the reader's, on a phone). */
  readonly terse?: boolean;
}) {
  return (
    <FormatSwitch
      selected={entry.kind}
      availability={formatAvailability(entry)}
      showIcons={showIcons}
      terse={terse}
      onSelect={(to) => {
        const sibling = entry.context.variants.find((variant) => variant.kind === to);
        if (sibling?.status === 'ready') session.navigate({ mode: 'variant', to });
        else session.openRequest(to);
      }}
    />
  );
}

/**
 * The top row of an encounter (E01, E02): Back on a Scroll, the format switch, and the ⋯ menu,
 * in the same places for both formats. Choosing a ready sibling opens it; choosing a missing one
 * opens the request sheet (E06). Account and settings live in the ⋯ menu.
 *
 * A Reel has the same two buttons a Scroll has (V3 Q16, D-246): Your Universe at the left and Next ↑ at the right, for
 * the times a swipe does not work. Nothing else about a Reel changes: Reel and Scroll keep equal standing, so neither
 * format is given a control the other lacks.
 */
export function EncounterTopBar({
  entry,
  session,
  surface,
  back,
}: {
  readonly entry: EncounterEntry;
  readonly session: EncounterSession;
  readonly surface: 'media' | 'paper';
  readonly back: () => void;
}) {
  const onMedia = surface === 'media';
  const router = useRouter();
  const { breakpoint } = useDisplay();
  const narrow = breakpoint === 'compact' || breakpoint === 'phone';
  return (
    <View style={styles.bar} pointerEvents="box-none">
      {onMedia ? (
        <IconButton
          icon="universe"
          label="Your Universe"
          variant="onMedia"
          onPress={() => router.navigate('/universe')}
        />
      ) : (
        <IconButton icon="back" label="Back" variant="paper" onPress={back} />
      )}
      <View style={styles.spacer} pointerEvents="none" />
      {onMedia && entry.kind === 'reel' && entry.document.fixture ? (
        <Tag label="Fixture video" variant="onDark" />
      ) : null}
      <IconButton
        icon="more"
        label="More options"
        variant={onMedia ? 'onMedia' : 'paper'}
        onPress={() => session.setOverlay(true)}
      />
      <EncounterFormatSwitch
        entry={entry}
        session={session}
        showIcons={!narrow || !onMedia}
        terse={narrow && onMedia}
      />
      {onMedia ? (
        <IconButton
          icon="arrowUp"
          label="Next topic"
          variant="onMedia"
          onPress={() => session.navigate({ mode: 'vertical', direction: 'next' })}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing[2], rowGap: spacing[1] },
  spacer: { flex: 1 },
});
