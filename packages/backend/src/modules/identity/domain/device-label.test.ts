import { describe, expect, it } from 'vitest';
import { deviceLabelOf } from './device-label.js';

const chromeOnMac =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const safariOnIphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const edgeOnWindows =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const firefoxOnLinux = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
const chromeOnAndroid =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

describe('deviceLabelOf', () => {
  it.each([
    [chromeOnMac, 'Chrome on macOS'],
    [safariOnIphone, 'Safari on iPhone'],
    [edgeOnWindows, 'Edge on Windows'],
    [firefoxOnLinux, 'Firefox on Linux'],
    [chromeOnAndroid, 'Chrome on Android'],
  ])('names a browser and its system coarsely', (userAgent, label) => {
    expect(deviceLabelOf(userAgent, 'web')).toBe(label);
  });

  it('names the app and its system on native', () => {
    expect(deviceLabelOf('okhttp/4.12.0 (Linux; Android 14)', 'native')).toBe('KnowScroll on Android');
    expect(deviceLabelOf('KnowScroll/1 CFNetwork/1494 Darwin/23 (iPhone)', 'native')).toBe('KnowScroll on iPhone');
  });

  it('never leaves the label empty, whatever the client sends', () => {
    expect(deviceLabelOf(undefined, 'web')).toBe('Web browser');
    expect(deviceLabelOf('', 'native')).toBe('KnowScroll app');
    expect(deviceLabelOf('curl/8.0', 'web')).toBe('Web browser');
  });

  it('keeps no version number, address or header text in the label', () => {
    const label = deviceLabelOf(`${chromeOnMac} 203.0.113.9 person@example.com`, 'web');
    expect(label).toBe('Chrome on macOS');
    expect(deviceLabelOf('x'.repeat(5000), 'web').length).toBeLessThanOrEqual(80);
  });
});
