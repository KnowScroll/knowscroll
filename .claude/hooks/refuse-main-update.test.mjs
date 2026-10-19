// Run with `node --test .claude/hooks/`. CI runs it on every push (checks.yml).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refusalFor } from './refuse-main-update.mjs';

const onFeature = { currentBranch: 'codex/12-foundation', prBase: 'codex/release-knowscroll-v2' };

const refused = [
  'git push origin main',
  'git push origin HEAD:main',
  'git push origin "main"',
  "git push origin 'refs/heads/main'",
  'git -C "/Volumes/Mrigesh SSD/x" push origin main',
  'git push --force origin dev:main',
  'git push --all origin',
  'git push --mirror origin',
  'git update-ref refs/heads/main abc',
  'scripts/promote.sh live',
  'bash scripts/promote.sh "live"',
  'gh api repos/KnowScroll/knowscroll/merges -f base=main -f head=dev',
  'gh repo sync KnowScroll/knowscroll --branch main',
];

const allowed = [
  'git push -u origin codex/release-knowscroll-v2',
  'git push origin codex/12-foundation',
  'git push origin dev',
  'scripts/promote.sh stage',
  'git fetch origin main',
  'git log origin/main --oneline',
  'git show origin/main:README.md',
  'gh pr create --base main --head dev --title "v2 release candidate"',
  'gh pr view 42',
  'git push origin maintenance-notes',
];

for (const command of refused) {
  test(`refuses: ${command}`, () => {
    assert.notEqual(refusalFor(command, onFeature), null);
  });
}

for (const command of allowed) {
  test(`allows: ${command}`, () => {
    assert.equal(refusalFor(command, onFeature), null);
  });
}

test('refuses a bare push from a main checkout but not from a feature branch', () => {
  assert.notEqual(refusalFor('git push', { currentBranch: 'main' }), null);
  assert.equal(refusalFor('git push', { currentBranch: 'codex/12-foundation' }), null);
});

test('refuses gh pr merge into main only', () => {
  assert.notEqual(refusalFor('gh pr merge 42 --squash', { prBase: 'main' }), null);
  assert.equal(refusalFor('gh pr merge 42 --squash', { prBase: 'codex/release-knowscroll-v2' }), null);
  assert.equal(refusalFor('gh pr merge 42 --squash', { prBase: 'dev' }), null);
});
