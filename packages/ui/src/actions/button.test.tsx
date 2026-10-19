import { fireEvent, screen } from '@testing-library/react-native';
import { content, focusRing } from '@knowscroll/design-tokens';
import { expectPressed, renderOn } from '../test-support/render';
import { Button } from './button';

describe('Button', () => {
  it('is a button named by its label and reports presses', async () => {
    const onPress = jest.fn();
    await renderOn(<Button label="Request Scroll" variant="primary" onPress={onPress} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Request Scroll' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('navigating buttons are links', async () => {
    await renderOn(<Button label="Go to Explore" role="link" onPress={() => undefined} />);
    expect(screen.getByRole('link', { name: 'Go to Explore' })).toBeOnTheScreen();
  });

  it('is disabled at 45 % without its offset shadow, and ignores presses', async () => {
    const onPress = jest.fn();
    await renderOn(<Button label="Send" variant="primary" disabled onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Send' });

    await fireEvent.press(button);

    expect(button).toBeDisabled();
    expect(button).toHaveStyle({ opacity: 0.45 });
    expect(button).not.toHaveStyle({ boxShadow: '3px 3px 0px 0px #111111' });
    expect(onPress).not.toHaveBeenCalled();
  });

  it('carries the 3 px ink offset shadow at rest', async () => {
    await renderOn(<Button label="Save" />);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveStyle({ boxShadow: '3px 3px 0px 0px #111111' });
  });

  it('is busy, not disabled, while its command is in flight: verb-ing label, no second press', async () => {
    const onPress = jest.fn();
    await renderOn(<Button label="Send" busy busyLabel="Sending" onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Sending' });

    await fireEvent.press(button);

    expect(button).toBeBusy();
    expect(button).toBeEnabled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it('draws the cobalt focus ring on paper while focused, and removes it on blur', async () => {
    await renderOn(<Button label="Save" />);
    const button = screen.getByRole('button', { name: 'Save' });

    await fireEvent(button, 'focus');
    expect(button).toHaveStyle({
      outlineColor: focusRing.onLight.color,
      outlineWidth: 3,
      outlineOffset: 3,
    });

    await fireEvent(button, 'blur');
    expect(button).not.toHaveStyle({ outlineColor: focusRing.onLight.color });
  });

  it('uses the yellow focus ring on dark surfaces, where cobalt would vanish (D-006 n)', async () => {
    await renderOn(<Button label="Go to Explore" variant="space" />);
    const button = screen.getByRole('button', { name: 'Go to Explore' });

    await fireEvent(button, 'focus');

    expect(button).toHaveStyle({ outlineColor: focusRing.onDark.color });
  });

  it('meets the 48 px (md) and 44 px (sm) target heights', async () => {
    await renderOn(
      <>
        <Button label="Medium" />
        <Button label="Small" size="sm" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Medium' })).toHaveStyle({ minHeight: 48 });
    expect(screen.getByRole('button', { name: 'Small' })).toHaveStyle({ minHeight: 44 });
  });

  it('announces a two-state button as checked when pressed', async () => {
    await renderOn(<Button label="Save" toggled variant="primary" />);
    const save = screen.getByRole('togglebutton', { name: 'Save' });
    expectPressed(save, true);
    expect(save).toHaveStyle({ backgroundColor: content.accent });
  });

  it('navigates as a link: the press goes to the router, the address goes to the web anchor', async () => {
    const onPress = jest.fn();
    await renderOn(<Button label="Go to Explore" role="link" href="/explore" onPress={onPress} />);

    await fireEvent.press(screen.getByRole('link', { name: 'Go to Explore' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
