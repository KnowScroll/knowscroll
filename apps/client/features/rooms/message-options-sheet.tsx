import { StyleSheet, View } from 'react-native';
import type { RoomMessage } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Text } from '@knowscroll/ui';
import { actionsFor, cardWords } from './room-messages';

/**
 * What a person can do with one message. Anyone can start a thread from a card; a moderator can also
 * hide or restore a message and remove its author from the room. Nothing here is visible to the
 * author, changes anyone's universe, or counts as evidence.
 */
export function MessageOptionsSheet({
  message,
  role,
  ownPersonId,
  onClose,
  onStartThread,
  onHide,
  onRemoveAuthor,
  onReport,
}: {
  readonly message: RoomMessage | undefined;
  readonly role: 'member' | 'moderator';
  readonly ownPersonId: string | undefined;
  readonly onClose: () => void;
  readonly onStartThread: (messageId: string) => void;
  readonly onHide: (messageId: string, hidden: boolean) => void;
  readonly onRemoveAuthor: (personId: string) => void;
  /** Opens the report sheet for this message. */
  readonly onReport: (message: RoomMessage) => void;
}) {
  const actions = message === undefined ? undefined : actionsFor(message, role, ownPersonId);
  const author = message?.status === 'available' && message.author.kind === 'person' ? message.author : undefined;
  const words = message === undefined ? undefined : cardWords(message);
  return (
    <BottomSheet visible={message !== undefined} title="This message" onClose={onClose}>
      {message === undefined || actions === undefined ? null : (
        <View style={styles.body}>
          {actions.canStartThread ? (
            <>
              <Text variant="bodyS" color={content.ink2}>
                A thread is a discussion about {words === undefined ? 'this' : `“${words}”`}, in this room.
              </Text>
              <Button
                label="Start a thread from this"
                variant="primary"
                onPress={() => {
                  onClose();
                  onStartThread(message.messageId);
                }}
              />
            </>
          ) : null}
          {actions.canModerate ? (
            <>
              <Button
                label={message.status === 'removed' ? 'Restore this message' : 'Remove this message'}
                onPress={() => {
                  onClose();
                  onHide(message.messageId, message.status !== 'removed');
                }}
              />
              {author === undefined ? null : (
                <Button
                  label={`Remove ${author.displayName} from the room`}
                  variant="danger"
                  onPress={() => {
                    onClose();
                    onRemoveAuthor(author.personId);
                  }}
                />
              )}
              <Text variant="meta" color={content.ink2}>
                Removing a message keeps its place. It doesn’t change anyone’s universe or position.
              </Text>
            </>
          ) : null}
          {actions.canReport ? (
            <>
              <Button
                label="Report this message"
                variant="ghost"
                icon="alert"
                onPress={() => {
                  onClose();
                  onReport(message);
                }}
              />
              <Text variant="meta" color={content.ink2}>
                Reports go to our safety team{role === 'moderator' ? '' : ' and the room’s moderators'}. The author
                isn’t told.
              </Text>
            </>
          ) : null}
          <Button label="Cancel" variant="ghost" onPress={onClose} />
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({ body: { gap: spacing[3] } });
