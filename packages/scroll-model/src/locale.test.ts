/**
 * English number formatting only in v1, and an integrity hash that never depends on the runtime
 * locale (coordinator ruling on #254): two devices in different locales must print the same
 * numbers and agree on every hash.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
  computeIntegrity,
  evaluateSimulation,
  formatNumber,
  formatWithUnit,
  parseDocument,
  renderTemplate,
  validateDocument,
} from './index.js';
import { allFixtures } from './test-support/fixtures.js';

const sourceDirectory = new URL('./', import.meta.url);

/** Replaces `target[key]` and returns the function that puts the original back. */
function replace(target: object, key: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  return () => {
    if (original === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, original);
  };
}

/** Replaces every locale-sensitive built-in with one that gives a different answer or throws, then restores them. */
function withHostileLocale<T>(run: () => T): T {
  const hostile = () => {
    throw new Error('a locale-sensitive API was used');
  };
  const restores = [
    replace(Number.prototype, 'toLocaleString', () => '١٢٣٫٤٥'),
    replace(String.prototype, 'localeCompare', hostile),
    replace(String.prototype, 'toLocaleUpperCase', hostile),
    replace(String.prototype, 'toLocaleLowerCase', hostile),
    replace(Array.prototype, 'toLocaleString', hostile),
    replace(Intl, 'NumberFormat', hostile),
    replace(Intl, 'Collator', hostile),
    replace(Intl, 'PluralRules', hostile),
  ];
  try {
    return run();
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

describe('English number formatting only, and a hash that does not depend on the locale', () => {
  it('formats the same numbers whatever the runtime locale says', () => {
    const formats = [
      { decimals: 0, grouping: true, approximate: false },
      { decimals: 2, grouping: false, approximate: true, suffix: '×' },
    ] as const;
    const expected = withHostileLocale(() => [
      formatNumber(1_234_567.891, formats[0]),
      formatNumber(-0.5, formats[1]),
      formatWithUnit(4_096, formats[0], 'words'),
      formatWithUnit(90, formats[0], '°'),
    ]);
    expect(expected).toEqual(['1,234,568', '~−0.50×', '4,096 words', '90°']);
  });

  it('renders a simulation’s readout in English under any locale', () => {
    const fixtures = allFixtures();
    const attention = fixtures[0]?.document.sections[1]?.blocks[2];
    if (attention?.type !== 'simulation' || attention.data.readout === undefined) throw new Error('fixture changed');
    const readout = attention.data.readout.template;
    const text = withHostileLocale(() =>
      renderTemplate(readout, attention.data, evaluateSimulation(attention.data, { len: 4_096 })),
    );
    expect(text).toBe('~64× the work of 512 words');
  });

  it('computes every fixture’s committed integrity hash and canonical form under any locale', () => {
    for (const item of allFixtures()) {
      const { integrity, rendition: _rendition, ...body } = item.document;
      const [hash, json, sha, valid, parsed] = withHostileLocale(() => [
        computeIntegrity(item.document),
        canonicalJson(item.document),
        canonicalSha256({ ...body }),
        validateDocument(item.document).kind,
        parseDocument(item.document, { verify: true }).kind,
      ]);
      expect(hash, item.name).toBe(integrity.sha256);
      expect(json, item.name).toBe(canonicalJson(item.document));
      expect(sha, item.name).toBe(canonicalSha256({ ...body }));
      expect([valid, parsed], item.name).toEqual(['valid', 'valid']);
    }
  });

  it('uses no locale-sensitive API in the package’s own code', () => {
    const forbidden =
      /\.toLocale\w*\(|\.localeCompare\(|Intl\.(?:NumberFormat|DateTimeFormat|Collator|PluralRules|ListFormat|RelativeTimeFormat|DisplayNames)\b/u;
    const files = readdirSync(sourceDirectory, { recursive: true, encoding: 'utf8' }).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.startsWith('test-support'),
    );
    expect(files.length).toBeGreaterThan(30);
    const offenders = files.filter((file) => forbidden.test(readFileSync(new URL(file, sourceDirectory), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
