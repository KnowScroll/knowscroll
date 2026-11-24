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
      universeTrial: false,
      universeFrameRate: false,
    });
  });

  it('read what was stored, field by field, and drop a choice that no longer exists', () => {
    expect(
      parseDevicePreferences(
        JSON.stringify({
          motion: 'reduce',
          textSize: 'largest',
          reelSound: false,
          readyNotices: false,
          appearance: 'light',
          universeTrial: true,
          universeFrameRate: true,
          // Choices this version no longer has (a reader switch, the covers trial) are read past.
          scrollReader: 'folio',
          coversInExplore: true,
        }),
      ),
    ).toEqual({
      motion: 'reduce',
      textSize: 'largest',
      reelSound: false,
      readyNotices: false,
      appearance: 'light',
      universeTrial: true,
      universeFrameRate: true,
    });
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

  it('drops the covers trial switch a device stored, so the next write no longer holds it (#752)', () => {
    for (const stored of [true, false, 'yes'])
      expect(parseDevicePreferences(JSON.stringify({ reelSound: false, coversInExplore: stored }))).toEqual({
        ...defaultDevicePreferences,
        reelSound: false,
      });
  });

  it('start the Universe trial and its frame rate off, for a value stored before they existed', () => {
    const before = { motion: 'reduce', textSize: 'larger', reelSound: false, readyNotices: true, appearance: 'light' };
    const read = parseDevicePreferences(JSON.stringify(before));
    expect(read.universeTrial).toBe(false);
    expect(read.universeFrameRate).toBe(false);
    expect(needsRewrite(JSON.stringify(before))).toBe(false);
  });

  it('read a Universe switch that is not a true or false as off', () => {
    for (const stored of ['yes', 1, null, {}, []]) {
      const read = parseDevicePreferences(JSON.stringify({ universeTrial: stored, universeFrameRate: stored }));
      expect(read.universeTrial).toBe(false);
      expect(read.universeFrameRate).toBe(false);
    }
  });

  describe('carrying the Talk theme (D-151) over to Appearance (#666)', () => {
    const before = { motion: 'reduce', textSize: 'larger', reelSound: false, readyNotices: true };
    const universe = { universeTrial: false, universeFrameRate: false };

    it('turns Paper into Light and keeps every other choice', () => {
      expect(parseDevicePreferences(JSON.stringify({ ...before, talkTheme: 'paper' }))).toEqual({
        ...before,
        ...universe,
        appearance: 'light',
      });
    });

    it('turns the dark sky into Dark', () => {
      expect(parseDevicePreferences(JSON.stringify({ ...before, talkTheme: 'sky' }))).toEqual({
        ...before,
        ...universe,
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
