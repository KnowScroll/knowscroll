import type * as React from 'react';
import { type EffectCallback } from 'react';
import { BackHandler } from 'react-native';
import { render } from '@testing-library/react-native';
import { useEncounterBack } from './use-encounter-back';
import type { EncounterSession } from './encounter-session';
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return { useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]) };
});
function Host({ session }: { session: EncounterSession }) {
  useEncounterBack(session, true);
  return null;
}
describe('Android Back uses the encounter local path', () => {
  it('uses the same local Back function and releases the native subscription on blur/unmount', async () => {
    let callback: Parameters<typeof BackHandler.addEventListener>[1] | undefined;
    const remove = jest.fn();
    const subscription = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      callback = handler;
      return { remove };
    });
    const back = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const app = await render(<Host session={{ back } as unknown as EncounterSession} />);
    expect(callback?.({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true);
    expect(callback?.({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(false);
    expect(back).toHaveBeenCalledTimes(2);
    await app.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    subscription.mockRestore();
  });
});
