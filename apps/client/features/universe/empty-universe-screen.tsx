import { useRouter } from 'expo-router';
import { StateBlock } from '@knowscroll/ui';
import { ScreenFrame } from '../shell/screen-frame';
import { SkyBackdrop } from './space/sky-backdrop';

/**
 * U01 "Empty · first visit": the universe before anything has been explored. No promises, no
 * counts; the only action goes to Explore. (Lately and List view have nothing to act on yet, so
 * they are not shown.)
 */
export function EmptyUniverseScreen() {
  const router = useRouter();
  return (
    <ScreenFrame
      tone="space"
      title="Your universe"
      pageTitle="Universe"
      titleVariant="heading"
      backdrop={<SkyBackdrop />}
      bodyPlacement="center"
    >
      <StateBlock
        tone="space"
        align="center"
        title="Your universe starts quiet."
        body="It takes shape from what you watch and read."
        actions={[
          {
            label: 'Go to Explore',
            icon: 'explore',
            variant: 'space',
            role: 'link',
            href: '/explore',
            onPress: () => router.navigate('/explore'),
          },
        ]}
      />
    </ScreenFrame>
  );
}
