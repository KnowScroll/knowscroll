import { screen } from '@testing-library/react-native';
import { iconShapes, type IconName } from '../icons/icon-paths';
import { Icon } from '../icons/icon';
import { renderOn } from '../test-support/render';
import { Text } from './text';

describe('Text', () => {
  it('sets a role from the type scale in the bundled family', async () => {
    await renderOn(<Text variant="displayXl">Why models forget</Text>);
    expect(screen.getByText('Why models forget')).toHaveStyle({
      fontFamily: 'BricolageGrotesque',
      fontWeight: '800',
      fontSize: 44,
      lineHeight: 46,
    });
  });

  it('scales the authored roles by 15 % on desktop', async () => {
    await renderOn(<Text variant="body">A model reads every word</Text>, { width: 1440 });
    expect(screen.getByText('A model reads every word')).toHaveStyle({ fontSize: 20.5 });
  });

  it('applies the system text size itself, so the platform does not scale it twice', async () => {
    await renderOn(<Text variant="body">A model reads every word</Text>, { textScale: 2 });
    const text = screen.getByText('A model reads every word');
    expect(text).toHaveStyle({ fontSize: 26, lineHeight: 38 });
    expect(text).toHaveProp('allowFontScaling', false);
  });

  it('marks headings for screen readers', async () => {
    await renderOn(
      <Text variant="page" heading={1}>
        Keep
      </Text>,
    );
    expect(screen.getByRole('header', { name: 'Keep' })).toBeOnTheScreen();
  });
});

describe('Icon', () => {
  it.each(Object.keys(iconShapes) as IconName[])('%s renders hidden from assistive technology', async (name) => {
    const { root } = await renderOn(<Icon name={name} />);
    expect(root).toBeTruthy();
    expect(screen.queryAllByRole(/.+/)).toHaveLength(0);
  });
});
