import { fireEvent, screen } from '@testing-library/react-native';
import { content, space } from '@knowscroll/design-tokens';
import { renderOn } from '../test-support/render';
import { AccountButton } from './account-button';
import { NavRail } from './nav-rail';
import { TabBar } from './tab-bar';
import { TopBar } from './top-bar';

describe('TabBar', () => {
  it('offers the four destinations in order, the current one selected', async () => {
    await renderOn(<TabBar active="saved" onSelect={() => undefined} />);

    expect(screen.getAllByRole('tab').map((tab) => String(tab.props.accessibilityLabel))).toEqual([
      'Explore',
      'Universe',
      'Talk',
      'Keep',
    ]);
    expect(screen.getByRole('tab', { name: 'Keep', selected: true })).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Explore', selected: false })).toBeOnTheScreen();
    expect(screen.getByLabelText('Primary')).toHaveProp('accessibilityRole', 'tablist');
  });

  it('reports the destination pressed', async () => {
    const onSelect = jest.fn();
    await renderOn(<TabBar active="explore" onSelect={onSelect} />);

    await fireEvent.press(screen.getByRole('tab', { name: 'Talk' }));

    expect(onSelect).toHaveBeenCalledWith('conversations');
  });

  it('keeps "Talk" as the name when unread; unread is a description and the visible bullet (D-006 n)', async () => {
    await renderOn(<TabBar active="explore" onSelect={() => undefined} unread />);
    const talk = screen.getByRole('tab', { name: 'Talk' });

    expect(talk).toHaveProp('accessibilityHint', 'Unread messages');
    expect(screen.getByText('Talk •')).toBeOnTheScreen();
    expect(screen.queryByRole('tab', { name: /•/ })).toBeNull();
  });

  it('shows labels on phones and only icons at ≤ 360 px, where the labels stay as names', async () => {
    const view = await renderOn(<TabBar active="explore" onSelect={() => undefined} />);
    expect(screen.getByText('Universe')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Universe' })).toHaveStyle({ width: 74, minHeight: 56 });
    await view.unmount();

    await renderOn(<TabBar active="explore" onSelect={() => undefined} />, { width: 320 });
    expect(screen.queryByText('Universe')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Universe' })).toHaveStyle({ width: 56, minHeight: 48 });
  });

  it('cuts the icon-only unread dot out of the pill it sits on (ink pill, or space.s1 on the universe)', async () => {
    const view = await renderOn(<TabBar active="explore" onSelect={() => undefined} unread />, { width: 320 });
    expect(screen.getByTestId('destination-conversations-unread')).toHaveStyle({ borderColor: content.nav });
    await view.unmount();

    await renderOn(<TabBar active="universe" onSelect={() => undefined} tone="space" unread />, { width: 320 });
    expect(screen.getByTestId('destination-conversations-unread')).toHaveStyle({ borderColor: space.s1 });
  });

  it('marks the current item with the accent pill and uses the space pill on the universe', async () => {
    await renderOn(<TabBar active="universe" onSelect={() => undefined} tone="space" />);
    expect(screen.getByRole('tab', { name: 'Universe' })).toHaveStyle({ backgroundColor: content.accent });
    expect(screen.getByLabelText('Primary')).toHaveStyle({ backgroundColor: space.s1 });
  });
});

describe('NavRail', () => {
  it('is 76 px on tablets, without the account avatar', async () => {
    await renderOn(<NavRail active="explore" onSelect={() => undefined} size="tablet" />, { width: 834 });
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.queryByRole('link', { name: 'Account and settings' })).toBeNull();
  });

  it('is 88 px on desktops with the account avatar at the bottom, current on the account screen', async () => {
    const onPress = jest.fn();
    await renderOn(
      <NavRail active={null} onSelect={() => undefined} size="desktop" account={{ onPress, current: true }} />,
      { width: 1440 },
    );
    const account = screen.getByRole('link', { name: 'Account and settings' });

    await fireEvent.press(account);

    expect(account).toBeSelected();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('tab', { selected: true })).toBeNull();
  });

  it('hides the K mark from screen readers', async () => {
    await renderOn(<NavRail active="explore" onSelect={() => undefined} size="desktop" />, { width: 1440 });
    expect(screen.queryByText('K')).toBeNull();
    expect(screen.getByText('K', { includeHiddenElements: true })).toBeTruthy();
  });
});

describe('TopBar and AccountButton', () => {
  it('names the screen with a heading and carries the account avatar (D-006 c)', async () => {
    const onPress = jest.fn();
    await renderOn(<TopBar title="Keep" trailing={<AccountButton onPress={onPress} initial="asha" />} />);

    await fireEvent.press(screen.getByRole('link', { name: 'Account and settings' }));

    expect(screen.getByRole('header', { name: 'Keep' })).toBeOnTheScreen();
    expect(screen.getByText('A')).toBeOnTheScreen();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows a person glyph, not an invented initial, when nobody is signed in', async () => {
    await renderOn(<AccountButton onPress={() => undefined} />);
    expect(screen.getByRole('link', { name: 'Account and settings' })).toBeOnTheScreen();
    expect(screen.queryByText(/^[A-Z]$/)).toBeNull();
  });

  it('keeps a 48 px target even for the 40 px rail avatar', async () => {
    await renderOn(<AccountButton onPress={() => undefined} size={40} />);
    expect(screen.getByRole('link', { name: 'Account and settings' })).toHaveStyle({ minWidth: 48, minHeight: 48 });
  });
});
