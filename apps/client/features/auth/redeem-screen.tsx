import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { borderWidth, content, radius, space, spacing, target } from '@knowscroll/design-tokens';
import { Banner, Button, Text, useTypeStyle } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { tokenFromLink, useSignInLinkToken } from '../../platform/sign-in-link';
import { useAccountScope } from '../../providers/account-scope';
import { AuthFrame } from './auth-frame';
import { rateLimitMessage } from './rate-limit-copy';

type Failure =
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | undefined }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'refused' };

/**
 * `/redeem`: where a sign-in link lands (`/redeem#token=…`; the token never reached a server), and
 * the paste path behind "I have a sign-in link". Opening the link signs nobody in: the person
 * confirms with one tap, which POSTs the token (a mail scanner that fetches or renders the page
 * consumes nothing). One command ID per token, reused if the answer is lost, so a retry replays
 * instead of failing. An expired or used link goes to A02 "This link didn't work".
 */
export function RedeemScreen() {
  const router = useRouter();
  const { manager, state } = useAccountScope();
  const fromLink = useSignInLinkToken();
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const commandIds = useRef(new Map<string, string>());
  const type = useTypeStyle('bodyS');
  const token = fromLink ?? tokenFromLink(pasted.includes('token=') ? pasted : `#token=${pasted.trim()}`);
  const switching = state.status === 'signed_in';

  const redeem = async () => {
    if (token === undefined || busy) return;
    let commandId = commandIds.current.get(token);
    if (commandId === undefined) {
      commandId = newCommandId();
      commandIds.current.set(token, commandId);
    }
    setBusy(true);
    setFailure(undefined);
    const outcome = await manager.redeem({ token, commandId });
    setBusy(false);
    switch (outcome.kind) {
      case 'signed_in':
        router.replace('/explore');
        return;
      case 'link_invalid':
        router.replace('/recover?reason=link');
        return;
      case 'rate_limited':
        setFailure(outcome);
        return;
      case 'unavailable':
        setFailure({ kind: 'unavailable' });
        return;
      case 'refused':
        setFailure({ kind: 'refused' });
        return;
    }
  };

  return (
    <AuthFrame
      pageTitle={fromLink === undefined ? 'Use your sign-in link' : 'Finish signing in'}
      star={fromLink !== undefined}
    >
      <Text variant="displayL" color={space.label} heading={1}>
        {fromLink === undefined ? 'Use your sign-in link' : 'Finish signing in'}
      </Text>
      {fromLink === undefined ? (
        <>
          <Text variant="body" color={space.label}>
            Paste the link from the email we sent you.
          </Text>
          <TextInput
            value={pasted}
            onChangeText={setPasted}
            accessibilityLabel="Sign-in link"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            inputMode="url"
            placeholder="https://…/redeem#token=…"
            placeholderTextColor={content.muted}
            style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize }]}
          />
        </>
      ) : (
        <Text variant="body" color={space.label}>
          {switching
            ? `You're signed in as ${state.scope.account.email}. Continuing signs you in with this link instead.`
            : 'Continue to sign in on this device.'}
        </Text>
      )}
      {failure?.kind === 'rate_limited' ? (
        <Banner kind="info" lead="Too many tries." message={rateLimitMessage(failure.retryAfterSeconds)} />
      ) : null}
      {failure?.kind === 'unavailable' ? (
        <Banner kind="offline" lead="Can't reach KnowScroll." message="Check your connection and try again." />
      ) : null}
      {failure?.kind === 'refused' ? (
        <Banner kind="error" lead="Couldn't sign in." message="This account can't be opened right now." />
      ) : null}
      <Button
        label="Sign in"
        busyLabel="Signing in…"
        busy={busy}
        disabled={token === undefined}
        variant="space"
        surface="dark"
        fullWidth
        onPress={() => void redeem()}
      />
      <Button
        label="Get a new link"
        variant="ink"
        role="link"
        href="/signin"
        surface="dark"
        fullWidth
        onPress={() => router.replace('/signin')}
      />
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  input: {
    alignSelf: 'stretch',
    minHeight: target.comfortable,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: radius.md,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    color: content.ink,
  },
});
