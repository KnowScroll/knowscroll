import { lowMemoryDevice } from '../features/universe/space/low-memory-device.web';

const setMemory = (gigabytes: number | undefined) =>
  Object.defineProperty(navigator, 'deviceMemory', { value: gigabytes, configurable: true });

afterEach(() => {
  Reflect.deleteProperty(navigator, 'deviceMemory');
});

describe('a browser that says it has little memory opens the tab as the Simple lists (D-111)', () => {
  it('is low at one gigabyte or less, as the browser rounds it', () => {
    for (const gigabytes of [0.25, 0.5, 1]) {
      setMemory(gigabytes);
      expect(lowMemoryDevice()).toBe(true);
    }
  });

  it('is not low at two gigabytes or more, and assumes nothing where the browser says nothing', () => {
    for (const gigabytes of [2, 4, 8]) {
      setMemory(gigabytes);
      expect(lowMemoryDevice()).toBe(false);
    }
    Reflect.deleteProperty(navigator, 'deviceMemory');
    expect(lowMemoryDevice()).toBe(false);
  });
});
