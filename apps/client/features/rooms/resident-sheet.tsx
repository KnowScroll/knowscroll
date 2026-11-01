import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { memoryWords, rhythmLines } from '@knowscroll/client-core';
import type { RoomFeed, RoomIdentity, RoomInhabitant } from '@knowscroll/contracts';
import { ROOM_MEMORY_MAX_CHARS } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';
import { FormField } from './form-field';
import { ResidentMark } from './identity/room-emblem';

type Ready = Extract<RoomFeed, { status: 'ready' }>;

/**
 * A resident's profile (T3 "Nova's profile"): who it is, what the residents remember about this room, and the rhythm they
 * post by, all from the server's own numbers. The memory is shared by the room's residents, so every profile shows the same words,
 * and it says so. A moderator may replace it with their own words or clear it so it is written again from what members said;
 * either is audited and neither calls a model. A resident never has an interest, a vote, a message to send or a place to be
 * messaged: it is a labelled AI that posts finds and answers when asked, and what a person can do about it is the room's AI level.
 */
export function ResidentSheet({
  resident,
  feed,
  identity,
  working,
  refused,
  visible,
  onClose,
  onReplace,
}: {
  readonly resident: RoomInhabitant | undefined;
  readonly feed: Ready;
  readonly identity: RoomIdentity | undefined;
  readonly working: boolean;
  readonly refused: boolean;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onReplace: (text: string | null) => Promise<boolean>;
}) {
  const remembered = memoryWords(feed.memory);
  const rhythm = rhythmLines(feed.limits);
  return (
    <BottomSheet
      visible={visible && resident !== undefined}
      title={resident?.name ?? 'Resident'}
      onClose={onClose}
      testID="resident-sheet"
    >
      {resident === undefined ? null : (
        <View style={styles.body}>
          <View style={styles.who}>
            {identity === undefined ? null : (
              <ResidentMark kit={identity.kit} resident={resident.inhabitant} size={40} />
            )}
            <View style={styles.whoText}>
              <AiLabel label={resident.label} />
              <Text variant="metaS" color={content.ink2}>
                {resident.blurb}
              </Text>
            </View>
          </View>
          <View style={styles.section} testID="resident-memory">
            <Text variant="monoXs" color={content.ink2}>
              WHAT THE RESIDENTS REMEMBER ABOUT THIS ROOM
            </Text>
            <Text variant="bodyS" testID="resident-memory-text">
              {remembered ??
                'Nothing yet. Residents write this from what members talk about, once there is enough to remember.'}
            </Text>
            <Text variant="metaS" color={content.ink2}>
              {feed.memory.state === 'ready' && feed.memory.by === 'moderator'
                ? 'A moderator wrote this.'
                : 'Written from what members said. It never has a name, and it leaves out anyone who keeps their messages out of what AI reads.'}
            </Text>
          </View>
          {feed.canEditMemory ? (
            <MemoryEditor feed={feed} working={working} refused={refused} onReplace={onReplace} />
          ) : null}
          <View style={styles.section} testID="resident-rhythm">
            <Text variant="monoXs" color={content.ink2}>
              RHYTHM
            </Text>
            <Text variant="bodyS">{rhythm.checksIn}</Text>
            <Text variant="bodyS">{rhythm.posts}</Text>
            <Text variant="metaS" color={content.ink2}>
              Each find is a real Reel or Scroll from the library that this room has not seen. If there is nothing new,
              nothing is posted. Residents cannot vote, message you or be counted among the people here.
            </Text>
          </View>
        </View>
      )}
    </BottomSheet>
  );
}

/** A moderator's own words for what the residents remember, or a clear: the room's rule, not a person's. */
function MemoryEditor({
  feed,
  working,
  refused,
  onReplace,
}: {
  readonly feed: Ready;
  readonly working: boolean;
  readonly refused: boolean;
  readonly onReplace: (text: string | null) => Promise<boolean>;
}) {
  const [text, setText] = useState(feed.memory.state === 'ready' ? feed.memory.text : '');
  const trimmed = text.trim();
  return (
    <View style={styles.editor} testID="memory-editor">
      <Text variant="monoXs" color={content.ink2}>
        FOR MODERATORS
      </Text>
      <FormField
        label="What the residents remember"
        value={text}
        onChange={setText}
        maxLength={ROOM_MEMORY_MAX_CHARS}
        multiline
        hint="Your words replace what the residents wrote, and stay until you clear them. Changing them is recorded."
        testID="memory-input"
      />
      <View style={styles.actions}>
        <Button
          label="Save"
          variant="primary"
          size="sm"
          disabled={trimmed === '' || working}
          busy={working}
          busyLabel="Saving"
          onPress={() => void onReplace(trimmed)}
          testID="memory-save"
        />
        <Button
          label="Clear, and let them write it again"
          variant="ghost"
          size="sm"
          disabled={working}
          onPress={() => void onReplace(null).then((done) => done && setText(''))}
          testID="memory-clear"
        />
      </View>
      {refused ? (
        <Banner kind="error" lead="Couldn’t change it." message="The room has changed. Here is how it stands now." />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[4] },
  who: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  whoText: { flex: 1, gap: spacing[1] },
  section: { gap: spacing[1] },
  editor: {
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
