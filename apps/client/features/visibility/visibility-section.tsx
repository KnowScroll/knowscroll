import { StateBlock } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { useClearProgress } from '../privacy/clear-progress';
import { VisibilityPanel } from './visibility-panel';

/**
 * The privacy panel of what friends may see (P02 "Sharing & visibility"). The Privacy hub draws it as a
 * card (desktop) or opens it as a page of its own (phones, tablets).
 */
export function VisibilitySection({ titled = true }: { readonly titled?: boolean }) {
  const { state } = useAccountScope();
  const clear = useClearProgress();
  if (state.status !== 'signed_in')
    return <StateBlock title="Sign in to choose what friends see" body="Sharing settings belong to your account." />;
  return <VisibilityPanel scope={state.scope} titled={titled} clear={clear.progress} onLoadFailed={clear.check} />;
}
