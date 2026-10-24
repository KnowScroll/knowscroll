import { useRouter } from 'expo-router';
import { spacing } from '@knowscroll/design-tokens';
import { IconButton } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';
import { RequestsList, type ReadyRequestTarget } from './requests-list';
import { useRequestsList } from './use-requests-list';

/** The signed-in person's requests list: `/account/requests` and Keep's Requested view both mount it. */
export function SignedInRequests({ scope }: { readonly scope: Parameters<typeof useRequestsList>[0] }) {
  const router = useRouter();
  const session = useRequestsList(scope);
  const open = (target: ReadyRequestTarget) => router.push(`/${target.kind}/${target.assetId}`);
  return session ? <RequestsList session={session} onOpen={open} onAsk={() => router.navigate('/explore')} /> : null;
}

/**
 * `/account/requests`: what the person asked for and where each ask stands (E07). Their own asks only;
 * the same list can sit in Keep's "Requested" view, which mounts `RequestsList` with this hook.
 */
export function RequestsScreen() {
  const router = useRouter();
  const { state } = useAccountScope();
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.navigate('/account');
  };
  return (
    <ScreenFrame
      tone="paper"
      title="Your requests"
      pageTitle="Requests"
      showAccount={false}
      bodyOffset={spacing[7]}
      leading={<IconButton icon="back" label="Back" onPress={back} />}
    >
      {state.status === 'signed_in' ? <SignedInRequests scope={state.scope} /> : null}
    </ScreenFrame>
  );
}
