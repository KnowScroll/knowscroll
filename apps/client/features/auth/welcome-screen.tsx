import { Redirect, useRouter } from 'expo-router';
import { space } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { DeletionReceiptPanel } from '../account/deletion-receipt-panel';
import { AuthFrame } from './auth-frame';

/**
 * A01 · Sign in (`/welcome`): the wordmark on the spatial ground, "Continue with email" and "I
 * have a sign-in link". No interest survey, no password. A device that asked for its account to be
 * deleted shows that deletion's receipt first. The export's "Other sign-in options"
 * placeholder is not drawn: there is no such option (a control without a backend is not shown).
 * A signed-in person goes straight to Explore.
 */
export function WelcomeScreen() {
  const router = useRouter();
  const { state } = useAccountScope();
  if (state.status === 'signed_in') return <Redirect href="/explore" />;
  return (
    <AuthFrame pageTitle="Welcome" star>
      <Text variant="displayXl" color={space.label} heading={1}>
        KnowScroll
      </Text>
      <DeletionReceiptPanel />
      <Text variant="body" color={space.label}>
        Thoughtful Reels and Scrolls. A universe that grows from what you explore.
      </Text>
      <Button
        label="Continue with email"
        variant="spacePrimary"
        role="link"
        href="/signin"
        surface="dark"
        fullWidth
        onPress={() => router.push('/signin')}
      />
      <Button
        label="I have a sign-in link"
        variant="spaceGhost"
        role="link"
        href="/redeem"
        surface="dark"
        fullWidth
        onPress={() => router.push('/redeem')}
      />
      <Text variant="meta" color={space.label2}>
        No questions to answer first. Your universe starts quiet.
      </Text>
    </AuthFrame>
  );
}
