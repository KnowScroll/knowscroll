import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { DevicePreferencesProvider } from '../../providers/device-preferences';
import { defaultDevicePreferences, type DevicePreferences } from '../account/device-preferences';
import { useUniverseTrial } from './universe-trial';

jest.mock('../../platform/device-preferences-store', () => ({
  devicePreferencesStore: { read: () => null, write: () => undefined },
}));

async function trial(initial?: DevicePreferences) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DevicePreferencesProvider initial={initial}>{children}</DevicePreferencesProvider>
  );
  return (await renderHook(() => useUniverseTrial(), { wrapper })).result.current;
}

describe('useUniverseTrial', () => {
  it('is off, with no readout, until this device turns them on', async () => {
    expect(await trial()).toEqual({ on: false, frameRate: false });
  });

  it('reads the two Universe choices of this device', async () => {
    expect(await trial({ ...defaultDevicePreferences, universeTrial: true })).toEqual({ on: true, frameRate: false });
    expect(await trial({ ...defaultDevicePreferences, universeFrameRate: true })).toEqual({
      on: false,
      frameRate: true,
    });
  });
});
