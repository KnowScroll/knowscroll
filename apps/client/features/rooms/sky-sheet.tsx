import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccountScope, RoomSkyController, RoomSkyState } from '@knowscroll/client-core';
import { STAR_ACT_WORDS, skyLine, starsOfCurrent } from '@knowscroll/client-core';
import type { RoomNaming, RoomSky } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Skeleton, Text } from '@knowscroll/ui';
import { ChoiceRow } from './choice-row';
import { ConstellationView } from './constellation-view';
import { closesWords, dayHeading } from './today-words';
import { useRoomSky } from './use-room';

/** What the sky means right now, in plain words: how many stars are left, or that the station is lit. */
export function skySentence(sky: RoomSky): string {
  const left = sky.of - sky.lit;
  if (sky.state === 'naming')
    return 'Seven stars. The room is choosing its name, and the station is lit on its members’ maps.';
  if (sky.state === 'named')
    return `Seven stars, named ${sky.constellationName ?? 'by the room'}. The station is lit on its members’ maps.`;
  const more = `${String(left)} more ${left === 1 ? 'star lights' : 'stars light'} the station on its members’ maps.`;
  return sky.finished >= 1
    ? `The station is lit. ${String(left)} more ${left === 1 ? 'star makes' : 'stars make'} the next constellation.`
    : more;
}

/** The three names offered for a finished constellation, one tap to choose, changeable until the vote closes. */
function NamingVote({
  naming,
  controller,
  state,
}: {
  readonly naming: RoomNaming;
  readonly controller: RoomSkyController;
  readonly state: RoomSkyState;
}) {
  return (
    <View style={styles.naming} testID="sky-naming">
      <Text variant="ui" heading={3}>
        Name this constellation
      </Text>
      <View role="radiogroup" accessibilityLabel="Names for the constellation" style={styles.options}>
        {naming.candidates.map((name, index) => {
          const votes = naming.votes?.[index];
          return (
            <ChoiceRow
              key={name}
              testID={`sky-name-${String(index)}`}
              text={name}
              checked={naming.yourVote === index}
              disabled={state.working}
              onChoose={() => void controller.name(naming.constellation, index)}
              {...(votes === undefined
                ? {}
                : {
                    accessibilityLabel: `${name}, ${String(votes)} ${votes === 1 ? 'vote' : 'votes'}`,
                    detail: (
                      <Text variant="metaS" color={content.ink2}>
                        {`${String(votes)} ${votes === 1 ? 'vote' : 'votes'}`}
                      </Text>
                    ),
                  })}
            />
          );
        })}
      </View>
      <Text variant="metaS" color={content.ink2}>
        {`Anyone in the room can choose. You can change your choice until ${closesWords(naming.closesAt)}.`}
      </Text>
      {state.refused ? (
        <Banner kind="error" lead="Couldn’t choose." message="The vote has changed. Here is how it stands now." />
      ) : null}
    </View>
  );
}

function SkyBody({ state, controller }: { readonly state: RoomSkyState; readonly controller: RoomSkyController }) {
  const [selected, setSelected] = useState<number>();
  const view = state.view;
  if (view === undefined)
    return state.phase === 'loading' ? (
      <Skeleton rows={3} label="Loading the sky" />
    ) : (
      <Banner kind="offline" lead="Can’t read the sky." message="Check your connection and open it again." />
    );
  const stars = starsOfCurrent(view);
  const star = selected === undefined ? undefined : stars[selected];
  return (
    <View style={styles.body}>
      <Text variant="ui" testID="sky-line">{`${skyLine(view.sky)} stars`}</Text>
      <ConstellationView
        lit={view.sky.lit}
        selected={selected}
        onSelect={setSelected}
        label={`Constellation, ${skyLine(view.sky)} stars lit`}
      />
      <View accessibilityLiveRegion="polite" testID="sky-moment">
        <Text variant="bodyS" color={content.ink2}>
          {star === undefined
            ? 'Tap a star to see the moment that earned it.'
            : `${STAR_ACT_WORDS[star.act]} · ${dayHeading(star.day)}`}
        </Text>
      </View>
      <Text variant="bodyS">{skySentence(view.sky)}</Text>
      {view.naming === undefined ? null : <NamingVote naming={view.naming} controller={controller} state={state} />}
      <Text variant="metaS" color={content.ink2}>
        A star is a moment the room made together. Nobody owns a star, so nobody loses one. Spot the flaw, a topic
        closed by vote and an answer someone found useful each add one, up to {String(view.starsPerDay)} a day.
      </Text>
    </View>
  );
}

/**
 * The room's sky (R3 E): the constellation being made, a tap on a star for its moment, and the name vote while one is open.
 * Room-level facts only: a star says what happened and on which day, never who did it, and no number counts people.
 */
export function SkySheet({
  scope,
  roomId,
  visible,
  onClose,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly visible: boolean;
  readonly onClose: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="Room sky" onClose={onClose} testID="sky-sheet">
      <SkyContent scope={scope} roomId={roomId} />
    </BottomSheet>
  );
}

/** Reads the sky while the sheet is open: a closed sheet mounts nothing, so a room that never opens it never asks. */
export function SkyContent({ scope, roomId }: { readonly scope: AccountScope; readonly roomId: string }) {
  const { controller, state } = useRoomSky(scope, roomId);
  return <SkyBody state={state} controller={controller} />;
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  naming: {
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper2,
  },
  options: { gap: spacing[2] },
});
