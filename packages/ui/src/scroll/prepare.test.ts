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

function sourcesOf(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourcesOf(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !path.includes('/fixtures/') ? [path] : [];
  });
}

describe('the renderer on the device', () => {
  it("never calls the admission path (the full-grid proof is the server's)", () => {
    const forbidden = /\b(admitDocument|admitBlock)\b|purpose:\s*'stored'|sweepGrid|validateDraft|compileDraft/;
    const offenders = sourcesOf(__dirname).filter((path) => forbidden.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('imports only the public entry of the scroll model, never its producer or internal entries', () => {
    const offenders = sourcesOf(__dirname).filter((path) =>
      /@knowscroll\/scroll-model\/(producer|internal)/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
