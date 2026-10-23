/**
 * #228 review M1: the weekly restore check must never run SQL from a dump or a catalog as the
 * Postgres superuser, and never paste a value it read into SQL. These scripts need a real server
 * to run, so this test holds them to those rules by reading them (and bash -n checks they parse).
 *
 *   node --test ops/vps/backup/scripts.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const restoreCheck = readFileSync(new URL('./ks-restore-check.sh', import.meta.url), 'utf8');
const backup = readFileSync(new URL('./ks-backup.sh', import.meta.url), 'utf8');
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

test('both scripts parse', () => {
  for (const name of ['ks-restore-check.sh', 'ks-backup.sh']) {
    const result = spawnSync('bash', ['-n', fileURLToPath(new URL(`./${name}`, import.meta.url))]);
    assert.equal(result.status, 0, `${name}: ${String(result.stderr)}`);
  }
});

test('M1: the restore and every query in the scratch database run as ks_restore_check', () => {
  const body = code(restoreCheck);
  assert.match(body, /^restorer=ks_restore_check$/m);
  for (const line of body.split('\n').filter((l) => /pg_restore\b.*--dbname/.test(l)))
    assert.match(line, /as_restorer pg_restore/, line);
  assert.match(body, /^query\(\) \{ as_restorer psql /m);
  assert.doesNotMatch(body, /as_postgres pg_restore/);
  assert.doesNotMatch(body, /as_postgres psql[^\n]*-d "\$scratch_db"/);
  assert.doesNotMatch(body, /--role=/, 'SET ROLE from a superuser session can be undone by the dump');
});

test('M1: postgres runs only fixed statements naming the script\'s own constants', () => {
  const body = code(restoreCheck);
  const superuserLines = body.split('\n').filter((l) => /as_postgres|^\s+-c "/.test(l));
  assert.ok(superuserLines.length > 0);
  for (const line of superuserLines) {
    const variables = [...line.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    for (const variable of variables)
      assert.ok(
        ['scratch_db', 'restorer', '@'].includes(variable as string),
        `${variable} reaches a superuser command: ${line.trim()}`,
      );
  }
  assert.match(body, /CREATE DATABASE \$scratch_db OWNER \$restorer ALLOW_CONNECTIONS false/);
  assert.match(body, /REVOKE ALL ON DATABASE \$scratch_db FROM PUBLIC/);
});

test('M1: no value read from a dump or a catalog is pasted into SQL', () => {
  const body = code(restoreCheck);
  // Queries come on stdin (heredocs), never as -c strings with variables in them.
  for (const line of body.split('\n').filter((l) => /\bquery\b/.test(l) && /-c /.test(l)))
    assert.fail(`a query passed with -c: ${line.trim()}`);
  // The catalog-derived schema goes in only as a psql identifier variable, after a name check.
  assert.match(body, /:"schema"\.:"table"/);
  assert.match(body, /\[\[ "\$schema" =~ \$plain_name \]\]/);
  assert.match(body, /^plain_name='\^\[a-z_\]\[a-z0-9_\]\*\$'$/m);
  assert.doesNotMatch(body, /FROM \\?"\$schema/);
  assert.doesNotMatch(body, /'\$migration_table'/);
});

test('the nightly backup holds the deploy lock while it dumps and ages pre-deploy dumps too', () => {
  const body = code(backup);
  assert.match(body, /exec 8>>\/run\/knowscroll\/deploy\.lock/);
  assert.match(body, /flock --timeout 1800 8/);
  assert.match(body, /pre-deploy-\*\.dump/);
  assert.match(body, /"\$name" != "\$newest_pre"/, 'the newest pre-deploy dump is never deleted');
});
