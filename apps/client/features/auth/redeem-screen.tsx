import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { borderWidth, content, radius, space, spacing, target } from '@knowscroll/design-tokens';
import type { PeekOutcome } from '@knowscroll/client-core';
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

/** What the server said about one token before redeeming it. */
type Peeked = { readonly token: string; readonly outcome: PeekOutcome };

/**
 * `/redeem`: where a sign-in link lands (`/redeem#token=…`; the token never reached a server), and
 * the paste path behind "I have a sign-in link". Opening the link signs nobody in. The page first
 * asks whose account the link opens and shows it masked; the person then confirms with one tap,
 * "Continue as m•••@example.com", which POSTs the token (review m8: a link someone else sent to
 * sign you into their account says so before anything happens; a mail scanner that fetches or
 * renders the page consumes nothing). One command ID per token, reused if the answer is lost, so a
 * retry replays instead of failing. An expired or used link goes to A02 "This link didn't work".
 */
export function RedeemScreen() {
  const router = useRouter();
  const { manager, state } = useAccountScope();
  const fromLink = useSignInLinkToken();
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [peeked, setPeeked] = useState<Peeked | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const commandIds = useRef(new Map<string, string>());
  const type = useTypeStyle('bodyS');
  const token = fromLink ?? tokenFromLink(pasted.includes('token=') ? pasted : `#token=${pasted.trim()}`);
  const switching = state.status === 'signed_in';
  const peek = peeked !== undefined && peeked.token === token ? peeked.outcome : undefined;

  useEffect(() => {
    if (token === undefined) return undefined;
    let current = true;
    void manager.peek(token).then((outcome) => {
      if (!current) return;
      if (outcome.kind === 'link_invalid') router.replace('/recover?reason=link');
      else setPeeked({ token, outcome });
    });
    return () => {
      current = false;
    };
  }, [manager, router, token, attempt]);

  const redeem = async () => {
    if (token === undefined || busy || peek?.kind !== 'usable') return;
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

  const shown: Failure | undefined =
    failure ??
    (peek?.kind === 'rate_limited' ? peek : peek?.kind === 'unavailable' ? { kind: 'unavailable' } : undefined);
  const checkFailed = peek !== undefined && peek.kind !== 'usable';
  const masked = peek?.kind === 'usable' ? peek.maskedEmail : undefined;
  const title = fromLink === undefined ? 'Use your sign-in link' : 'Finish signing in';

  return (
    <AuthFrame pageTitle={title} star={fromLink !== undefined}>
      <Text variant="displayL" color={space.label} heading={1}>
        {title}
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
      ) : null}
      {masked === undefined ? null : (
        <Text variant="body" color={space.label}>
          {switching
            ? `You're signed in as ${state.scope.account.email}. This link signs you in as ${masked} instead.`
            : `This link signs you in as ${masked}. Continue only if that's your email.`}
        </Text>
      )}
      {shown?.kind === 'rate_limited' ? (
        <Banner kind="info" lead="Too many tries." message={rateLimitMessage(shown.retryAfterSeconds)} />
      ) : null}
      {shown?.kind === 'unavailable' ? (
        <Banner kind="offline" lead="Can't reach KnowScroll." message="Check your connection and try again." />
      ) : null}
      {shown?.kind === 'refused' ? (
        <Banner kind="error" lead="Couldn't sign in." message="This account can't be opened right now." />
      ) : null}
      {checkFailed ? (
        <Button
          label="Try again"
          variant="space"
          surface="dark"
          fullWidth
          onPress={() => setAttempt((count) => count + 1)}
        />
      ) : (
        <Button
          label={masked === undefined ? 'Continue' : `Continue as ${masked}`}
          busyLabel={masked === undefined ? 'Checking the link…' : 'Signing in…'}
          busy={busy || (token !== undefined && peek === undefined)}
          disabled={masked === undefined}
          variant="space"
          surface="dark"
          fullWidth
          onPress={() => void redeem()}
        />
      )}
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
