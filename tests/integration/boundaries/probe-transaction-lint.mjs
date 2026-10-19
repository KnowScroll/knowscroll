#!/usr/bin/env node
// `pnpm lint:probe`: proves the ESLint rule against unmarked transactions bites. Writes a module
// adapter that opens transactions and connections in each direct form Kysely allows (a path that
// must not exist yet), lints it with the repository configuration, checks that every form is
// reported by `no-restricted-syntax`, and removes the file again whatever happens. Aliasing
// through other variables is out of the rule's reach by design (the runtime guard covers it).
// Run from the repository root (CI `static` job).
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { ESLint } from 'eslint';

const file = 'packages/backend/src/modules/experience/adapters/zz-probe-transactions.ts';

/** Each probe function and the line on which the rule must report it. */
const probes = [
  ['direct call', 'await db.transaction().execute(async () => undefined);'],
  ['literal bracket access', "await db['transaction']().execute(async () => undefined);"],
  ['destructured method', 'const { transaction } = db;\n  await transaction.call(db).execute(async () => undefined);'],
  ['bound method', 'await db.transaction.bind(db)().execute(async () => undefined);'],
  ['controlled transaction', 'const trx = await db.startTransaction().execute();\n  await trx.commit().execute();'],
  ['single connection', 'await db.connection().execute(async (c) => sql`select 1`.execute(c));'],
];

const source = [
  "import { sql, type Kysely } from 'kysely';",
  "import type { Database } from '../../../infrastructure/postgres/database.js';",
  '',
  ...probes.map(
    ([name, body], index) =>
      `// ${name}\nexport async function probe${index}(db: Kysely<Database>): Promise<void> {\n  ${body}\n}\n`,
  ),
].join('\n');

if (existsSync(file)) {
  console.error(`lint:probe: ${file} already exists; refusing to overwrite it`);
  process.exit(2);
}

let failures = 0;
try {
  writeFileSync(file, source);
  const [result] = await new ESLint().lintFiles([file]);
  const reported = (result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-syntax');
  const lines = source.split('\n');
  probes.forEach(([name], index) => {
    const start = lines.indexOf(`export async function probe${index}(db: Kysely<Database>): Promise<void> {`) + 1;
    const end = lines.indexOf('}', start) + 1;
    const hits = reported.filter((message) => message.line > start && message.line < end + 1);
    if (hits.length === 0) {
      failures += 1;
      console.error(`lint:probe: not reported: ${name}`);
    }
  });
} finally {
  rmSync(file, { force: true });
}

if (failures > 0) process.exit(1);
console.log(`lint:probe: all ${probes.length} unmarked transaction forms reported`);
