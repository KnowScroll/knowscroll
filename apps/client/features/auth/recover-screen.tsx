import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing, status } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Tag, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { AuthFrame } from './auth-frame';
import { rateLimitMessage } from './rate-limit-copy';

/**
 * A02 (`/recover`): `?reason=link` is "This link didn't work" (expired or already used; nothing
 * about the account changed; send a fresh link to the same address when this session knows it).
 * Otherwise "You were signed out" (the server no longer accepts this device's session). The
 * held-destination card waits for a same-account local resume record, which no surface writes
 * yet; it is not drawn without one.
 */
export function RecoverScreen() {
  const router = useRouter();
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const { manager } = useAccountScope();
  const email = manager.pendingEmail;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const sendNewLink = async () => {
    if (email === undefined) {
      router.replace('/signin');
      return;
    }
    setBusy(true);
    const outcome = await manager.requestLink(email);
    setBusy(false);
    if (outcome.kind === 'requested') router.replace('/signin/link');
    else if (outcome.kind === 'rate_limited') setNotice(rateLimitMessage(outcome.retryAfterSeconds));
    else setNotice("Can't reach KnowScroll. Check your connection and try again.");
  };

  if (reason === 'link') {
    return (
      <AuthFrame pageTitle="This link didn't work" ground="paper">
        <View aria-hidden style={styles.glyph}>
          <Icon name="link" size={48} color={status.danger.fill} />
        </View>
        <Text variant="displayL" heading={1}>
          This link didn't work
        </Text>
        <Banner kind="error" lead="Expired or already used." message="Nothing about your account changed." />
        <Text variant="body">
          {email === undefined
            ? "We'll send a fresh link to your email address."
            : `We'll send a fresh link to ${email}.`}
        </Text>
        {notice === undefined ? null : <Banner kind="info" lead="Not yet." message={notice} />}
        <Button
          label="Send a new link"
          busyLabel="Sending…"
          busy={busy}
          variant="primary"
          fullWidth
          onPress={() => void sendNewLink()}
        />
        <Button
          label="Use a different email"
          variant="default"
          role="link"
          href="/signin"
          fullWidth
          onPress={() => router.replace('/signin')}
        />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame pageTitle="You were signed out" ground="paper">
      <Tag label="Signed out" />
      <Text variant="displayL" heading={1}>
        You were signed out
      </Text>
      <Text variant="body">It's been a while on this device. Sign in again to carry on.</Text>
      <Button
        label="Sign in again"
        variant="primary"
        role="link"
        href="/signin"
        fullWidth
        onPress={() => router.replace('/signin')}
      />
      <Button
        label="Not you? Use another email"
        variant="default"
        role="link"
        href="/signin"
        fullWidth
        onPress={() => router.replace('/signin')}
      />
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  glyph: { paddingBottom: spacing[2] },
});
