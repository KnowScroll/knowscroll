import { useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { Banner, Button } from '@knowscroll/ui';
import { sheetStyles } from './sheet-styles';

const noSubscription = () => () => undefined;
const noState = () => undefined;

/**
 * A What-if draft that was refused because the person's recording is paused (D-388). The pause is theirs, so it is said
 * plainly and they can undo it here: Resume sets their own recording setting (no model call), then the same words are
 * asked again. When recording is already on again (resumed elsewhere) the words can simply be asked again.
 * `onAskAgain` is absent for an offer the person never wrote: there is no ask to repeat, so the step only says what to do.
 */
export function RecordingPausedStep({
  scope,
  onAskAgain,
  onClose,
}: {
  readonly scope: AccountScope;
  readonly onAskAgain: (() => void) | undefined;
  readonly onClose: () => void;
}) {
  const policy = scope.recording;
  const state = useSyncExternalStore(policy?.subscribe ?? noSubscription, policy?.getState ?? noState);
  const [sending, setSending] = useState(false);
  const on = state?.status === 'current' && state.policy?.on === true;
  const resume = async () => {
    if (policy === undefined) return;
    setSending(true);
    const resumed = await policy.set(true);
    setSending(false);
    if (resumed) onAskAgain?.();
  };
  return (
    <View style={sheetStyles.step}>
      <Banner
        kind="info"
        lead={on ? 'Recording is on.' : 'Recording is paused.'}
        message={
          on
            ? 'Suggestions for a What if or another perspective need recording on, and it is on again. Ask again to get directions.'
            : policy === undefined
              ? 'Suggestions for a What if or another perspective need recording on. You can turn it on in Privacy.'
              : 'Suggestions for a What if or another perspective need recording on. You can resume it here; it is your own setting, and you can pause it again any time.'
        }
      />
      {on ? (
        onAskAgain === undefined ? null : (
          <Button label="Ask again" variant="primary" fullWidth onPress={onAskAgain} />
        )
      ) : policy === undefined ? null : (
        <Button
          label={onAskAgain === undefined ? 'Resume recording' : 'Resume and ask again'}
          variant="primary"
          fullWidth
          busy={sending}
          disabled={sending || state?.status === 'checking'}
          onPress={() => void resume()}
        />
      )}
      <Button label="Close" variant="ghost" fullWidth onPress={onClose} />
    </View>
  );
}
