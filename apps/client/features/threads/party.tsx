import { Pressable, StyleSheet, View } from 'react-native';
import {
  facesByPart,
  joinNames,
  partyLine,
  placeDay,
  placeWords,
  type ThreadPlacesState,
} from '@knowscroll/client-core';
import type { ThreadEpisode, ThreadParticipant, ThreadPlace } from '@knowscroll/contracts';
import { content, spacing, universe } from '@knowscroll/design-tokens';
import { SwitchRow, Tag, Text, useFocusRing, useTalkTheme } from '@knowscroll/ui';
import { initialOf, PersonAvatar } from '../conversations/person-avatar';

/**
 * A thread as a party (T3 "who is on which part", D-065): the series' part worlds in the header with the
 * face of each member who shares on the part they are on, one line saying where the others are, and a
 * member list with the person's own "hide where I am". A place is a part, on or finished, and a day. It is
 * drawn from what each member's own client reported, never from anything watched or read, and it never says
 * "watching".
 */

/** The three worlds' stand-in colours until the parts have art (as T-A's tiles): a part keeps its colour. */
const WORLD_COLOURS = [universe.cobalt, universe.orange, universe.fresh] as const;
const WORLD = 28;
const FACE = 16;
/** More faces than this on one part show as a count. */
const MAX_FACES = 2;
/** More parts than this show as a count, so the header never outgrows a phone. */
const MAX_WORLDS = 6;

const worldColour = (part: number): string => WORLD_COLOURS[(part - 1) % WORLD_COLOURS.length]!;

/**
 * Who is on a part and who finished it, in words for a screen reader: "Ravi is on it. Asha and Kenji finished
 * it." Nothing when nobody shows a place there. Never "watching".
 */
export function partPlacesWords(faces: readonly ThreadPlace[] | undefined): string | undefined {
  const sentence = (state: 'on' | 'finished') => {
    const names = (faces ?? [])
      .filter((face) => face.state === state)
      .map((face) => (face.you ? 'You' : face.person.displayName));
    if (names.length === 0) return undefined;
    const ownOnly = names.length === 1 && names[0] === 'You';
    const verb = names.length > 1 || ownOnly ? 'are' : 'is';
    return state === 'on' ? `${joinNames(names)} ${verb} on it.` : `${joinNames(names)} finished it.`;
  };
  const words = [sentence('on'), sentence('finished')].filter((part): part is string => part !== undefined);
  return words.length === 0 ? undefined : words.join(' ');
}

/** "Part 2. Ravi is on it.", or just "Part 3" when nobody shows a place there. */
const worldLabel = (part: number, faces: readonly ThreadPlace[] | undefined): string =>
  [`Part ${String(part)}.`, partPlacesWords(faces)].filter(Boolean).join(' ').replace(/.$/, '');

/** One member's face on a world: their initial, ringed in green once they have finished the part. */
function Face({ place }: { readonly place: ThreadPlace }) {
  return (
    <View
      aria-hidden
      style={[styles.face, place.state === 'finished' ? styles.faceFinished : null]}
      testID={`face-${place.person.personId}`}
    >
      <Text variant="monoXs" color={content.ink} style={styles.faceInitial}>
        {initialOf(place.person.displayName)}
      </Text>
    </View>
  );
}

/**
 * The faces on one part, for its row in the Series sheet and panel (T3): who is on it and who finished it,
 * in words as well as faces. Nothing when nobody shows a place there.
 */
export function PartFaces({ faces }: { readonly faces: readonly ThreadPlace[] | undefined }) {
  if (faces === undefined || faces.length === 0) return null;
  const group = (state: 'on' | 'finished') => faces.filter((face) => face.state === state);
  const label = (state: 'on' | 'finished') => {
    const names = group(state).map((face) => (face.you ? 'you' : face.person.displayName));
    return names.length === 0 ? undefined : `${joinNames(names)} ${state === 'on' ? 'on it' : 'finished'}`;
  };
  return (
    <View style={styles.partFaces} aria-hidden testID="part-faces">
      <View style={styles.partFaceRow}>
        {faces.slice(0, 4).map((place) => (
          <Face key={place.person.personId} place={place} />
        ))}
      </View>
      <Text variant="metaS" color={content.ink2} numberOfLines={2} style={styles.partFaceText}>
        {[label('on'), label('finished')].filter(Boolean).join(' · ')}
      </Text>
    </View>
  );
}

