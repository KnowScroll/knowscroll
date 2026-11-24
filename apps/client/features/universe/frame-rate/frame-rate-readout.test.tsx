import { act, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';
import { FrameRateReadout, useFrameTimeRecorder } from './frame-rate-readout';

/** Stands in for the drawing loop: reports a steady 30 fps for a second, or says nobody listens. */
function Loop({ onRecorder }: { readonly onRecorder: (present: boolean) => void }) {
  const record = useFrameTimeRecorder();
  useEffect(() => {
    onRecorder(record !== undefined);
    const now = performance.now();
    for (let index = 0; index < 30; index += 1) record?.({ atMs: now - 1000 + index * 33.3, drawMs: 3 });
  }, [record, onRecorder]);
  return null;
}

describe('the frame-rate readout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is not there, and records nothing, unless the device asked for it', async () => {
    const heard = jest.fn();
    await render(
      <FrameRateReadout on={false}>
        <Loop onRecorder={heard} />
      </FrameRateReadout>,
    );
    expect(screen.queryByTestId('universe-frame-rate')).toBeNull();
    expect(heard).toHaveBeenLastCalledWith(false);
  });

  it('shows what the loop drew over the last two seconds', async () => {
    const heard = jest.fn();
    await render(
      <FrameRateReadout on>
        <Loop onRecorder={heard} />
      </FrameRateReadout>,
    );
    expect(heard).toHaveBeenLastCalledWith(true);
    await act(() => jest.advanceTimersByTimeAsync(500));
    expect(screen.getByTestId('universe-frame-rate')).toHaveTextContent(/fps · 100% on time · longest 33 ms/);
  });
});
