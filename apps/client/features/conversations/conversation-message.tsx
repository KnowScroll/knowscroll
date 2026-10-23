import { StyleSheet, View } from 'react-native';
import type { ConversationMessage as Message } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';

type Target = { assetId: string; assetRevision: number };
/** Plain reader text only. Tombstones never reuse an earlier author's label, time or body. */
export function ConversationMessage({
  message,
  own,
  onOpen,
}: {
  readonly message: Message;
  readonly own: boolean;
  readonly onOpen: (target: Target) => void;
}) {
  if (message.status === 'unavailable')
    return (
      <View style={styles.unavailable}>
        <Text variant="bodyS" color={content.ink2}>
          Message unavailable
        </Text>
      </View>
    );
  const body = message.body;
  return (
    <View style={[styles.row, own ? styles.mine : styles.theirs]}>
      <Text variant="meta">{own ? 'You' : message.author.displayName}</Text>
      <View style={[styles.bubble, own && styles.ownBubble]}>
        {body.kind === 'text' ? (
          <Text variant="body" selectable>
            {body.text}
          </Text>
        ) : (
          <>
            {body.content.status === 'unavailable' ? (
              <Text variant="bodyS">This shared content is unavailable.</Text>
            ) : body.content.status === 'corrected' ? (
              <>
                <Text variant="ui">
                  This {body.content.current.metadata.kind === 'reel' ? 'Reel' : 'Scroll'} was updated
                </Text>
                <Text variant="bodyS">Choose which version to open.</Text>
                <Text variant="body" selectable>
                  {body.content.current.metadata.title}
                </Text>
                <Button label="Open original version" variant="ghost" onPress={() => onOpen(body.content.target)} />
                <Button label="Open updated version" onPress={onOpen.bind(undefined, body.content.current)} />
              </>
            ) : (
              <>
                <Text variant="meta">{body.content.metadata.kind === 'reel' ? 'Reel' : 'Scroll'}</Text>
                <Text variant="ui" selectable>
                  {body.content.metadata.title}
                </Text>
                <Button
                  label={body.content.metadata.kind === 'reel' ? 'Open Reel' : 'Open Scroll'}
                  onPress={() => onOpen(body.content.target)}
                />
              </>
            )}
            {body.note ? (
              <Text variant="body" selectable>
                {body.note}
              </Text>
            ) : null}
          </>
        )}
      </View>
      {own ? <Text variant="meta">Sent</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  row: { gap: spacing[1], maxWidth: '94%', marginVertical: spacing[2] },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  theirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  bubble: {
    borderWidth: 2,
    borderColor: content.ink,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    padding: spacing[3],
    gap: spacing[2],
    backgroundColor: content.paper,
  },
  ownBubble: { backgroundColor: content.paper2, borderBottomLeftRadius: 18, borderBottomRightRadius: 4 },
  unavailable: {
    marginVertical: spacing[2],
    padding: spacing[3],
    borderWidth: 1,
    borderColor: content.rule,
    borderStyle: 'dashed',
    borderRadius: 14,
  },
});
