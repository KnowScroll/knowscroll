// Architecture rules Biome cannot express. SQL lives only in packages/db (ADR-0048): any
// `.query(` call under apps/ fails, so a route or worker loop calls a db function instead.
// Usage: node scripts/check-architecture.mjs
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const scopes = ['apps/api/src', 'apps/worker/src'];

async function* typeScriptFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* typeScriptFiles(path);
    } else if (entry.name.endsWith('.ts')) yield path;
  }
}

const violations = [];
for (const scope of scopes) {
  for await (const path of typeScriptFiles(join(root, scope))) {
    const file = ts.createSourceFile(
      path,
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'query'
      ) {
        const { line } = file.getLineAndCharacterOfPosition(
          node.getStart(file),
        );
        violations.push(`${relative(root, path)}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
}

if (violations.length) {
  console.error(
    `SQL belongs in packages/db (ADR-0048); move these .query( calls into a db function:\n  ${violations.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(
  `Architecture check passed (${scopes.join(', ')}: no .query( calls).`,
);