/**
 * The series' parts as small worlds for the header (T3), each with the faces of the members who share on
 * it. The selected part, which is this person's own choice on this device, wears a ring. Decorative for
 * pressing: the Series button opens the parts. Each world is named for a screen reader with who is on it.
 */
export function PartWorlds({
  episodes,
  places,
  selected,
}: {
  readonly episodes: readonly ThreadEpisode[];
  readonly places: readonly ThreadPlace[];
  /** The part this person has selected on this device. */
  readonly selected: string | undefined;
}) {
  const theme = useTalkTheme();
  const faces = facesByPart(places);
  const parts = episodes.filter((episode) => episode.part !== undefined);
  const shown = parts.slice(0, MAX_WORLDS);
  return (
    <View role="list" accessibilityLabel="Parts of this series" style={styles.worlds} testID="part-worlds">
      {shown.map((episode) => {
        const part = episode.part!;
        const here = faces.get(part);
        return (
          <View
            key={episode.assetId}
            role="listitem"
            accessibilityLabel={worldLabel(part, here)}
            style={styles.slot}
            testID={`part-world-${String(part)}`}
          >
            <View
              style={[
                styles.world,
                { backgroundColor: worldColour(part) },
                episode.assetId === selected ? { borderColor: theme.focus, borderWidth: 2 } : null,
              ]}
              aria-hidden
            >
              <Text variant="monoXs" color={universe.paper}>
                {String(part)}
              </Text>
            </View>
            {here === undefined ? null : (
              <View style={styles.faces} aria-hidden>
                {here.slice(0, MAX_FACES).map((place) => (
                  <Face key={place.person.personId} place={place} />
                ))}
                {here.length > MAX_FACES ? (
                  <View style={styles.face}>
                    <Text variant="monoXs" color={content.ink} style={styles.faceInitial}>
                      {`+${String(here.length - MAX_FACES)}`}
                    </Text>
                  </View>
                ) : null}
              </View>
            )}
          </View>
        );
      })}
      {parts.length > shown.length ? (
        <Text variant="monoXs" color={theme.textQuiet}>
          {`+${String(parts.length - shown.length)}`}
        </Text>
      ) : null}
    </View>
  );
}

/** The one line under the header: where the others are ("Ravi is on Part 2 · Asha and Kenji on Part 1"), or none. */
export function PartyLine({ places, total }: { readonly places: readonly ThreadPlace[]; readonly total: number }) {
  const theme = useTalkTheme();
  const line = partyLine(places, total);
  if (line === undefined) return null;
  return (
    <View style={styles.lineGround}>
      <View
        style={[styles.line, { backgroundColor: theme.capsule.fill, borderColor: theme.capsule.edge }]}
        accessibilityLabel={line}
        testID="party-line"
      >
        <View style={styles.lineDot} aria-hidden />
        <Text variant="metaS" color={theme.capsule.text} numberOfLines={1} style={styles.lineText}>
          {line}
        </Text>
      </View>
    </View>
  );
}

export type SeriesTab = 'parts' | 'members';

/** The Series sheet's tabs (T3 "Parts · Members"): one is selected, and the arrow keys are not needed with two. */
export function SeriesTabs({
  tab,
  onTab,
  memberCount,
}: {
  readonly tab: SeriesTab;
  readonly onTab: (tab: SeriesTab) => void;
  readonly memberCount: number;
}) {
  const tabs: readonly { readonly key: SeriesTab; readonly label: string }[] = [
    { key: 'parts', label: 'Parts' },
    { key: 'members', label: `Members ${String(memberCount)}` },
  ];
  return (
    <View role="tablist" accessibilityLabel="Series" style={styles.tabs}>
      {tabs.map((entry) => (
        <TabButton key={entry.key} label={entry.label} selected={tab === entry.key} onPress={() => onTab(entry.key)} />
      ))}
    </View>
  );
}

