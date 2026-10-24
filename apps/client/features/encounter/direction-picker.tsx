import { useEffect } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { borderWidth, content, elevation, radius, spacing, target } from '@knowscroll/design-tokens';
import { Button, Tag, Text, useFocusRing } from '@knowscroll/ui';
import type { EncounterOffer } from '@knowscroll/contracts';
import { useEncounterMetrics } from './encounter-metrics';

/** A Reel is the cobalt poster the app draws everywhere; a Scroll is the sunken page. */
const GROUND = {
  reel: { backgroundColor: content.accent, color: content.onAccent },
  scroll: { backgroundColor: content.paper2, color: content.ink },
} as const;

function Direction({ offer, onPick }: { readonly offer: EncounterOffer; readonly onPick: () => void }) {
  const focus = useFocusRing('onLight');
  const kind = offer.metadata.kind;
  const ground = GROUND[kind];
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`${offer.metadata.title}. ${kind === 'reel' ? 'Reel' : 'Scroll'}`}
      onPress={onPick}
      style={[styles.card, { backgroundColor: ground.backgroundColor }, focus.style]}
    >
      <Tag label={kind === 'reel' ? 'Reel' : 'Scroll'} variant="neutral" />
      <Text variant="title" heading={2} color={ground.color}>
        {offer.metadata.title}
      </Text>
    </Pressable>
  );
}

/**
 * E08 "Somewhere new": a few real subjects the feed offered, titles and format only (no counts, no
 * "you learned"). Choosing one opens it; leaving, Back or Escape returns to the ending. Looking at
 * the choices records nothing: none of them is opened until one is picked.
 */
export function DirectionPicker({
  choices,
  onPick,
  onLeave,
}: {
  readonly choices: readonly EncounterOffer[];
  readonly onPick: (offerId: string) => void;
  readonly onLeave: () => void;
}) {
  const insets = useSafeAreaInsets();
  const metrics = useEncounterMetrics();
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onLeave();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onLeave]);
  return (
    <View testID="encounter-directions" style={styles.ground}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing[8], paddingBottom: metrics.bottom + spacing[6] },
        ]}
      >
        <View style={styles.column}>
          <Text variant="label" color={content.ink2}>
            Pick a direction
          </Text>
          <Text variant="displayL" heading={1}>
            Somewhere new
          </Text>
          <View style={styles.list}>
            {choices.map((offer) => (
              <Direction key={offer.offerId} offer={offer} onPick={() => onPick(offer.offerId)} />
            ))}
          </View>
          <Button label="Not now" variant="ghost" onPress={onLeave} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: content.paper },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: spacing[5] },
  column: { width: '100%', maxWidth: 480, alignSelf: 'center', gap: spacing[4] },
  list: { gap: spacing[3] },
  card: {
    minHeight: target.comfortable,
    gap: spacing[3],
    alignItems: 'flex-start',
    padding: spacing[4],
    borderRadius: radius.lg,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    boxShadow: elevation.heroInk,
    cursor: 'pointer' as const,
  },
});
