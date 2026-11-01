import { StyleSheet, View } from 'react-native';
import type { RoomHere } from '@knowscroll/contracts';
import { hereView, quietPill, type HereFaceView } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { useBandTone } from './identity/band-tone';
import { useNow } from './use-now';

/** Face colours: fixed, never a score, picked from the person's own ID so a face keeps its colour. */
const FACE_COLOURS = [content.continue, content.fresh, content.paper, content.paper2] as const;
const colourOf = (personId: string): string => {
  let hash = 0;
  for (const character of personId) hash = (hash * 31 + character.charCodeAt(0)) % 997;
  return FACE_COLOURS[hash % FACE_COLOURS.length]!;
};

function Face({ face }: { readonly face: HereFaceView }) {
  const tone = useBandTone();
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={face.you ? `${face.name}, you` : face.name}
      style={[
        styles.face,
        { backgroundColor: colourOf(face.personId), borderColor: tone.ground },
        face.you ? styles.faceYou : null,
      ]}
      testID={`here-face-${face.personId}`}
    >
      <Text variant="label" color={content.ink}>
        {face.initials}
      </Text>
    </View>
  );
}

/**
 * Who has the room open (D-069), on the room's dark band: the faces, in words when there are two, a number only
 * from three, and nothing at all about how many are "online" below that. Under it, when nothing has been said for a
 * while, the honest quiet pill with when a person last wrote. Nothing here is an AI inhabitant or a guess.
 */
export function HereStrip({
  here,
  lastMessageAt,
}: {
  readonly here: RoomHere;
  readonly lastMessageAt: string | undefined;
}) {
  const now = useNow(30_000);
  const tone = useBandTone();
  const view = hereView(here);
  const pill = quietPill(lastMessageAt, now);
  return (
    <View style={styles.strip} testID="here-strip">
      <View style={styles.faces} accessibilityLabel={view.caption ?? 'Only you are here'} role="group">
        {view.faces.map((face) => (
          <Face key={face.personId} face={face} />
        ))}
        {view.caption === undefined ? null : (
          <Text variant="metaS" color={tone.inkSoft} testID="here-caption">
            {view.caption}
          </Text>
        )}
      </View>
      {pill === undefined ? null : (
        <View
          style={[styles.pill, { borderColor: tone.edge, backgroundColor: tone.wash }]}
          testID="quiet-pill"
          accessibilityLiveRegion="polite"
        >
          <Text variant="monoXs" color={tone.ink}>
            {pill}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * D04's right pane, "Here now": the same faces as the strip, each with a name. The number is in the heading only from
 * three people; below that the names are the whole answer.
 */
export function HereNow({ here }: { readonly here: RoomHere }) {
  const view = hereView(here);
  return (
    <View style={styles.now} testID="here-now" role="list" accessibilityLabel="Here now">
      <Text variant="monoXs" color={content.ink2}>
        {view.countLabel === undefined ? 'Here now' : `Here now · ${view.countLabel.replace(' here', '')}`}
      </Text>
      {view.faces.map((face) => (
        <View key={face.personId} role="listitem" style={styles.nowRow}>
          <Face face={face} />
          <Text variant="bodyS">{face.you ? `${face.name} (you)` : face.name}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  now: { gap: spacing[2] },
  nowRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingLeft: spacing[1] },
  strip: { gap: spacing[2] },
  faces: { flexDirection: 'row', alignItems: 'center', gap: spacing[1], flexWrap: 'wrap' },
  face: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.regular,
    marginRight: -spacing[1],
  },
  faceYou: { borderColor: content.accent },
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radius.pill,
    borderWidth: borderWidth.hairline,
  },
});
