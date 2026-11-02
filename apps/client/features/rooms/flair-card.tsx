import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { RoomSkyController } from '@knowscroll/client-core';
import { FLAIR_HOW, FLAIR_WORDS, flairProgressWords } from '@knowscroll/client-core';
import type { RoomFlairChoice, RoomFlairView } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { ChoiceRow } from './choice-row';
import { FlairChip } from './flair-chip';

type Card = Extract<RoomFlairView, { status: 'ready' }>;

/** The words of the chooser's two rows that are not a mark. */
const AUTOMATIC = { text: 'The first one I earned', detail: 'Shows beside your name while you have one.' };
const NOTHING = { text: 'Nothing', detail: 'No flair beside your name. Only you can change this.' };

/** What the person's choice says as a chooser row: `auto` when they never chose, a mark, or `none`. */
const chosen = (card: Card): RoomFlairChoice | 'auto' => card.choice ?? 'auto';

/**
 * Where a person picks what shows beside their name: the first mark they earned, one of the ones they earned, or nothing.
 * One radio group, so a keyboard and a screen reader reach it as they do the room's other choices.
 */
function FlairChooser({
  card,
  working,
  onChoose,
}: {
  readonly card: Card;
  readonly working: boolean;
  readonly onChoose: (choice: RoomFlairChoice | 'auto') => void;
}) {
  const current = chosen(card);
  return (
    <View
      role="radiogroup"
      accessibilityLabel="Flair to show beside your name"
      style={styles.options}
      testID="flair-chooser"
    >
      <ChoiceRow
        testID="flair-choice-auto"
        text={AUTOMATIC.text}
        detail={
          <Text variant="metaS" color={content.ink2}>
            {AUTOMATIC.detail}
          </Text>
        }
        checked={current === 'auto'}
        disabled={working}
        onChoose={() => onChoose('auto')}
      />
      {card.earned.map((flair) => (
        <ChoiceRow
          key={flair}
          testID={`flair-choice-${flair}`}
          text={FLAIR_WORDS[flair]}
          detail={
            <Text variant="metaS" color={content.ink2}>
              {FLAIR_HOW[flair]}
            </Text>
          }
          checked={current === flair}
          disabled={working}
          onChoose={() => onChoose(flair)}
        />
      ))}
      <ChoiceRow
        testID="flair-choice-none"
        text={NOTHING.text}
        detail={
          <Text variant="metaS" color={content.ink2}>
            {NOTHING.detail}
          </Text>
        }
        checked={current === 'none'}
        disabled={working}
        onChoose={() => onChoose('none')}
      />
    </View>
  );
}

/**
 * The person's own flair in this room (R3 E5, "You in Space room"): the one that shows beside their name, the others they earned,
 * the ones they are partway to, and where they choose or hide what shows. Only they see this card; everyone else sees the one mark
 * beside their name. Flair is earned by acts here, never by a total, and there is no ranking of people.
 */
export function FlairCard({
  roomName,
  card,
  controller,
  working,
}: {
  readonly roomName: string | undefined;
  readonly card: Card;
  readonly controller: Pick<RoomSkyController, 'chooseFlair'>;
  readonly working: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const others = card.earned.filter((flair) => flair !== card.shown);
  const nothingYet = card.earned.length === 0 && card.coming.length === 0;
  return (
    <View style={styles.card} testID="flair-card" role="group" accessibilityLabel="Your flair in this room">
      <View style={styles.head}>
        <View style={styles.avatar} aria-hidden>
          <Text variant="ui">Y</Text>
        </View>
        <Text variant="ui" heading={3} style={styles.title}>
          {roomName === undefined ? 'You in this room' : `You in ${roomName}`}
        </Text>
      </View>
      <View style={styles.chips}>
        {card.shown === undefined ? null : (
          <FlairChip flair={card.shown} look="showing" detail="Showing" testID="flair-shown" />
        )}
        {others.map((flair) => (
          <FlairChip key={flair} flair={flair} look="earned" testID={`flair-earned-${flair}`} />
        ))}
        {card.coming.map((coming) => (
          <FlairChip
            key={coming.flair}
            flair={coming.flair}
            look="coming"
            detail={`${String(coming.have)}/${String(coming.of)}`}
            testID={`flair-coming-${coming.flair}`}
          />
        ))}
      </View>
      {nothingYet ? (
        <Text variant="metaS" color={content.ink2} testID="flair-empty">
          Flair is earned by what you do here: answering a question, leaving one people find useful, finding a flaw,
          playing a Launch.
        </Text>
      ) : null}
      {card.choice === 'none' ? (
        <Text variant="metaS" color={content.ink2} testID="flair-hidden">
          Your flair is hidden. Nobody sees one beside your name.
        </Text>
      ) : null}
      {card.coming.length === 0 ? null : (
        <Text variant="metaS" color={content.ink2} accessibilityLabel={card.coming.map(flairProgressWords).join('. ')}>
          Dashed marks are ones you are partway to.
        </Text>
      )}
      {card.earned.length === 0 ? null : (
        <Button
          label="Choose flair to show"
          size="sm"
          onPress={() => setChoosing((open) => !open)}
          testID="flair-choose"
          expanded={choosing}
        />
      )}
      {choosing ? (
        <FlairChooser card={card} working={working} onChoose={(choice) => void controller.chooseFlair(choice)} />
      ) : null}
      <Text variant="metaS" color={content.ink2}>
        Only you see this card. Others see the one mark beside your name.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[3],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  avatar: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    backgroundColor: content.paper2,
  },
  title: { flexShrink: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  options: { gap: spacing[2] },
});
