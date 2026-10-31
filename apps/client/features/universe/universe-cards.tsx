import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, IconButton, Text } from '@knowscroll/ui';
import type { PlanetPalette } from './planet/planet-palette';
import { countOf } from './universe-lists';
import type { UniversePlace, UniverseMapSession, UniverseViewState } from './universe-session';

/** The paper card the map shows for one place (U04 "Regions & topic card", U08 selection). */
function CardFrame({
  title,
  eyebrow,
  eyebrowColour = content.ink2,
  accent,
  glass = false,
  solid = false,
  docked = false,
  onClose,
  children,
  testID,
}: {
  title: string;
  eyebrow: string;
  eyebrowColour?: string;
  /** A dot before the kind line (the dark glass card). */
  accent?: string;
  /** Dark glass over the map instead of paper. */
  glass?: boolean;
  /** Simple drawing: the glass becomes the plain solid fill (D-111). */
  solid?: boolean;
  /** Docked in the desktop panel: a sunken paper card with no outline (D02). */
  docked?: boolean;
  onClose: () => void;
  children: ReactNode;
  testID: string;
}) {
  const headingRef = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const heading = headingRef.current as unknown as HTMLElement | null;
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, []);
  return (
    <View
      testID={testID}
      role="dialog"
      accessibilityLabel={title}
      style={[styles.card, glass ? styles.glass : null, solid ? styles.solid : null, docked ? styles.docked : null]}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardTitle}>
          {accent ? <View style={[styles.kindDot, { backgroundColor: accent, shadowColor: accent }]} /> : null}
          <Text variant="label" color={eyebrowColour}>
            {eyebrow}
          </Text>
        </View>
        <IconButton icon="close" label={`Close ${title}`} variant={glass ? 'onSpace' : 'plain'} onPress={onClose} />
      </View>
      <View ref={headingRef}>
        <Text variant="title" heading={2} {...(glass ? { color: '#ffffff' } : {})}>
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

/** A system picked on the far map: its name and the way in. It carries no counts or scores. */
export function SystemCard({ session, place }: { session: UniverseMapSession; place: UniversePlace }) {
  return (
    <CardFrame
      testID="universe-system-card"
      eyebrow="A system"
      title={place.label}
      onClose={() => session.select(null)}
    >
      <View style={styles.actions}>
        <Button label="Open system" variant="ink" onPress={() => session.focus(place.id)} />
        <Button label="Close" variant="ghost" onPress={() => session.select(null)} />
      </View>
    </CardFrame>
  );
}

/**
 * A planet picked on the desktop map (D02): its card docks at the top of the panel with Land, which
 * goes straight to its map, and Close. It says how many countries have formed and where the person
 * was last, from what the device already holds; it carries no scores.
 */
