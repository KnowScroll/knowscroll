import { StyleSheet, View } from 'react-native';
import { FormatSwitch, IconButton, Tag, type FormatAvailability } from '@knowscroll/ui';
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
}: {
  readonly entry: EncounterEntry;
  readonly session: EncounterSession;
  readonly showIcons?: boolean;
}) {
  return (
    <FormatSwitch
      selected={entry.kind}
      availability={formatAvailability(entry)}
      showIcons={showIcons}
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
  return (
    <View style={styles.bar} pointerEvents="box-none">
      {onMedia ? null : <IconButton icon="back" label="Back" variant="paper" onPress={back} />}
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
      <EncounterFormatSwitch entry={entry} session={session} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  spacer: { flex: 1 },
});