function TabButton({
  label,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      role="tab"
      aria-selected={selected}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.tab, selected ? styles.tabSelected : null, focus.style]}
    >
      <Text variant="uiS" color={content.ink}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Who is in the thread and where each member says they are: their face, name, and "On Part 2" or "Finished
 * Part 1" with the day, from what they told this thread. A member who has not set a place, or hides it,
 * shows no place and nothing says which. Below, this person's own "Hide where I am". Nothing here is a time,
 * a playhead or a word like "watching".
 */
export function MembersSection({
  participants,
  places,
  total,
  now,
  state,
  onHide,
}: {
  readonly participants: readonly ThreadParticipant[];
  readonly places: readonly ThreadPlace[];
  readonly total: number;
  readonly now: Date;
  /** This person's own switch, and whether a change is on its way. */
  readonly state: Pick<ThreadPlacesState, 'hidden' | 'saving' | 'phase'>;
  readonly onHide: (hidden: boolean) => void;
}) {
  const byPerson = new Map(places.map((place) => [place.person.personId, place]));
  return (
    <View style={styles.members} testID="thread-members">
      <View role="list" accessibilityLabel="People in this thread" style={styles.memberList}>
        {participants.map((participant) => {
          const place = byPerson.get(participant.person.personId);
          return (
            <View key={participant.person.personId} role="listitem" style={styles.member}>
              <PersonAvatar person={participant.person} size={32} />
              <View style={styles.memberText}>
                <Text variant="uiS" numberOfLines={1}>
                  {participant.person.displayName}
                  {participant.you ? ' (you)' : ''}
                </Text>
                <Text variant="metaS" color={content.ink2} numberOfLines={1} testID="member-place">
                  {place === undefined
                    ? `@${participant.person.handle}`
                    : `${placeWords(place, total)} · ${placeDay(place.day, now)}`}
                </Text>
              </View>
              {participant.role === 'starter' ? <Tag label="Started it" /> : null}
              {participant.joined ? null : <Tag label="Invited" />}
            </View>
          );
        })}
      </View>
      <SwitchRow
        label="Hide where I am"
        description={
          state.hidden
            ? 'Hidden. Nobody in this thread sees which part you are on.'
            : 'People in this thread see which part you are on, and the day. Never what you watch or read.'
        }
        on={state.hidden}
        disabled={state.saving || state.phase !== 'ready'}
        onChange={onHide}
      />
      <Text variant="meta" color={content.ink2}>
        Where someone is shows only to people in this thread, only if they share it, and only as a part and a day.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  worlds: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], minHeight: WORLD + 2 },
  slot: { width: WORLD + FACE / 2, height: WORLD + FACE / 2, justifyContent: 'flex-start' },
  world: {
    width: WORLD,
    height: WORLD,
    borderRadius: WORLD / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  faces: { position: 'absolute', right: 0, bottom: -FACE / 2 + 4, flexDirection: 'row' },
  face: {
    width: FACE,
    height: FACE,
    borderRadius: FACE / 2,
    marginLeft: -4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: universe.paper,
    borderWidth: 1,
    borderColor: universe.ink,
  },
  faceFinished: { borderColor: universe.fresh, borderWidth: 2 },
  faceInitial: { lineHeight: 12, fontSize: 9 },
  partFaces: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginTop: spacing[1] },
  partFaceRow: { flexDirection: 'row', paddingLeft: 4 },
  partFaceText: { flexShrink: 1 },
  lineGround: { paddingHorizontal: spacing[2], paddingBottom: spacing[1] },
  line: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    minHeight: 28,
    borderRadius: 14,
    borderWidth: 1,
  },
  lineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: universe.fresh },
  lineText: { flexShrink: 1 },
  tabs: {
    flexDirection: 'row',
    gap: spacing[1],
    padding: spacing[1],
    borderRadius: 18,
    backgroundColor: universe.paper2,
  },
  tab: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  tabSelected: { backgroundColor: universe.paper, borderWidth: 1, borderColor: 'rgba(21,48,42,0.16)' },
  members: { gap: spacing[3] },
  memberList: { gap: spacing[3] },
  member: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  memberText: { flex: 1 },
});
