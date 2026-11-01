import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  scoutCadenceWords,
  scoutDraftOf,
  scoutStatusWords,
  toggleInterest,
  type ScoutDraft,
} from '@knowscroll/client-core';
import { ROOM_SCOUT_INTERESTS_MAX, type RoomScout, type RoomScoutCadence } from '@knowscroll/contracts';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Button, Icon, SwitchRow, Text } from '@knowscroll/ui';

const CADENCES: readonly RoomScoutCadence[] = ['weekly', 'daily'];

/** One of the room's topics, as a box the member ticks: the tick is a mark and a heavier border, never colour alone. */
function TopicChoice({
  label,
  checked,
  disabled,
  onChoose,
  testID,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChoose: () => void;
  readonly testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      role="checkbox"
      aria-checked={checked}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onChoose}
      style={[styles.topic, checked ? styles.topicOn : null, disabled ? styles.disabled : null]}
    >
      <View style={[styles.box, checked ? styles.boxOn : null]} aria-hidden>
        {checked ? <Icon name="check" size={14} color={content.paper} /> : null}
      </View>
      <Text variant="ui">{label}</Text>
    </Pressable>
  );
}

/**
 * Send your scout (T3 "Send your scout"): the member's own agent looks in the library for something that fits the topics they
 * choose, and posts at most one find a day in this room, signed with their name. The topics are the room's own, picked here and
 * nowhere else: nothing they watched or read fills them in, and the sheet says so. Nothing is sent until they press Send; they can
 * pause it, change its topics or take it back at any time, and a moderator may stop it. The design's "Off" is taking it back, and
 * its list of rooms is this room: a scout is sent into one room at a time.
 */
export function ScoutSheet({
  scout,
  working,
  refused,
  visible,
  now,
  onSave,
  onClose,
}: {
  readonly scout: RoomScout;
  readonly working: boolean;
  readonly refused: boolean;
  readonly visible: boolean;
  readonly now: Date;
  readonly onSave: (draft: ScoutDraft | null) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<ScoutDraft>(() => scoutDraftOf(scout));
  const sent = scout.state === 'on';
  const full = draft.interests.length >= ROOM_SCOUT_INTERESTS_MAX;
  const save = (next: ScoutDraft | null) => void onSave(next).then((done) => done && next === null && onClose());
  return (
    <BottomSheet visible={visible} title="Send your scout" onClose={onClose} testID="scout-sheet">
      <View style={styles.body}>
        <Text variant="bodyS">
          Your own agent looks in the library for something that fits what you ask for, and posts a find in this room.
          It always signs with your name.
        </Text>
        <View style={styles.section} role="group" accessibilityLabel="Topics it looks in">
          <Text variant="monoXs" color={content.ink2}>
            TOPICS IT LOOKS IN · UP TO {String(ROOM_SCOUT_INTERESTS_MAX)}
          </Text>
          {scout.choices.map((choice) => {
            const checked = draft.interests.includes(choice.id);
            return (
              <TopicChoice
                key={choice.id}
                label={choice.label}
                checked={checked}
                disabled={working || (full && !checked)}
                onChoose={() => setDraft(toggleInterest(draft, choice.id, ROOM_SCOUT_INTERESTS_MAX))}
                testID={`scout-topic-${choice.id}`}
              />
            );
          })}
        </View>
        <View style={styles.section} role="radiogroup" accessibilityLabel="How often">
          <Text variant="monoXs" color={content.ink2}>
            HOW OFTEN
          </Text>
          <View style={styles.cadence}>
            {CADENCES.map((cadence) => (
              <Pressable
                key={cadence}
                role="radio"
                aria-checked={draft.cadence === cadence}
                accessibilityRole="radio"
                accessibilityState={{ checked: draft.cadence === cadence, disabled: working }}
                accessibilityLabel={scoutCadenceWords[cadence]}
                disabled={working}
                onPress={() => setDraft({ ...draft, cadence })}
                style={[styles.segment, draft.cadence === cadence ? styles.segmentOn : null]}
                testID={`scout-cadence-${cadence}`}
              >
                <Text variant="ui" color={draft.cadence === cadence ? content.paper : content.ink}>
                  {scoutCadenceWords[cadence]}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text variant="metaS" color={content.ink2}>
            Once a day per room is the most a scout can post. If the library has nothing new in your topics, it posts
            nothing.
          </Text>
        </View>
        <View style={styles.section}>
          <Text variant="monoXs" color={content.ink2}>
            WHAT IT CAN READ
          </Text>
          <Text variant="bodyS">
            Only the library’s public Reels and Scrolls. Never your messages, your threads, your private rooms, or
            anything you watched or read. Every find links a real Reel or Scroll.
          </Text>
        </View>
        {sent ? (
          <SwitchRow
            label="Pause my scout"
            description="It posts nothing while it is paused."
            on={draft.paused}
            onChange={(paused) => setDraft({ ...draft, paused })}
            disabled={working}
          />
        ) : null}
        {sent ? (
          <Text variant="metaS" color={content.ink2} testID="scout-status">
            {scoutStatusWords(scout, now)}
          </Text>
        ) : null}
        {refused ? (
          <Banner kind="error" lead="Couldn’t change it." message="Something changed. Here is how it stands now." />
        ) : null}
        <View style={styles.actions}>
          <Button
            label={sent ? 'Save changes' : 'Send scout'}
            variant="primary"
            disabled={draft.interests.length === 0 || working}
            busy={working}
            busyLabel="Saving"
            onPress={() => save(draft)}
            testID="scout-save"
          />
          <Button label="Not now" variant="ghost" onPress={onClose} testID="scout-close" />
          {sent ? (
            <Button
              label="Take my scout back"
              variant="ghost"
              disabled={working}
              onPress={() => save(null)}
              testID="scout-remove"
            />
          ) : null}
        </View>
        <Text variant="metaS" color={content.ink2}>
          You’re responsible for what it posts. Anyone can turn AI down in this room, and moderators can stop a scout.
        </Text>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[4] },
  section: { gap: spacing[2] },
  topic: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
    cursor: 'pointer' as const,
  },
  topicOn: { backgroundColor: content.paper2, boxShadow: elevation.press },
  disabled: { opacity: 0.5 },
  box: {
    width: 22,
    height: 22,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: content.ink },
  cadence: { flexDirection: 'row', gap: spacing[2] },
  segment: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    backgroundColor: content.paper,
  },
  segmentOn: { backgroundColor: content.ink },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