export function PlanetCard({
  session,
  place,
  system,
  countries,
  hereRegion,
}: {
  session: UniverseMapSession;
  place: UniversePlace;
  /** The name of the planet's system. */
  system: string | undefined;
  countries: number;
  hereRegion: string | undefined;
}) {
  return (
    <CardFrame
      testID="universe-planet-card"
      eyebrow={system === undefined ? 'A planet' : `A planet · ${system}`}
      title={place.label}
      docked
      onClose={() => session.select(null)}
    >
      <Text variant="bodyS" color={content.ink2}>
        {`${countOf(countries, 'country')}.`}
      </Text>
      {hereRegion ? (
        <View style={styles.hereLine}>
          <View style={styles.hereDot} />
          <Text variant="bodyS" color={content.ink2}>{`You were here last: ${hereRegion}.`}</Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        <Button
          label="Land"
          variant="ink"
          accessibilityLabel={`Land on ${place.label}`}
          onPress={() => session.focus(place.id, { land: true })}
        />
        <Button label="Close" variant="ghost" onPress={() => session.select(null)} />
      </View>
    </CardFrame>
  );
}

/** The dark glass of the region card (U04): what it is, where it is, what it offers. */
const GLASS = 'rgba(6,26,38,0.92)';
const GLASS_EDGE = 'rgba(255,255,255,0.15)';
const GLASS_TEXT = 'rgba(214,238,245,0.85)';
/** The fill that replaces the glass in Simple drawing. */
const SOLID = '#0D2230';
const DEFAULT_ACCENT = '#33c4b4';
const DEFAULT_KIND = '#8edbe0';

/**
 * A region's card: one encounter from it, with Open going straight in. Looking at a card is not an
 * encounter: only the Reel or Scroll that Open starts creates evidence. It is dark glass over the
 * map, its dot and kind line in the planet's own accent.
 */
export function RegionCard({
  session,
  state,
  place,
  palette,
  solid = false,
}: {
  session: UniverseMapSession;
  state: UniverseViewState;
  place: UniversePlace;
  palette?: PlanetPalette;
  /** Simple drawing: no glass. */
  solid?: boolean;
}) {
  const router = useRouter();
  const [blocked, setBlocked] = useState(false);
  const leaving = useRef(false);
  const preview = state.regionPreview;
  const displayed = preview.preview;
  const accent = palette?.accent ?? DEFAULT_ACCENT;
  useEffect(
    // Restore the exact selected pin after the card goes, unless the person is leaving for an encounter.
    () => () => {
      queueMicrotask(() => {
        if (Platform.OS === 'web' && !leaving.current && session.getState().read.active)
          document.querySelector<HTMLElement>(`[data-testid="universe-focus-${place.id}"]`)?.focus();
      });
    },
    [place.id, session],
  );
  const open = () => {
    if (!displayed) return;
    const accepted = session.openRegion(displayed, () => router.navigate('/universe'));
    if (accepted) {
      leaving.current = true;
      router.navigate('/explore');
    } else setBlocked(true);
  };
  const kind = displayed ? (displayed.encounter.metadata.kind === 'reel' ? 'A Reel' : 'A Scroll') : 'A region';
  const title = displayed ? displayed.encounter.metadata.title : place.label;
  const close = () => session.back();
  return (
    <CardFrame
      testID="universe-region-card"
      eyebrow={`${kind} · in ${place.label}`}
      eyebrowColour={palette?.cardKind ?? DEFAULT_KIND}
      accent={accent}
      title={title}
      onClose={close}
      glass
      solid={solid}
    >
      {displayed ? (
        <>
          <Text variant="bodyS" color={GLASS_TEXT}>
            {displayed.encounter.metadata.summary}
          </Text>
          <View style={styles.actions}>
            <Button label="Open" variant="space" icon="arrowRight" iconPosition="trailing" onPress={open} />
            <Button label="Close" variant="spaceGhost" onPress={close} />
          </View>
        </>
      ) : (
        <>
          <Text variant="bodyS" color={GLASS_TEXT}>
            {preview.status === 'loading'
              ? 'Finding an encounter from this region…'
              : preview.reason === 'network'
                ? 'Opens when you’re back online. This place is kept.'
                : 'Encounters from this region aren’t available yet.'}
          </Text>
          {preview.status !== 'loading' ? (
            <View style={styles.actions}>
              <Button
                label="Try again"
                variant="space"
                onPress={() => {
                  setBlocked(false);
                  session.refreshRegionPreview();
                }}
              />
              <Button label="Close" variant="spaceGhost" onPress={close} />
            </View>
          ) : null}
        </>
      )}
      {blocked ? (
        <View style={styles.actions}>
          <Text variant="bodyS" color={GLASS_TEXT}>
            An earlier encounter needs attention. Return to it before choosing another.
          </Text>
          <Button label="Return to encounter" variant="space" onPress={() => router.navigate('/explore')} />
        </View>
      ) : null}
    </CardFrame>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: content.paper,
    borderColor: content.ink,
    borderWidth: borderWidth.regular,
    borderRadius: radius.panel,
    padding: spacing[4],
    gap: spacing[2],
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  glass: {
    backgroundColor: GLASS,
    borderColor: GLASS_EDGE,
    borderWidth: 1,
    borderRadius: 24,
    padding: spacing[4],
  },
  solid: { backgroundColor: SOLID },
  docked: { backgroundColor: content.paper2, borderWidth: 0, borderRadius: 24, maxWidth: undefined },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  kindDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    shadowOpacity: 0.9,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
  },
  hereLine: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  hereDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#FF684C' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2], marginTop: spacing[2] },
});
