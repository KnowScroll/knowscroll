import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headings, decisionExcerpt, readingPaths, section } from './lookup.mjs';

test('a decision includes a later addendum even with other decisions between them', () => {
  const source =
    '## D-001 · 2026-01-01 · First\nOriginal\n## D-002 · 2026-01-02 · Other\nOther text\n## D-001 · addendum · 2026-01-03 · Update\nNew ruling';
  const result = decisionExcerpt(source, headings(source), 'D-001');
  assert.match(result, /Original/);
  assert.match(result, /New ruling/);
  assert.doesNotMatch(result, /Other text/);
});

test('an issue can point to a tracked file or owning directory but not escape the checkout', () => {
  const files = new Set(['apps/foo.ts', 'packages/core/README.md']);
  assert.deepEqual(
    readingPaths(
      '[apps/foo.ts](https://example.org) and \x60packages/core/\x60, \x60../../elsewhere\x60 or \x60apps/removed.ts\x60',
      files,
    ),
    [...files],
  );
});

test('reads acceptance from CRLF issue Markdown without consuming later sections', () => {
  assert.equal(
    section('# Task\r\n## Acceptance criteria\r\n- [ ] visible\r\n## Evidence\r\nPrivate', /acceptance/i),
    '- [ ] visible',
  );
});

test('Expo route punctuation and percent-encoded, pinned link targets survive lookup', () => {
  const paths = [
    'apps/client/app/(tabs)/universe.tsx',
    'apps/client/app/conversations/[conversationId].tsx',
    'apps/client/app/+not-found.tsx',
  ];
  const url =
    'https://github.com/KnowScroll/knowscroll/blob/' +
    'a'.repeat(40) +
    '/' +
    paths[1].replace('[', '%5B').replace(']', '%5D');
  const brief = '\x60' + paths[0] + '\x60 [thread](' + url + '#L12) and ' + paths[2];
  assert.deepEqual(readingPaths(brief, new Set(paths)), paths);
});
