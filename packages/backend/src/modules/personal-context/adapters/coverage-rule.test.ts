import { describe, expect, it } from 'vitest';
import type { CoverageHead } from '../../content/public.js';
import { certificateValidOnHead } from './coverage-rule.js';
import { binding, certificate, digestOnlyHead, hash, head, secondBinding } from './coverage.fixture.js';

describe('certificateValidOnHead', () => {
  it('holds on the head the certificate was issued against', () => {
    expect(certificateValidOnHead(certificate(), head())).toBe(true);
  });

  it('holds on a later head that differs only in the catalogue digest and the head naming it', () => {
    expect(certificateValidOnHead(certificate(), digestOnlyHead())).toBe(true);
    expect(certificateValidOnHead(certificate(), digestOnlyHead(5))).toBe(true);
  });

  it('holds when only the head number and mapping digest differ', () => {
    expect(certificateValidOnHead(certificate(), head({ headRevision: 3, mappingSha256: hash('9') }))).toBe(true);
  });

  it('holds when the head gained a binding the certificate does not claim', () => {
    const wider = head({ headRevision: 2, mappingSha256: hash('9'), mapping: { bindings: [binding, secondBinding] } });
    expect(certificateValidOnHead(certificate(), wider)).toBe(true);
  });

  it('does not change its inputs', () => {
    const c = certificate(),
      h = digestOnlyHead();
    const before = JSON.stringify([c, h]);
    certificateValidOnHead(c, h);
    expect(JSON.stringify([c, h])).toBe(before);
  });

  it('refuses a retracted head even when every field would match', () => {
    expect(certificateValidOnHead(certificate(), head({ status: 'retracted' }))).toBe(false);
    expect(
      certificateValidOnHead(certificate(), head({ status: 'retracted', headRevision: 2, mappingSha256: hash('9') })),
    ).toBe(false);
  });

  it('refuses a certificate that carries no mapping', () => {
    expect(certificateValidOnHead({ ...certificate(), mapping: null }, head())).toBe(false);
  });

  it.each([
    ['document', { documentSha256: hash('d') }],
    ['provenance', { provenanceSha256: hash('d') }],
    ['explanation unit', { explanationUnitId: 'another-unit' }],
    ['framing digest', { framingSha256: hash('d') }],
    ['framing', { framing: 'speculative' }],
    ['reading facts version', { readingFactsVersion: 3 }],
    ['reading facts digest', { readingFactsSha256: hash('d') }],
    ['catalogue version', { catalogueVersion: 'content-concepts.v2' }],
  ])('refuses a later head whose %s differs', (_name, changed) => {
    const corrected = head({
      headRevision: 2,
      mappingSha256: hash('9'),
      mapping: { catalogueSha256: hash('c'), ...changed } as Partial<CoverageHead['mapping']>,
    });
    expect(certificateValidOnHead(certificate(), corrected)).toBe(false);
  });

  it('refuses a head for another asset revision', () => {
    const other = head();
    expect(
      certificateValidOnHead(certificate(), { ...other, authority: { ...other.authority, assetRevision: 2 } }),
    ).toBe(false);
    expect(
      certificateValidOnHead(certificate(), {
        ...other,
        authority: { ...other.authority, assetId: '20000000-0000-4000-8000-000000000002' },
      }),
    ).toBe(false);
  });

  it('refuses when the certificate facts digest is not the head reading facts digest', () => {
    expect(certificateValidOnHead(certificate({ factsSha256: hash('d') }), head())).toBe(false);
  });

  it('refuses a claimed binding the head no longer has', () => {
    const removed = head({ headRevision: 2, mappingSha256: hash('9'), mapping: { bindings: [secondBinding] } });
    expect(certificateValidOnHead(certificate(), removed)).toBe(false);
  });

  it('refuses a claimed binding whose facet meaning changed', () => {
    const reworded = head({
      headRevision: 2,
      mappingSha256: hash('9'),
      mapping: { bindings: [{ ...binding, meaningSha256: hash('d') }] },
    });
    expect(certificateValidOnHead(certificate(), reworded)).toBe(false);
  });

  it('refuses a claimed binding whose required blocks changed', () => {
    const relocated = head({
      headRevision: 2,
      mappingSha256: hash('9'),
      mapping: { bindings: [{ ...binding, requiredBlockIds: ['block-1'] }] },
    });
    expect(certificateValidOnHead(certificate(), relocated)).toBe(false);
  });

  it('refuses when only some of several claimed bindings survive', () => {
    const partial = head({ headRevision: 2, mappingSha256: hash('9'), mapping: { bindings: [binding] } });
    expect(certificateValidOnHead(certificate({ bindings: [binding, secondBinding] }), partial)).toBe(false);
  });
});

describe('certificateValidOnHead for a Reel (#674, slice 5.1)', () => {
  const reelBinding = {
    ...binding,
    requiredBlockIds: ['s1', 's3', 's6'],
    requiredSpans: [
      [0, 4000],
      [10_000, 14_000],
      [24_000, 30_000],
    ] as [number, number][],
  };
  const reelHead = (patch: Parameters<typeof head>[0] = {}) =>
    head({
      ...patch,
      mapping: { version: 'reel-static-coverage.v1', bindings: [reelBinding], ...patch.mapping },
    });
  const reelCertificate = () => certificate({ bindings: [reelBinding] });

  it('holds on the head it was issued against and on a head that differs only in the catalogue digest (D-406)', () => {
    expect(certificateValidOnHead(reelCertificate(), reelHead())).toBe(true);
    expect(
      certificateValidOnHead(
        reelCertificate(),
        reelHead({ headRevision: 2, mappingSha256: hash('9'), mapping: { catalogueSha256: hash('c') } }),
      ),
    ).toBe(true);
  });

  it('refuses a retracted head, and a head whose segments or windows changed after a re-cut', () => {
    expect(certificateValidOnHead(reelCertificate(), reelHead({ status: 'retracted' }))).toBe(false);
    const recut = {
      ...reelBinding,
      requiredSpans: [
        [0, 4000],
        [10_000, 14_000],
        [25_000, 30_000],
      ] as [number, number][],
    };
    expect(
      certificateValidOnHead(
        reelCertificate(),
        reelHead({ headRevision: 2, mappingSha256: hash('9'), mapping: { bindings: [recut] } }),
      ),
    ).toBe(false);
    expect(
      certificateValidOnHead(
        reelCertificate(),
        reelHead({
          headRevision: 2,
          mappingSha256: hash('9'),
          mapping: { bindings: [{ ...reelBinding, requiredBlockIds: ['s1', 's3', 's5'] }] },
        }),
      ),
    ).toBe(false);
  });

  it('refuses a head whose reading facts changed, as when the Reel was cut again at another length', () => {
    expect(certificateValidOnHead(reelCertificate(), reelHead({ mapping: { readingFactsSha256: hash('d') } }))).toBe(
      false,
    );
  });
});
