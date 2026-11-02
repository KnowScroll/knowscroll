import { StateBlock } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { useClearProgress } from '../privacy/clear-progress';
import { SharedLinksPanel } from './shared-links-panel';

/**
 * The privacy panel of the links the person has shared (P02): see each live link and stop it. The
 * Privacy hub draws it as a card (desktop) or opens it as a page of its own (phones, tablets).
 */
export function SharedLinksSection({ titled = true }: { readonly titled?: boolean }) {
  const { state } = useAccountScope();
  const clear = useClearProgress();
  if (state.status !== 'signed_in')
    return <StateBlock title="Sign in to see your links" body="Links you share are tied to your account." />;
  return <SharedLinksPanel scope={state.scope} titled={titled} clear={clear.progress} onLoadFailed={clear.check} />;
}
