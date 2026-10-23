import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { useRouter } from 'expo-router';
import { TextInput, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { Button, Text } from '@knowscroll/ui';
import { ContentShareTokenSchema } from '@knowscroll/contracts';
import { encounterSessionFor } from '../encounter/use-encounter-session';
import { talkStyles } from '../conversations/conversations-screen';
import { useShareSession } from './use-share-session';
import { conversationsFor } from '../conversations/use-conversations-session';

/** Deliberate sensitive JSON check. This component never claims the API-owned /s route. */
export function PrivateShareScreen({ scope, onClose }: { readonly scope: AccountScope; readonly onClose: () => void }) {
  const { session, state } = useShareSession(scope);
  const [token, setToken] = useState('');
  const [checked, setChecked] = useState(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const live = useRef(true);
  const serial = useRef(0);
  const router = useRouter();
  useEffect(() => {
    live.current = true;
    const stop = () => {
      live.current = false;
      serial.current++;
    };
    const off = scope.onEnd?.(() => {
      stop();
      input.current?.clear();
      input.current = null;
      setToken('');
      setChecked(false);
    });
    return () => {
      stop();
      input.current?.clear();
      off?.();
    };
  }, [scope]);
  const check = async () => {
    if (!live.current || !scope.active || !ContentShareTokenSchema.safeParse(token).success) return;
    const mine = ++serial.current;
    setChecked(false);
    await session.resolve(token);
    if (mine !== serial.current || !live.current || !scope.active) return;
    input.current?.clear();
    setToken('');
    setChecked(true);
  };
  const resolved = checked && state.resolved.status === 'ready' ? state.resolved.data : undefined;
  const projection = resolved && resolved.status !== 'unavailable' ? resolved.content : undefined;
  const open = (target: { assetId: string; assetRevision: number }) => {
    if (!scope.active || !live.current || !checked || !projection) return;
    const destination =
      resolved?.status === 'conversation' ? `/conversations/${resolved.conversation.conversationId}` : '/conversations';
    if (
      encounterSessionFor(scope).openConversationContent(target, () => {
        if (scope.active) router.replace(destination);
      })
    ) {
      if (!scope.active || !live.current) return;
      onClose();
      if (!scope.active) return;
      router.push('/explore');
    }
  };
  if (!scope.active || state.status !== 'active')
    return (
      <View style={talkStyles.card}>
        <Text variant="body">This signed-in session ended.</Text>
      </View>
    );
  return (
    <View style={talkStyles.card}>
      <Text variant="title" heading={2}>
        Check a private share
      </Text>
      <Text variant="bodyS">
        Paste the share code from the link after /s/. Checking does not send a message or open content.
      </Text>
      <TextInput
        ref={input}
        style={talkStyles.input}
        accessibilityLabel="Private share code"
        value={token}
        maxLength={48}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        onChangeText={(value) => {
          if (!scope.active || !live.current) return;
          serial.current++;
          setChecked(false);
          setToken(value);
        }}
      />
      <Button
        label="Check share"
        disabled={!ContentShareTokenSchema.safeParse(token).success || state.resolved.status === 'loading'}
        onPress={() => {
          void check();
        }}
      />
      {state.resolved.status === 'loading' ? <Text variant="bodyS">Checking current access…</Text> : null}
      {checked && resolved?.status === 'unavailable' ? (
        <Text variant="body">This link is no longer available.</Text>
      ) : null}
      {state.resolved.status === 'unavailable' ? (
        <Text variant="bodyS">This share couldn’t be checked. Try again when connected.</Text>
      ) : null}
      {projection?.status === 'available' ? (
        <>
          <Text variant="ui">{projection.metadata.title}</Text>
          <Button
            label={projection.metadata.kind === 'reel' ? 'Open Reel' : 'Open Scroll'}
            onPress={() => open(projection.target)}
          />
        </>
      ) : null}
      {projection?.status === 'corrected' ? (
        <>
          <Text variant="ui">This content was updated</Text>
          <Text variant="body">{projection.current.metadata.title}</Text>
          <Button label="Open original version" variant="ghost" onPress={() => open(projection.target)} />
          <Button label="Open updated version" onPress={() => open(projection.current)} />
        </>
      ) : null}
      {resolved?.status === 'conversation' ? (
        <Button
          label="Reply in Talk"
          variant="ghost"
          onPress={() => {
            if (!scope.active || !live.current) return;
            const mine = serial.current;
            void conversationsFor(scope)
              .open(resolved.conversation)
              .then(() => {
                if (!scope.active || !live.current || mine !== serial.current) return;
                onClose();
                if (!scope.active) return;
                router.push(`/conversations/${resolved.conversation.conversationId}`);
              });
          }}
        />
      ) : null}
      <Button label="Close private share check" variant="ghost" onPress={onClose} />
    </View>
  );
}
