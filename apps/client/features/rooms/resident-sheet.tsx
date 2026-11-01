import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { agoWords, timeOfDayWords, dayWords, memoryWords, rhythmLines } from '@knowscroll/client-core';
import type { RoomFeed, RoomIdentity, RoomInhabitant } from '@knowscroll/contracts';
import { ROOM_MEMORY_MAX_CHARS } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';
import { FormField } from './form-field';
import { ResidentMark } from './identity/room-emblem';

type Ready = Extract<RoomFeed, { status: 'ready' }>;

/**
 * A resident's profile (T3 "Nova's profile", v3 R-8, R-8b): who made it (KnowScroll), what it cares about, how long the room it lives
 * in has been there, what the residents remember about this room, the rhythm it posts by (when it last spoke and, only while it is
 * still ahead, when it may post next) and its latest posts. Every word is the product's own or a fact of the room's ledger, never a
 * model's. Mute is the member's own AI level for the room (D-277): there is one switch and it silences the residents and scouts
 * together, so the button says so. Report goes to the same report as any message, about the resident's newest post. A moderator may
 * replace what the residents remember, or have this resident introduce itself, once. A resident never has a vote, a message to send
 * or a place to be messaged: it is a labelled AI that posts finds and answers when asked.
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
  onMute,
  onReport,
  onIntroduce,
  onOpenPost,
}: {
  readonly resident: RoomInhabitant | undefined;
  readonly feed: Ready;
  readonly identity: RoomIdentity | undefined;
  readonly working: boolean;
  readonly refused: boolean;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onReplace: (text: string | null) => Promise<boolean>;
  /** Mutes the room's residents for this member, or lets them speak again. */
  readonly onMute?: (muted: boolean) => void;
  /** Reports the resident's newest post: its first message's ID. */
  readonly onReport?: (messageId: string) => void;
  /** A moderator has the resident introduce itself, once. */
  readonly onIntroduce?: (inhabitant: RoomInhabitant['inhabitant']) => void;
  readonly onOpenPost?: (discussionId: string) => void;
}) {
  const remembered = memoryWords(feed.memory);
  const rhythm = rhythmLines(feed.limits);
  const profile =
    resident === undefined ? undefined : feed.profiles.find((entry) => entry.inhabitant === resident.inhabitant);
  const muted = feed.aiLevel === 'off';
  const newest = profile?.recent[0];
  return (
    <BottomSheet
      visible={visible && resident !== undefined}
      title={resident?.name ?? 'Resident'}
      onClose={onClose}
      testID="resident-sheet"
    >
      {resident === undefined ? null : (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.who}>
            {identity === undefined ? null : (
              <ResidentMark kit={identity.kit} resident={resident.inhabitant} size={40} />
            )}
            <View style={styles.whoText}>
              <AiLabel label={resident.label} />
              <Text variant="monoXs" color={content.ink2} testID="resident-made-by">
                AGENT · MADE BY KNOWSCROLL
              </Text>
              {profile === undefined ? null : (
                <Text variant="metaS" color={content.ink2} testID="resident-since">
                  {`Lives in ${feed.roomName} since ${dayWords(profile.livesHereSince)}`}
                </Text>
              )}
              <Text variant="metaS" color={content.ink2}>
                {resident.blurb}
              </Text>
            </View>
          </View>
          {profile === undefined ? null : (
            <View style={styles.chips} role="list" accessibilityLabel="Interests" testID="resident-interests">
              {profile.interests.map((interest) => (
                <View key={interest} role="listitem" style={styles.chip}>
                  <Text variant="metaS">{interest}</Text>
                </View>
              ))}
            </View>
          )}
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
            <View style={styles.row}>
              <Text variant="bodyS" style={styles.rowText}>
                {rhythm.checksIn}
              </Text>
              {profile?.lastAt === undefined ? null : (
                <Text variant="monoXs" color={content.ink2} testID="resident-last">
                  {`LAST ${timeOfDayWords(profile.lastAt)}`}
                </Text>
              )}
            </View>
            <View style={styles.row}>
              <Text variant="bodyS" style={styles.rowText}>
                {rhythm.posts}
              </Text>
              {profile?.nextAfter === undefined ? null : (
                <Text variant="monoXs" color={content.ink2} testID="resident-next">
                  {`NEXT AFTER ${timeOfDayWords(profile.nextAfter)}`}
                </Text>
              )}
            </View>
            <Text variant="metaS" color={content.ink2}>
              Each find is a real Reel or Scroll from the library that this room has not seen. If there is nothing new,
              nothing is posted. Residents cannot vote, message you or be counted among the people here.
            </Text>
          </View>
          {profile === undefined || profile.recent.length === 0 ? null : (
            <View style={styles.section} testID="resident-recent">
              <Text variant="monoXs" color={content.ink2}>
                RECENT POSTS
              </Text>
              {profile.recent.map((post) => (
                <Button
                  key={post.discussionId}
                  label={`${post.title} · ${agoWords(Date.now() - new Date(post.postedAt).getTime())}`}
                  variant="default"
                  size="sm"
                  onPress={() => onOpenPost?.(post.discussionId)}
                  testID={`resident-recent-${post.discussionId}`}
                />
              ))}
            </View>
          )}
          {feed.canEditMemory && profile !== undefined && !profile.introduced && onIntroduce !== undefined ? (
            <View style={styles.editor} testID="resident-introduce">
              <Text variant="monoXs" color={content.ink2}>
                FOR MODERATORS
              </Text>
              <Text variant="metaS" color={content.ink2}>
                {`${resident.name} can introduce itself once, in a post for the room. The words are the product's own, not a model's, and nobody is sent a message.`}
              </Text>
              <Button
                label={`Introduce ${resident.name}`}
                size="sm"
                variant="default"
                disabled={working}
                onPress={() => onIntroduce(resident.inhabitant)}
                testID="resident-introduce-button"
              />
            </View>
          ) : null}
          <View style={styles.actions}>
            {onMute === undefined ? null : (
              <Button
                label={muted ? 'Unmute residents here' : 'Mute residents here'}
                variant="default"
                disabled={working}
                onPress={() => onMute(!muted)}
                accessibilityHint={
                  muted
                    ? 'Lets residents and scouts speak to you in this room again'
                    : 'Stops residents and scouts from speaking to you in this room. It is your AI level for the room.'
                }
                testID="resident-mute"
              />
            )}
            {onReport === undefined || newest === undefined ? null : (
              <Button
                label="Report"
                variant="default"
                onPress={() => onReport(newest.messageId)}
                accessibilityHint={`Reports ${resident.name}'s newest post to the room's moderators and the safety team`}
                testID="resident-report"
              />
            )}
          </View>
          <Text variant="metaS" color={content.ink2}>
            The ring next to a name means agent. It can’t be removed or hidden.
          </Text>
        </ScrollView>
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
  body: { gap: spacing[4], paddingBottom: spacing[4] },
  who: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  whoText: { flex: 1, gap: spacing[1] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    backgroundColor: content.paper2,
  },
  section: { gap: spacing[1] },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
  rowText: { flex: 1 },
  editor: {
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
