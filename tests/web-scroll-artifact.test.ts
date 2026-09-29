import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createCheckedScrollWebArtifact, validateScrollWebArtifact } from '../packages/core/src/scrolls/web-artifact.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const assetId = randomUUID();
const body = 'The accepted beat remains readable.';
const base = () => createCheckedScrollWebArtifact({ assetId, revision: 1, title: 'A checked Scroll', beats: [body], body });

test('the declarative artifact is bound to the accepted Scroll, revision, body and exact bytes', () => {
  const artifact = base();
  assert.deepEqual(validateScrollWebArtifact(artifact, { assetId, revision: 1, body }), artifact);
  const reorder = (value: unknown): unknown => Array.isArray(value)
    ? value.map(reorder)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, reorder(member)]))
      : value;
  assert.deepEqual(validateScrollWebArtifact(reorder(artifact), { assetId, revision: 1, body }), artifact,
    'JSONB object key reordering preserves the checked integrity digest');
  assert.equal(validateScrollWebArtifact(artifact, { assetId: randomUUID(), revision: 1, body }), null);
  assert.equal(validateScrollWebArtifact(artifact, { assetId, revision: 2, body }), null);
  assert.equal(validateScrollWebArtifact(artifact, { assetId, revision: 1, body: 'edited' }), null);
  assert.equal(validateScrollWebArtifact({ ...artifact, integritySha256: '0'.repeat(64) }, { assetId, revision: 1, body }), null);
});

test('unsupported versions, active content, unbound diagrams and oversized payloads are refused', () => {
  const artifact = base();
  const check = (value: unknown) => validateScrollWebArtifact(value, { assetId, revision: 1, body });
  assert.equal(check({ ...artifact, schemaVersion: 2 }), null);
  assert.equal(check({ ...artifact, blocks: [{ type: 'html', html: '<script>fetch("https://evil.test")</script>' }] }), null);
  assert.equal(check({ ...artifact, blocks: [{ type: 'text', paragraphs: ['x'], onload: 'fetch("https://evil.test")' }] }), null);
  assert.equal(check({ ...artifact, blocks: [{ type: 'text', paragraphs: ['x'.repeat(66_000)] }] }), null);
  const { integritySha256: _ignored, ...unsigned } = artifact;
  const invalidDiagram = { ...unsigned, blocks: [{ type: 'diagram', title: 'Map', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'missing' }] }] };
  assert.equal(check({ ...invalidDiagram, integritySha256: digest(JSON.stringify(invalidDiagram)) }), null);
});
