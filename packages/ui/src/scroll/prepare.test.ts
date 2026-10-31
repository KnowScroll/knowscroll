/// <reference types="node" />
// The source scan reads this package's files from disk; Node types are scoped to this file.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bridgesPoster, bridgesWithServerFallback, lighthouseEditorial } from './fixtures/documents';
import { isParsedBlock, prepareScrollDocument } from './prepare';

describe('prepareScrollDocument (the client parse)', () => {
  it.each([
    ['the poster', bridgesPoster],
    ['the editorial', lighthouseEditorial],
    ['a negotiated rendition', bridgesWithServerFallback],
  ])('accepts %s, and its hash verifies when asked', (_name, build) => {
    expect(prepareScrollDocument(build()).kind).toBe('ready');
    expect(prepareScrollDocument(build(), { verify: true }).kind).toBe('ready');
  });

  it('checks the hash only when asked: it is not on the render path', () => {
    const edited = { ...bridgesPoster(), title: 'A title edited after signing' };

    expect(prepareScrollDocument(edited).kind).toBe('ready');
    expect(prepareScrollDocument(edited, { verify: true }).kind).toBe('invalid');
  });

  it('names a document that is not scroll-document.v1', () => {
    const outcome = prepareScrollDocument({ ...bridgesPoster(), schemaVersion: 'scroll-document.v2' });
    expect(outcome).toEqual({ kind: 'unsupported-version', schemaVersion: 'scroll-document.v2' });
  });

  it('refuses a document that breaks a limit, with stable reason codes and no text', () => {
    const outcome = prepareScrollDocument({ ...bridgesPoster(), sections: [] });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') expect(outcome.issues.length).toBeGreaterThan(0);
    expect(prepareScrollDocument('not a document').kind).toBe('invalid');
  });

  it('marks the blocks it parsed, nested ones included, so the article does not parse them again', () => {
    const outcome = prepareScrollDocument(bridgesPoster());
    if (outcome.kind !== 'ready') throw new Error('the fixture must parse');
    const disclosure = outcome.document.sections
      .flatMap((section) => section.blocks)
      .find((block) => block.type === 'disclosure');

    expect(disclosure).toBeDefined();
    expect(isParsedBlock(outcome.document.sections[0]?.blocks[0] as object)).toBe(true);
    expect(isParsedBlock(disclosure as object)).toBe(true);
    expect(isParsedBlock({ ...(disclosure as object) })).toBe(false);
  });
});

function sourcesOf(directory: string, withFixtures = false): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourcesOf(path, withFixtures);
    const fixture = path.includes('/fixtures/') && !withFixtures;
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !fixture ? [path] : [];
  });
}

describe('the renderer on the device', () => {
  it("never calls the admission path (the full-grid proof is the server's)", () => {
    const clientEntries = new Set([
      'BLOCK_TYPES',
      'BLOCK_VERSIONS',
      'INTEGRITY_METHOD',
      'SCROLL_DOCUMENT_SCHEMA_VERSION',
      'SCROLL_LIMITS_VERSION',
      'blockStateProblems',
      'canonicalJson',
      'computeIntegrity',
      'computeMeasures',
      'ILLUSTRATIVE_NOTICE',
      'curveUsable',
      'deriveGesture',
      'displayFraction',
      'displayRange',
      'evaluateSimulation',
      'formatNumber',
      'formatWithUnit',
      'gridValues',
      'isIllustrative',
      'outputsUsable',
      'readoutBand',
      'renderTemplate',
      'resolveParams',
      'sampleCurve',
      'snapToGrid',
      'defaultBlockState',
      'fallbackTextOf',
      'findBlock',
      'isGraphemeBoundary',
      'isInteractiveBlock',
      'negotiate',
      'parseBlock',
      'parseDocument',
      'walkBlocks',
      // The v2 reader's own: pure lookups over a parsed document, nothing that proves it.
      'callsOf',
      'stageParts',
      'stagePhysics',
      // The tally of a Scroll's calls (sparks and combo) and the finish of a landmark: arithmetic over locks, no admission.
      'talliesAfterEach',
      'finalBonusReady',
      'landmarkTier',
      // The tilt a reader turns at the Final call: the kit's physics at one angle, no grid and no admission.
      'AXIAL_TILT_DEGREES',
      'TILT_RANGE',
      'physicsAtTilt',
      'describeStageAtTilt',
      // The other drawing kits' physics (D-194): the same derivations the text versions use, at one state, with no admission.
      'brightnessAt',
      'greenhouseParts',
      'greenhousePhysics',
      'lifetimeInSunLifetimes',
      'mainSequenceRadiusInSuns',
      'moonPull',
      'PLANET_WIDTH_SHARE',
      'SOLAR_SHARE_OF_LUNAR',
      'STAR_ENUMS',
      'starParts',
      'starPhysics',
      'surfaceAt',
      'tideRangeByPhase',
      'TIDES_ENUMS',
      'tidesParts',
      'tidesPhysics',
      'transitParts',
      'transitPhysics',
      // The Space kits' physics (D-204): the same derivations the text versions use, at one state, with no admission.
      'BLACK_HOLE_ENUMS',
      'blackbodyColour',
      'HOLE_MASS_IN_SUNS',
      'pullAt',
      'blackHoleParts',
      'blackHolePhysics',
      'DISC_INNER_EDGE_IN_HORIZON_RADII',
      'DISC_RINGS',
      'discKelvins',
      'mainSequenceLuminosityAt',
      'ORBIT_RADII',
      'orbitSpeed',
      'separationAt',
      'SHADOW_RADIUS_IN_HORIZON_RADII',
      'STARLIGHT_ENUMS',
      'starlightParts',
      'starlightPhysics',
      'starlightStar',
      'STARS_BY_TEMPERATURE',
      'TIME_TO_MERGER',
      'VISIBLE_NANOMETRES',
      'waveFrequencyAt',
      'wavelengthColour',
      'waveStrengthAt',
      'ZONE_STARS',
    ]);
    const model = readFileSync(join(__dirname, 'model.ts'), 'utf8');
    const runtimeExports = [...model.matchAll(/export\s*\{([^}]+)\}\s*from/g)].flatMap((match) =>
      (match[1] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    );
    expect(runtimeExports.length).toBeGreaterThan(0);
    expect(runtimeExports.filter((name) => !clientEntries.has(name))).toEqual([]);
    expect(model).not.toMatch(/^export\s*\*/m);
    const forbidden =
      /\b(admitDocument|admitBlock|validateDocument|validateBlock|sweepGrid|validateDraft|compileDraft)\b|purpose:\s*'stored'/;
    const offenders = sourcesOf(__dirname).filter((path) => forbidden.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('imports only the public entry of the scroll model, never its producer or internal entries', () => {
    const offenders = sourcesOf(__dirname).filter((path) =>
      /@knowscroll\/scroll-model\/(producer|internal)/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('loads the model at run time through ./model only, so Zod is configured first (no eval under the CSP)', () => {
    const runtimeImport = /^import\s+(?!type\b)[^;]*?from\s+'@knowscroll\/scroll-model'/ms;
    const offenders = sourcesOf(__dirname, true).filter(
      (path) => !path.endsWith('/scroll/model.ts') && runtimeImport.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
