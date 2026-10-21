import { useRouter } from 'expo-router';
import { Button, Text } from '@knowscroll/ui';
import { UniversePanel } from './universe-outline';
import type { UniverseViewSession } from './universe-session';
export function UniversePlaceCard({ session }: { session: UniverseViewSession }) {
  const router = useRouter(),
    state = session.getState(),
    places = session.places();
  const place = places.find((p) => p.id === state.focusId);
  if (!place) return null;
  const parent = places.find((p) => p.id === place.parentId);
  return (
    <UniversePanel title={place.label} close={() => session.back()}>
      <Text variant="meta">
        {place.kind}
        {parent ? ` · ${parent.label}` : ''}
        {place.truthStatus === 'hypothetical' ? ' · Hypothetical' : ''}
      </Text>
      <Text variant="body">Encounters from this place aren’t available.</Text>
      <Button
        label="Go to Explore"
        role="link"
        href="/explore"
        onPress={() => {
          session.showOverlay(null);
          router.navigate('/explore');
        }}
      />
    </UniversePanel>
  );
}
