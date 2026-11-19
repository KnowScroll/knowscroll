import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '../../display/display';
import { EndPlateView, type EndPlateProps } from './end-plate';

async function show(takeaway: readonly string[], overrides: Partial<EndPlateProps> = {}) {
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <EndPlateView
        end={{ takeaway, smallPrint: { title: 'Where it stops working', text: 'Only for a tilted planet.' } }}
        figureHeight={200}
        reducedMotion
        textVersion={false}
        {...overrides}
      />
    </DisplayProvider>,
  );
}

describe('the end plate summary (D-429)', () => {
  it('is headed "To sum up" and reads the captions as one paragraph, with a full stop where one is missing', async () => {
    await show(['The tilt makes the seasons', 'Distance does not.', 'Is it summer where you are?']);
    expect(screen.getByText('To sum up')).toBeOnTheScreen();
    expect(screen.queryByText('The short version')).not.toBeOnTheScreen();
    expect(screen.getByTestId('end-summary')).toHaveTextContent(
      'The tilt makes the seasons. Distance does not. Is it summer where you are?',
    );
  });

  it('does not double a full stop, and skips an empty caption', async () => {
    await show(['One idea.', '  ', 'Another “quoted.”']);
    expect(screen.getByTestId('end-summary')).toHaveTextContent('One idea. Another “quoted.”');
  });

  it('keeps Small print below the summary', async () => {
    await show(['One idea']);
    await fireEvent.press(screen.getByRole('button', { name: 'Small print' }));
    expect(screen.getByTestId('end-small-print')).toHaveTextContent('Where it stops workingOnly for a tilted planet.');
  });
});
