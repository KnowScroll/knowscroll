import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Text } from '@knowscroll/ui';
import { UniversePanel } from './universe-outline';
import type { UniverseViewSession } from './universe-session';

export function UniversePlaceCard({ session }: { session: UniverseViewSession }) {
  const router = useRouter(),
    state = session.getState(),
    places = session.places();
  const [blocked, setBlocked] = useState(false);
  const leaving = useRef(false);
  const place = places.find((p) => p.id === state.focusId);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const title = document.querySelector<HTMLElement>(
      '[data-testid="universe-panel"] h2, [data-testid="universe-panel"] [role="heading"]',
    );
    if (title) {
      title.tabIndex = -1;
      title.focus();
    }
    // Restore the exact selected pin after the modal host's own cleanup.
    return () => {
      queueMicrotask(() => {
        if (!leaving.current && session.getState().read.active)
          document.querySelector<HTMLElement>(`[data-testid="universe-focus-${place?.id}"]`)?.focus();
      });
    };
  }, [place?.id, session]);
  if (!place) return null;
  const parent = places.find((p) => p.id === place.parentId),
    preview = state.regionPreview;
  const displayed = preview.preview;
  const open = () => {
    if (!displayed) return;
    const accepted = session.openRegion(displayed, () => router.navigate('/universe'));
    if (accepted) {
      leaving.current = true;
      router.navigate('/explore');
    } else setBlocked(true);
  };
  return (
    <UniversePanel title={place.label} close={() => session.back()}>
      <Text variant="meta">
        {place.kind}
        {parent ? ` · ${parent.label}` : ''}
        {place.truthStatus === 'hypothetical' ? ' · Hypothetical' : ''}
      </Text>
      {displayed ? (
        <View accessibilityLabel="Encounter from this region">
          <Text variant="meta">
            {displayed.encounter.metadata.kind === 'reel' ? 'A Reel' : 'A Scroll'} · in {place.label}
          </Text>
          <Text variant="heading" heading={3}>
            {displayed.encounter.metadata.title}
          </Text>
          <Text variant="body">{displayed.encounter.metadata.summary}</Text>
          <Button label="Open" onPress={open} />
          <Button label={`More in ${place.label}`} variant="ghost" onPress={open} />
        </View>
      ) : (
        <Text variant="body">
          {preview.status === 'loading'
            ? 'Finding an encounter from this region…'
            : preview.reason === 'network'
              ? 'You’re offline. This place is kept; try again when connected.'
              : 'Encounters from this place aren’t available.'}
        </Text>
      )}
      {blocked ? (
        <>
          <Text variant="body">An earlier encounter needs attention. Return to it before choosing another.</Text>
          <Button label="Return to encounter" onPress={() => router.navigate('/explore')} />
        </>
      ) : null}
      {place.kind === 'region' ? (
        <Button
          label="Refresh encounter"
          onPress={() => {
            setBlocked(false);
            session.refreshRegionPreview();
          }}
        />
      ) : null}
    </UniversePanel>
  );
}
