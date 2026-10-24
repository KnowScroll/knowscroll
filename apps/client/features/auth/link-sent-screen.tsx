import { useRouter } from 'expo-router';
import { useState } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { borderWidth, content } from '@knowscroll/design-tokens';
import { Banner, Button, IconButton, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { AuthFrame } from './auth-frame';
import { rateLimitMessage } from './rate-limit-copy';

/** The yellow envelope of A01 "Link sent": a drawn glyph, hidden from assistive technology. */
function Envelope() {
  const stroke = borderWidth.regular;
  return (
    <Svg width={64} height={48} viewBox="0 0 64 48" aria-hidden importantForAccessibility="no-hide-descendants">
      <Rect
        x={2}
        y={2}
        width={60}
        height={44}
        rx={6}
        fill={content.continue}
        stroke={content.ink}
        strokeWidth={stroke}
      />
      <Path d="M4 8 L32 28 L60 8" fill="none" stroke={content.ink} strokeWidth={stroke} strokeLinejoin="round" />
    </Svg>
  );
}

type Resent =
  | { readonly kind: 'sent' }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | undefined }
  | { readonly kind: 'unavailable' };

/**
 * A01 · Link sent (`/signin/link`): "Check your inbox", the address (from this session only, never
 * the URL), the single-use banner, "Resend the link" (a new link; the server limits how often)
 * and "Use a different email". Reloaded without an address, it says so without one.
 */
export function LinkSentScreen() {
  const router = useRouter();
  const { manager } = useAccountScope();
  const email = manager.pendingEmail;
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState<Resent | undefined>(undefined);

  const resend = async () => {
    if (email === undefined || busy) return;
    setBusy(true);
    const outcome = await manager.requestLink(email);
    setBusy(false);
    if (outcome.kind === 'requested') setResent({ kind: 'sent' });
    else if (outcome.kind === 'rate_limited') setResent(outcome);
    else setResent({ kind: 'unavailable' });
  };

  return (
    <AuthFrame
      pageTitle="Check your inbox"
      ground="paper"
      leading={
        <IconButton
          icon="back"
          label="Back to the email form"
          variant="paper"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/signin'))}
        />
      }
    >
      <Envelope />
      <Text variant="displayL" heading={1}>
        Check your inbox
      </Text>
      <Text variant="body">
        {email === undefined
          ? 'We sent a sign-in link to your email address. Open it on this device to continue.'
          : `We sent a sign-in link to ${email}. Open it on this device to continue.`}
      </Text>
      <Banner
        kind="info"
        lead="One use."
        message="The link works once and expires after a short while. If it stops working, ask for a new one."
      />
      {resent?.kind === 'sent' ? <Banner kind="info" lead="Sent again." message="Use the newest link." /> : null}
      {resent?.kind === 'rate_limited' ? (
        <Banner kind="info" lead="Too many links." message={rateLimitMessage(resent.retryAfterSeconds)} />
      ) : null}
      {resent?.kind === 'unavailable' ? (
        <Banner kind="offline" lead="Can't reach KnowScroll." message="Check your connection and try again." />
      ) : null}
      {email === undefined ? null : (
        <Button
          label="Resend the link"
          busyLabel="Sending…"
          busy={busy}
          variant="default"
          fullWidth
          onPress={() => void resend()}
        />
      )}
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
