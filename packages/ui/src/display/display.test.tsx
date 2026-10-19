import { render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { Text } from '../text/text';
import { DisplayProvider, DisplayRoot, useDisplay } from './display';

function Probe() {
  const display = useDisplay();
  return (
    <Text variant="meta">{`${display.breakpoint} ${display.textScale} ${display.reducedMotion ? 'reduced' : 'full'}`}</Text>
  );
}

describe('display', () => {
  it('subscribes to the reduce-motion setting once at the root, not once per text (M3)', async () => {
    const listen = jest.spyOn(AccessibilityInfo, 'addEventListener');
    const ask = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled');
    listen.mockClear();
    ask.mockClear();

    await render(
      <DisplayRoot>
        {Array.from({ length: 50 }, (_, index) => (
          <Text key={index} variant="body">{`Paragraph ${index}`}</Text>
        ))}
      </DisplayRoot>,
    );

    expect(listen.mock.calls.filter(([event]) => event === 'reduceMotionChanged')).toHaveLength(1);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('passes the system reduce-motion setting down from the root', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValueOnce(true);
    await render(
      <DisplayRoot>
        <Probe />
      </DisplayRoot>,
    );
    await waitFor(() => expect(screen.getByText(/reduced$/)).toBeOnTheScreen());
  });

  it('lets a provider pin parts of the display and inherit the rest', async () => {
    await render(
      <DisplayRoot>
        <DisplayProvider value={{ width: 320, reducedMotion: true }}>
          <DisplayProvider value={{ textScale: 1.5 }}>
            <Probe />
          </DisplayProvider>
        </DisplayProvider>
      </DisplayRoot>,
    );
    expect(screen.getByText('compact 1.5 reduced')).toBeOnTheScreen();
  });

  it('keeps a display that is already pinned around the root (tests, previews)', async () => {
    const listen = jest.spyOn(AccessibilityInfo, 'addEventListener');
    listen.mockClear();
    await render(
      <DisplayProvider value={{ width: 1440, textScale: 1, reducedMotion: false }}>
        <DisplayRoot>
          <Probe />
        </DisplayRoot>
      </DisplayProvider>,
    );
    expect(screen.getByText('desktop 1 full')).toBeOnTheScreen();
    expect(listen).not.toHaveBeenCalled();
  });

  it('works without a root: the current window at 100 % text, without subscribing', async () => {
    const listen = jest.spyOn(AccessibilityInfo, 'addEventListener');
    listen.mockClear();
    await render(<Probe />);
    expect(screen.getByText(/ 1 full$/)).toBeOnTheScreen();
    expect(listen).not.toHaveBeenCalled();
  });
});
