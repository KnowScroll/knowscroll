import { useRouter } from 'expo-router';
import { useState } from 'react';
import { space } from '@knowscroll/design-tokens';
import { Banner, Button, IconButton, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { AuthFrame } from './auth-frame';
import { EmailField } from './email-field';
import { rateLimitMessage } from './rate-limit-copy';

const addressShape = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/u;

type Problem =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | undefined }
  | { readonly kind: 'unavailable' };

/**
 * The email form behind "Continue with email" (`/signin`; A01 notes, undrawn): one labelled
 * field, then "Send sign-in link". The answer is the same for every address (the server never
 * says whether an account exists), so the next screen always says a link was sent.
 * States: idle · invalid address · sending · too many requests · offline/unavailable.
 */
export function SignInScreen() {
  const router = useRouter();
  const { manager } = useAccountScope();
  const [email, setEmail] = useState(manager.pendingEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const submit = async () => {
    if (busy) return;
    if (!addressShape.test(email.trim())) {
      setProblem({ kind: 'invalid' });
      return;
    }
    setBusy(true);
    setProblem(undefined);
    const outcome = await manager.requestLink(email);
    setBusy(false);
    switch (outcome.kind) {
      case 'requested':
        router.push('/signin/link');
        return;
      case 'invalid_address':
        setProblem({ kind: 'invalid' });
        return;
      case 'rate_limited':
        setProblem({ kind: 'rate_limited', retryAfterSeconds: outcome.retryAfterSeconds });
        return;
      case 'unavailable':
        setProblem({ kind: 'unavailable' });
        return;
    }
  };

  return (
    <AuthFrame
      pageTitle="Sign in"
      leading={
        <IconButton
          icon="back"
          label="Back"
          variant="onSpace"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))}
        />
      }
    >
      <Text variant="displayL" color={space.label} heading={1}>
        Sign in with email
      </Text>
      <Text variant="body" color={space.label}>
        We'll send you a link. It signs you in on the device where you open it.
      </Text>
      <EmailField
        value={email}
        onChangeText={(value) => {
          setEmail(value);
          if (problem?.kind === 'invalid') setProblem(undefined);
        }}
        onSubmit={() => void submit()}
        disabled={busy}
        {...(problem?.kind === 'invalid' ? { error: 'Enter an email address like name@example.com.' } : {})}
      />
      {problem?.kind === 'rate_limited' ? (
        <Banner kind="info" lead="Too many links." message={rateLimitMessage(problem.retryAfterSeconds)} />
      ) : null}
      {problem?.kind === 'unavailable' ? (
        <Banner
          kind="offline"
          lead="Can't reach KnowScroll."
          message="Check your connection and send the link again."
        />
      ) : null}
      <Button
        label="Send sign-in link"
        busyLabel="Sending…"
        busy={busy}
        variant="space"
        surface="dark"
        fullWidth
        onPress={() => void submit()}
      />
    </AuthFrame>
  );
}
