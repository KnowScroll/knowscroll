import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { formatRange, talkFailure, type AccountScope } from '@knowscroll/client-core';
import type { RoomSnippetOpening } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Skeleton, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { writeResume } from '../encounter/encounter-history';

type Opening = RoomSnippetOpening | { readonly status: 'failed' };

/**
 * What a snippet of a room discussion leads to now, asked when the person taps it. The sheet only
 * says where it points; watching or reading starts an ordinary encounter of the original content
 * when the person chooses to (opening a card is not an encounter). A corrected Reel is never played
 * at the old moment: the sheet offers the current Reel instead.
 */
export function RoomSnippetSheet({
  scope,
  roomId,
  discussionId,
  messageId,
  onClose,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly discussionId: string;
  readonly messageId: string | undefined;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const [opening, setOpening] = useState<Opening>();
  useEffect(() => {
    setOpening(undefined);
    if (messageId === undefined) return;
    let current = true;
    scope.api.rooms
      .openSnippet({ version: 'rooms.v1', readId: newCommandId(), roomId, discussionId, messageId })
      .then((answer) => current && setOpening(answer))
      .catch((error: unknown) => {
        if (current && talkFailure(error) !== 'ended') setOpening({ status: 'failed' });
      });
    return () => {
      current = false;
    };
  }, [scope, roomId, discussionId, messageId]);

  const go = (kind: 'reel' | 'scroll', assetId: string) => {
    onClose();
    router.push(`/${kind}/${assetId}`);
  };
  return (
    <BottomSheet visible={messageId !== undefined} title="Shared moment" onClose={onClose}>
      {opening === undefined ? <Skeleton rows={2} label="Opening" /> : null}
      {opening?.status === 'unavailable' || opening?.status === 'failed' ? (
        <View style={styles.body}>
          <Text variant="bodyS">
            {opening.status === 'failed'
              ? 'Can’t open this right now. Try again in a moment.'
              : 'This isn’t available any more.'}
          </Text>
          <Button label="Close" variant="ghost" onPress={onClose} />
        </View>
      ) : null}
      {opening?.status === 'changed' ? (
        <View style={styles.body}>
          <Text variant="ui">
            This {opening.current.kind === 'reel' ? 'Reel' : 'Scroll'} was corrected and this moment changed
          </Text>
          <Text variant="bodyS" color={content.ink2}>
            The moment that was shared is no longer there as it was. The current version, “{opening.current.title}”, is
            open to you.
          </Text>
          <Button
            label={`${opening.current.kind === 'reel' ? 'Watch' : 'Open'} the current version`}
            variant="primary"
            onPress={() => go(opening.current.kind, opening.current.assetId)}
          />
        </View>
      ) : null}
      {opening?.status === 'ready' ? (
        <View style={styles.body}>
          <Text variant="ui">{opening.content.title}</Text>
          <Text variant="bodyS" color={content.ink2}>
            {opening.anchor.kind === 'reel_range'
              ? `A moment, ${formatRange(opening.anchor.startMs, opening.anchor.endMs)}. Watching starts from there.`
              : opening.anchor.kind === 'scroll_passage'
                ? `A passage: “${opening.anchor.quote}”`
                : 'A part of the Scroll.'}
          </Text>
          <Button
            label={opening.content.kind === 'reel' ? 'Watch from here' : 'Read the Scroll'}
            variant="primary"
            onPress={() => {
              if (opening.anchor.kind === 'reel_range')
                writeResume(scope, opening.content.assetId, opening.content.assetRevision, {
                  kind: 'reel',
                  positionMs: opening.anchor.startMs,
                  playing: false,
                  muted: false,
                });
              go(opening.content.kind, opening.content.assetId);
            }}
          />
          <Button label="Not now" variant="ghost" onPress={onClose} />
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({ body: { gap: spacing[3] } });
