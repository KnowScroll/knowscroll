import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { format } from 'sql-formatter';
import ts from 'typescript';

const mode = process.argv[2];
if (mode !== '--check' && mode !== '--write') {
  console.error('Usage: node scripts/format-query-sql.mjs --check|--write');
  process.exit(2);
}

const roots = ['apps/api', 'packages'];
const minimumLength = 100;
const sqlOptions = {
  language: 'postgresql',
  keywordCase: 'upper',
  tabWidth: 2,
};

// Tests wait for these statements in pg_stat_activity by matching their text with LIKE, so their
// bytes are part of a test: any query matching one is left exactly as written.
const TEXT_OBSERVED_BY_TESTS = [
  // tests/reasoning-ask-context-integration.test.ts: the session row lock while it is blocked.
  'SELECT s.id FROM reasoning_context_job_session%',
  // tests/history-clear.test.ts: the worker's Keep projection (apps/worker/src/project.ts) waiting.
  'UPDATE accounts SET revision=revision+1,%',
  // tests/trace-revisit.test.ts
  '%SELECT id FROM universe%',
  // tests/reasoning-context.test.ts
  '%FROM asset%',
  // tests/reasoning-idle-lifecycle.test.ts
  '%FROM reasoning_bucket%',
  // tests/reasoning-maintenance-adversarial.test.ts
  '%DELETE FROM reasoning_context%',
].map(
  (like) =>
    new RegExp(
      `^${like
        .split('%')
        .map((part) =>
          part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.'),
        )
        .join('[\\s\\S]*')}$`,
    ),
);

function observedByTests(sql) {
  return TEXT_OBSERVED_BY_TESTS.some((pattern) => pattern.test(sql));
}

async function* typeScriptFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* typeScriptFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.ts')) yield path;
  }
}

function formattedQueries(path, source) {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edits = [];

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'query'
    ) {
      const query = node.arguments[0];
      if (
        query &&
        (ts.isStringLiteral(query) || ts.isNoSubstitutionTemplateLiteral(query))
      ) {
        const sql = query.text;
        // Small statements stay inline. Dynamic templates and SQL with comments or escape syntax
        // need a human review, so this tool deliberately does not rewrite them. A statement whose
        // text a test observes is never rewritten.
        if (
          !observedByTests(sql) &&
          sql.length >= minimumLength &&
          !/\$\{|`|\\|--|\/\*|\$\$/.test(sql)
        ) {
          const start = query.getStart(file);
          const lineStart = source.lastIndexOf('\n', start - 1) + 1;
          const indent = /^\s*/.exec(source.slice(lineStart, start))[0];
          const formatted = format(sql.trim(), sqlOptions).trim();
          const replacement = `\`\n${formatted
            .split('\n')
            .map((line) => `${indent}  ${line}`)
            .join('\n')}\n${indent}\``;
          const nonemptyLines = sql.split('\n').filter((line) => line.trim());
          const commonIndent = Math.min(
            ...nonemptyLines.map((line) => /^\s*/.exec(line)[0].length),
          );
          const currentLayout = nonemptyLines
            .map((line) => line.slice(commonIndent))
            .join('\n');
          if (currentLayout !== formatted) {
            edits.push({
              start,
              end: query.end,
              replacement,
              line: file.getLineAndCharacterOfPosition(start).line + 1,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return edits;
}

let changedFiles = 0;
let changedQueries = 0;
for (const root of roots) {
  for await (const path of typeScriptFiles(root)) {
    const source = await readFile(path, 'utf8');
    const edits = formattedQueries(path, source);
    if (edits.length === 0) continue;
    changedFiles += 1;
    changedQueries += edits.length;
    if (mode === '--write') {
      let output = source;
      for (const edit of edits.reverse()) {
        output =
          output.slice(0, edit.start) +
          edit.replacement +
          output.slice(edit.end);
      }
      await writeFile(path, output);
    } else {
      console.error(
        `${relative('.', path)}: SQL formatting needed at lines ${edits.map((edit) => edit.line).join(', ')}`,
      );
    }
  }
}

console.log(
  `${mode === '--write' ? 'Formatted' : 'Checked'} ${changedQueries} SQL queries in ${changedFiles} files.`,
);
if (mode === '--check' && changedQueries > 0) process.exitCode = 1;
