import { defaultDevicePreferences, parseDevicePreferences } from './device-preferences';

describe('device preferences', () => {
  it('start with the device and the app as they are', () => {
    expect(parseDevicePreferences(null)).toEqual(defaultDevicePreferences);
    expect(defaultDevicePreferences).toEqual({
      motion: 'device',
      textSize: 'device',
      reelSound: true,
      readyNotices: true,
      talkTheme: 'sky',
    });
  });

  it('read what was stored, field by field', () => {
    expect(
      parseDevicePreferences(
        JSON.stringify({
          motion: 'reduce',
          textSize: 'largest',
          reelSound: false,
          readyNotices: false,
          talkTheme: 'paper',
        }),
      ),
    ).toEqual({ motion: 'reduce', textSize: 'largest', reelSound: false, readyNotices: false, talkTheme: 'paper' });
  });

  it('fall back to the default for anything missing, misspelt or damaged', () => {
    expect(parseDevicePreferences('not json')).toEqual(defaultDevicePreferences);
    expect(parseDevicePreferences('7')).toEqual(defaultDevicePreferences);
    expect(
      parseDevicePreferences(JSON.stringify({ motion: 'always', textSize: 3, reelSound: 'no', talkTheme: 'neon' })),
    ).toEqual(defaultDevicePreferences);
    expect(parseDevicePreferences(JSON.stringify({ reelSound: false }))).toEqual({
      ...defaultDevicePreferences,
      reelSound: false,
    });
  });
});
