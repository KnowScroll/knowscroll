import { fireEvent, screen, within } from '@testing-library/react-native';
import { renderOn } from '../test-support/render';
import { FormatSwitch } from './format-switch';

describe('FormatSwitch', () => {
  it('is one labelled single-choice group of two equal options, the current format checked', async () => {
    await renderOn(<FormatSwitch selected="reel" onSelect={() => undefined} />);
    // A group is a container, not an accessibility element of its own, so it is found by its label.
    const group = screen.getByLabelText('Format of this explanation');
    expect(group).toHaveProp('accessibilityRole', 'radiogroup');

    expect(within(group).getByRole('radio', { name: 'Reel', checked: true })).toBeOnTheScreen();
    expect(within(group).getByRole('radio', { name: 'Scroll', checked: false })).toBeOnTheScreen();
  });

  it('asks for the other format on tap, and does nothing for the current one', async () => {
    const onSelect = jest.fn();
    await renderOn(<FormatSwitch selected="reel" onSelect={onSelect} />);

    await fireEvent.press(screen.getByRole('radio', { name: 'Reel' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Scroll' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('scroll');
  });

  it('says when the other format is still being prepared', async () => {
    const onSelect = jest.fn();
    await renderOn(<FormatSwitch selected="reel" availability={{ scroll: 'preparing' }} onSelect={onSelect} />);

    await fireEvent.press(screen.getByRole('radio', { name: 'Scroll · preparing' }));

    expect(onSelect).toHaveBeenCalledWith('scroll');
  });

  it('disables an unavailable format', async () => {
    const onSelect = jest.fn();
    await renderOn(<FormatSwitch selected="scroll" availability={{ reel: 'unavailable' }} onSelect={onSelect} />);
    const reel = screen.getByRole('radio', { name: 'Reel · unavailable' });

    await fireEvent.press(reel);

    expect(reel).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('gives each option a 44 px target (the export draws 38; D-006 n)', async () => {
    await renderOn(<FormatSwitch selected="reel" onSelect={() => undefined} />);
    expect(screen.getByRole('radio', { name: 'Scroll' })).toHaveStyle({ minHeight: 44 });
  });
});
