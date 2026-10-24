import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Text } from '@knowscroll/ui';

type Step = 'menu' | 'leave' | 'block';

/**
 * C02's overflow sheet: mute, leave and block, in that order of weight. Leaving and blocking ask
 * once, in words that say what happens to each person; blocking never tells the other person.
 */
export function ConversationMenu({
  visible,
  name,
  muted,
  ended,
  canBlock,
  onClose,
  onMute,
  onLeave,
  onBlock,
  onReport,
}: {
  readonly visible: boolean;
  readonly name: string;
  readonly muted: boolean;
  readonly ended: boolean;
  /** False when the other person's account is deleted: there is no one to block. */
  readonly canBlock: boolean;
  readonly onClose: () => void;
  readonly onMute: (muted: boolean) => void;
  readonly onLeave: () => void;
  readonly onBlock: () => void;
  /** Opens the report sheet about the other person. Offered with Block: when there is no one, neither is. */
  readonly onReport: () => void;
}) {
  const [step, setStep] = useState<Step>('menu');
  const close = () => {
    setStep('menu');
    onClose();
  };
  return (
    <BottomSheet visible={visible} title={`Conversation with ${name}`} onClose={close}>
      <View style={styles.body}>
        {step === 'menu' ? (
          <>
            <Button
              label={muted ? 'Unmute notifications' : 'Mute notifications'}
              variant="ghost"
              icon="menu"
              fullWidth
              onPress={() => {
                onMute(!muted);
                close();
              }}
            />
            <Button
              label="Leave conversation"
              variant="ghost"
              icon="arrowLeft"
              fullWidth
              onPress={() => setStep('leave')}
            />
            {canBlock ? (
              <Button
                label={`Report ${name}`}
                variant="ghost"
                icon="alert"
                fullWidth
                onPress={() => {
                  close();
                  onReport();
                }}
              />
            ) : null}
            {canBlock ? (
              <Button
                label={`Block ${name}`}
                variant="danger"
                icon="alert"
                fullWidth
                onPress={() => setStep('block')}
              />
            ) : null}
          </>
        ) : step === 'leave' ? (
          <>
            <Text variant="bodyS">
              {ended
                ? `Remove this conversation from Talk? ${name} has already left.`
                : `Leave this conversation? It leaves your Talk and ${name} can’t send anything more. They keep what they already have.`}
            </Text>
            <Button label="Leave conversation" variant="danger" fullWidth onPress={onLeave} />
            <Button label="Cancel" variant="ghost" fullWidth onPress={close} />
          </>
        ) : (
          <>
            <Text variant="bodyS">Blocking stops new messages and shared links between you. {name} isn’t told.</Text>
            <Button label={`Block ${name}`} variant="danger" fullWidth onPress={onBlock} />
            <Button label="Cancel" variant="ghost" fullWidth onPress={close} />
          </>
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({ body: { gap: spacing[3], paddingBottom: spacing[2] } });
