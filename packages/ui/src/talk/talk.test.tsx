import { fireEvent, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { talkThemes, universe } from '@knowscroll/design-tokens';
import { expectPressed, renderOn } from '../test-support/render';
import { REACTION_KINDS, REACTION_LABELS } from './reaction-glyph';
import { ReactionBar, ReactionPill } from './reaction-pill';
import { DateCapsule, QuoteStrip, ReplyChip, TalkBubble } from './talk-bubble';
import { MenuList, MenuRow, TalkMenu } from './talk-menu';
import { TalkThemeProvider } from './talk-theme';

describe('TalkBubble', () => {
  it('is paper and ink for another person, cobalt for you, each with its chunky shadow, dark by default', async () => {
    await renderOn(
      <>
        <TalkBubble mine={false} testID="theirs">
          <Text>theirs</Text>
        </TalkBubble>
        <TalkBubble mine testID="mine">
          <Text>mine</Text>
        </TalkBubble>
      </>,
    );
    expect(screen.getByTestId('theirs')).toHaveStyle({
      backgroundColor: universe.paper,
      boxShadow: universe.shadow.bubbleOther,
      borderBottomLeftRadius: 4,
      borderRadius: 20,
    });
    expect(screen.getByTestId('mine')).toHaveStyle({
      backgroundColor: universe.cobalt,
      boxShadow: universe.shadow.bubbleOwn,
      borderBottomRightRadius: 4,
    });
  });

  it('keeps the tail for the last bubble of a run only', async () => {
    await renderOn(
      <TalkBubble mine={false} tail={false} testID="middle">
        <Text>middle</Text>
      </TalkBubble>,
    );
    expect(screen.getByTestId('middle')).not.toHaveStyle({ borderBottomLeftRadius: 4 });
  });

  it('is a theme switch away from the Paper look, with the same roles', async () => {
    await renderOn(
      <TalkThemeProvider name="paper">
        <TalkBubble mine={false} testID="theirs">
          <Text>theirs</Text>
        </TalkBubble>
      </TalkThemeProvider>,
    );
    expect(screen.getByTestId('theirs')).toHaveStyle({
      backgroundColor: talkThemes.paper.bubbleOther.fill,
      borderColor: talkThemes.paper.bubbleOther.edge,
    });
  });

  it('draws a flash as the highlight, or as a 2 px outline when motion is reduced, and a failure with a danger edge', async () => {
    await renderOn(
      <>
        <TalkBubble mine={false} flash="fill" testID="fill">
          <Text>a</Text>
        </TalkBubble>
        <TalkBubble mine={false} flash="outline" testID="outline">
          <Text>b</Text>
        </TalkBubble>
        <TalkBubble mine failed testID="failed">
          <Text>c</Text>
        </TalkBubble>
      </>,
    );
    expect(screen.getByTestId('fill')).toHaveStyle({ backgroundColor: universe.highlight });
    expect(screen.getByTestId('outline')).toHaveStyle({ borderWidth: 2, borderColor: universe.focus });
    expect(screen.getByTestId('failed')).toHaveStyle({ backgroundColor: universe.paper, borderWidth: 2 });
  });
});

describe('DateCapsule', () => {
  it('is a heading, so a screen reader can move between days', async () => {
    await renderOn(<DateCapsule label="Sun 26 Oct" />);
    expect(screen.getByRole('header', { name: 'Sun 26 Oct' })).toBeOnTheScreen();
  });
});

describe('QuoteStrip', () => {
  it('is a button that names the author and the original, and jumps when pressed', async () => {
    const onJump = jest.fn();
    await renderOn(<QuoteStrip onOwnBubble={false} author="Ravi" preview="who is on part 2?" onJump={onJump} />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Reply to Ravi: who is on part 2?. Go to the original message' }),
    );
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('says the original was removed, and is not a button, when there is no author', async () => {
    await renderOn(<QuoteStrip onOwnBubble author={undefined} preview="" onJump={undefined} />);
    expect(screen.getByText('Original message removed')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText('Reply to a message that was removed')).toBeOnTheScreen();
  });

  it('says a card without a note in plain words', async () => {
    await renderOn(<QuoteStrip onOwnBubble={false} author="Ravi" preview="" onJump={() => undefined} />);
    expect(screen.getByText('A shared Reel or Scroll')).toBeOnTheScreen();
  });
});

describe('ReplyChip', () => {
  it('names who is answered and cancels from its ✕', async () => {
    const onCancel = jest.fn();
    await renderOn(<ReplyChip author="Ravi" preview="moon ka bulge" onCancel={onCancel} />);
    expect(screen.getByText('Replying to Ravi')).toBeOnTheScreen();
    expect(screen.getByText('moon ka bulge')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel reply' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('reactions', () => {
  it('has five, each with a word that names it', () => {
    expect(REACTION_KINDS).toEqual(['spark', 'mind_blown', 'ha', 'heart', 'question']);
    expect(Object.values(REACTION_LABELS)).toEqual(['Spark', 'Mind blown', 'Ha', 'Heart', 'Question']);
  });

  it('draws a pill that says how many people and whether the reader is one, and lists who when pressed', async () => {
    const onPress = jest.fn();
    await renderOn(<ReactionPill kind="spark" count={3} mine onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Spark, 3 people, including you' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('says one person, not one people', async () => {
    await renderOn(<ReactionPill kind="ha" count={1} mine={false} onPress={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Ha, 1 person' })).toBeOnTheScreen();
  });

  it('shows the five in a bar as toggles, the held ones pressed, and reports the one picked', async () => {
    const onPick = jest.fn();
    await renderOn(<ReactionBar held={new Set(['heart'])} onPick={onPick} />);
    expect(screen.getAllByRole('togglebutton')).toHaveLength(5);
    expectPressed(screen.getByRole('togglebutton', { name: 'Heart' }), true);
    expectPressed(screen.getByRole('togglebutton', { name: 'Spark' }), false);
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Mind blown' }));
    expect(onPick).toHaveBeenCalledWith('mind_blown');
  });
});

describe('TalkMenu', () => {
  it('is a dialog named for what it is, with the message echoed, and closes from its dimmed scrim', async () => {
    const onClose = jest.fn();
    const onReply = jest.fn();
    await renderOn(
      <TalkMenu
        visible
        title="Message options"
        onClose={onClose}
        echoAlign="end"
        echo={<Text>the echoed message</Text>}
      >
        <MenuList>
          <MenuRow icon="reply" label="Reply" keyHint="R" onPress={onReply} />
          <MenuRow icon="flag" label="Report" danger onPress={() => undefined} />
        </MenuList>
      </TalkMenu>,
    );
    expect(screen.getByLabelText('Message options')).toHaveProp('role', 'dialog');
    expect(screen.getByText('the echoed message')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('menuitem', { name: 'Reply' }));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menuitem', { name: 'Reply' })).toHaveProp('accessibilityHint', 'Key R');
    await fireEvent.press(screen.getByTestId('talk-menu-scrim', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is nothing while hidden', async () => {
    await renderOn(
      <TalkMenu visible={false} title="Message options" onClose={() => undefined} echoAlign="start" echo={null}>
        <MenuList>
          <MenuRow icon="copy" label="Copy" onPress={() => undefined} />
        </MenuList>
      </TalkMenu>,
    );
    expect(screen.queryByLabelText('Message options')).toBeNull();
  });
});
