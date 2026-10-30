import { StyleSheet, View } from 'react-native';
import type { InhabitantStatus, PointedAsk } from '@knowscroll/client-core';
import type { InhabitantId, RoomMessage } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Text } from '@knowscroll/ui';
import { actionsFor, cardWords } from './room-messages';

const REASONS = {
  available: undefined,
  preparing: 'is preparing a reply',
  resting: 'is resting for now',
  paused: 'is quiet while the room is paused',
} as const;

/** The three ways to point a resident at a message, as the menu words them (R3 B1, C2, C3). */
const ASKS: readonly {
  readonly kind: PointedAsk;
  readonly inhabitant: InhabitantId;
  readonly label: (name: string) => string;
  readonly hint: (name: string) => string;
}[] = [
  {
    kind: 'about',
    inhabitant: 'explainer',
    label: (name) => `Ask ${name} about this`,
    hint: (name) => `${name} explains it.`,
  },
  {
    kind: 'other_side',
    inhabitant: 'skeptic',
    label: () => 'Other side',
    hint: (name) => `${name} argues the opposite.`,
  },
  {
    kind: 'challenge',
    inhabitant: 'skeptic',
    label: () => 'Challenge',
    hint: (name) => `${name} checks it.`,
  },
];

/**
 * What a person can do with one message: start a topic from it, ask a resident about it, challenge it or hear the other
 * side, mark it Useful (never their own), report it; a moderator can also hide or restore it and remove its author from
 * the room. A resident that is busy or resting is named with the reason and its button is off. Nothing here is visible to
 * the author, changes anyone's universe, or counts as evidence.
 */
export function MessageOptionsSheet({
  message,
  role,
  ownPersonId,
  inhabitants,
  canPost,
  onClose,
  onStartThread,
  onStartTopic,
  onAsk,
  onUseful,
  onHide,
  onRemoveAuthor,
  onReport,
}: {
  readonly message: RoomMessage | undefined;
  readonly role: 'member' | 'moderator';
  readonly ownPersonId: string | undefined;
  readonly inhabitants: readonly InhabitantStatus[];
  readonly canPost: boolean;
  readonly onClose: () => void;
  readonly onStartThread: (messageId: string) => void;
  readonly onStartTopic: (message: RoomMessage) => void;
  readonly onAsk: (kind: PointedAsk, messageId: string) => void;
  readonly onUseful: (messageId: string, useful: boolean) => void;
  readonly onHide: (messageId: string, hidden: boolean) => void;
  readonly onRemoveAuthor: (personId: string) => void;
  /** Opens the report sheet for this message. */
  readonly onReport: (message: RoomMessage) => void;
}) {
  const actions = message === undefined ? undefined : actionsFor(message, role, ownPersonId);
  const author = message?.status === 'available' && message.author.kind === 'person' ? message.author : undefined;
  const words = message === undefined ? undefined : cardWords(message);
  const marked = message?.status === 'available' && message.usefulByYou === true;
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
          {actions.canStartTopic && canPost ? (
            <Button
              label="Start a topic from this message"
              variant="primary"
              onPress={() => {
                onClose();
                onStartTopic(message);
              }}
              testID="option-start-topic"
            />
          ) : null}
          {actions.canAsk && canPost
            ? ASKS.map((entry) => {
                const resident = inhabitants.find((candidate) => candidate.inhabitant === entry.inhabitant);
                if (resident === undefined) return null;
                const reason = REASONS[resident.ask];
                return (
                  <View key={entry.kind} style={styles.ask}>
                    <Button
                      label={entry.label(resident.name)}
                      disabled={resident.ask !== 'available'}
                      onPress={() => {
                        onClose();
                        onAsk(entry.kind, message.messageId);
                      }}
                      testID={`option-ask-${entry.kind}`}
                    />
                    <Text variant="metaS" color={content.ink2}>
                      {reason === undefined ? entry.hint(resident.name) : `${resident.name} ${reason}.`}
                    </Text>
                  </View>
                );
              })
            : null}
          {actions.canUseful && canPost ? (
            <Button
              label={marked ? 'Marked useful · take it back' : 'Useful'}
              variant={marked ? 'default' : 'ghost'}
              onPress={() => {
                onClose();
                onUseful(message.messageId, !marked);
              }}
              testID="option-useful"
            />
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

const styles = StyleSheet.create({ body: { gap: spacing[3] }, ask: { gap: spacing['0.5'] } });
