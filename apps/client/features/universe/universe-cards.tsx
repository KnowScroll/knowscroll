import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, IconButton, Text } from '@knowscroll/ui';
import type { UniversePlace, UniverseViewSession, UniverseViewState } from './universe-session';

/** The paper card the map shows for one place (U04 "Regions & topic card", U08 selection). */
function CardFrame({
  title,
  eyebrow,
  onClose,
  children,
  testID,
}: {
  title: string;
  eyebrow: string;
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
    <View testID={testID} role="dialog" accessibilityLabel={title} style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardTitle}>
          <Text variant="label" color={content.ink2}>
            {eyebrow}
          </Text>
        </View>
        <IconButton icon="close" label={`Close ${title}`} variant="plain" onPress={onClose} />
      </View>
      <View ref={headingRef}>
        <Text variant="title" heading={2}>
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

/** A system picked on the far map: its name and the way in. It carries no counts or scores. */
export function SystemCard({ session, place }: { session: UniverseViewSession; place: UniversePlace }) {
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
 * A region's card: one encounter from it, with Open going straight in. Looking at a card is not an
 * encounter: only the Reel or Scroll that Open starts creates evidence.
 */
export function RegionCard({
  session,
  state,
  place,
}: {
  session: UniverseViewSession;
  state: UniverseViewState;
  place: UniversePlace;
}) {
  const router = useRouter();
  const [blocked, setBlocked] = useState(false);
  const leaving = useRef(false);
  const preview = state.regionPreview;
  const displayed = preview.preview;
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
  return (
    <CardFrame
      testID="universe-region-card"
      eyebrow={`${kind} · in ${place.label}`}
      title={displayed ? displayed.encounter.metadata.title : place.label}
      onClose={() => session.back()}
    >
      {displayed ? (
        <>
          <Text variant="bodyS" color={content.ink2}>
            {displayed.encounter.metadata.summary}
          </Text>
          <View style={styles.actions}>
            <Button label="Open" variant="ink" onPress={open} />
            <Button label="Close" variant="ghost" onPress={() => session.back()} />
            <Pressable accessibilityRole="link" onPress={open} style={styles.link}>
              <Text variant="uiS" color={content.accentDeep} style={styles.underline}>
                {`More in ${place.label}`}
              </Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <Text variant="bodyS" color={content.ink2}>
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
                variant="ghost"
                onPress={() => {
                  setBlocked(false);
                  session.refreshRegionPreview();
                }}
              />
              <Button label="Close" variant="ghost" onPress={() => session.back()} />
            </View>
          ) : null}
        </>
      )}
      {blocked ? (
        <View style={styles.actions}>
          <Text variant="bodyS" color={content.ink2}>
            An earlier encounter needs attention. Return to it before choosing another.
          </Text>
          <Button label="Return to encounter" variant="ink" onPress={() => router.navigate('/explore')} />
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
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2], marginTop: spacing[2] },
  link: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing[2] },
  underline: { textDecorationLine: 'underline' },
});
