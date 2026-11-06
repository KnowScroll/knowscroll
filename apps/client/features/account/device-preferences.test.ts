import { defaultDevicePreferences, needsRewrite, parseDevicePreferences } from './device-preferences';

describe('device preferences', () => {
  it('start with the device and the app as they are: a fresh install is Dark', () => {
    expect(parseDevicePreferences(null)).toEqual(defaultDevicePreferences);
    expect(defaultDevicePreferences).toEqual({
      motion: 'device',
      textSize: 'device',
      reelSound: true,
      readyNotices: true,
      appearance: 'dark',
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
          appearance: 'light',
        }),
      ),
    ).toEqual({ motion: 'reduce', textSize: 'largest', reelSound: false, readyNotices: false, appearance: 'light' });
  });

  it('fall back to the default for anything missing, misspelt or damaged', () => {
    expect(parseDevicePreferences('not json')).toEqual(defaultDevicePreferences);
    expect(parseDevicePreferences('7')).toEqual(defaultDevicePreferences);
    expect(
      parseDevicePreferences(JSON.stringify({ motion: 'always', textSize: 3, reelSound: 'no', appearance: 'neon' })),
    ).toEqual(defaultDevicePreferences);
    expect(parseDevicePreferences(JSON.stringify({ reelSound: false }))).toEqual({
      ...defaultDevicePreferences,
      reelSound: false,
    });
  });

  describe('carrying the Talk theme (D-151) over to Appearance (#666)', () => {
    const before = { motion: 'reduce', textSize: 'larger', reelSound: false, readyNotices: true };

    it('turns Paper into Light and keeps every other choice', () => {
      expect(parseDevicePreferences(JSON.stringify({ ...before, talkTheme: 'paper' }))).toEqual({
        ...before,
        appearance: 'light',
      });
    });

    it('turns the dark sky into Dark', () => {
      expect(parseDevicePreferences(JSON.stringify({ ...before, talkTheme: 'sky' }))).toEqual({
        ...before,
        appearance: 'dark',
      });
    });

    it('starts an unknown Talk theme on the default, including names an object inherits', () => {
      expect(parseDevicePreferences(JSON.stringify({ talkTheme: 'neon' })).appearance).toBe('dark');
      expect(parseDevicePreferences(JSON.stringify({ talkTheme: 'constructor' })).appearance).toBe('dark');
      expect(parseDevicePreferences(JSON.stringify({ talkTheme: 'toString' })).appearance).toBe('dark');
    });

    it('lets a stored appearance win over a leftover Talk theme', () => {
      expect(parseDevicePreferences(JSON.stringify({ talkTheme: 'paper', appearance: 'dark' })).appearance).toBe(
        'dark',
      );
    });

    it('rewrites a value that still holds the Talk theme or has no appearance, and nothing else', () => {
      expect(needsRewrite(JSON.stringify({ ...before, talkTheme: 'paper' }))).toBe(true);
      expect(needsRewrite(JSON.stringify(before))).toBe(true);
      expect(needsRewrite(JSON.stringify({ ...before, appearance: 'light' }))).toBe(false);
      expect(needsRewrite(null)).toBe(false);
      expect(needsRewrite('not json')).toBe(false);
    });
  });
});
