#!/usr/bin/env node
// SQL inventory for the backend refactor (issue #196).
//
// Tests observe live SQL text in pg_stat_activity, so SQL text must stay
// byte-identical across the refactor. This tool inventories every SQL string
// in the backend, compares two inventories as multisets (code may move,
// text may not) and checks that every LIKE pattern the tests use still
// matches exactly the same texts.
//
// Usage (from the repo root):
//   node scripts/refactor/sql-inventory.mjs snapshot --out s.json [--roots dir...]
//   node scripts/refactor/sql-inventory.mjs compare old.json new.json
//       [--normalize-files path-or-glob...] [--normalize whitespace|whitespace+keyword-case]
//   node scripts/refactor/sql-inventory.mjs observed s.json [s2.json]
//   node scripts/refactor/sql-inventory.mjs --self-test
//
// Default roots: apps/api/src apps/worker/src packages (.ts, no node_modules).
//
// Entry categories:
//   query        first argument of every `x.query(...)` call. kind: literal
//                (cooked text), template (cooked text with ${expr}
//                placeholders), const (identifier resolved through the type
//                checker to a const string/template), dynamic (source text).
//   sql-literal  any other string/template literal that looks like SQL by the
//                prefix/content rules below. Prose false positives are fine:
//                they are compared exactly too.
//
// `compare` ignores file and line, and treats literal and const as one kind
// group (lifting an inline literal into a constant sends PostgreSQL the same
// text). `--normalize-files` lets listed new files differ by whitespace (and
// optionally keyword case); those differences are reported separately and are
// the only ones that do not fail the comparison.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
);
const DEFAULT_ROOTS = ['apps/api/src', 'apps/worker/src', 'packages'];
const SK = ts.SyntaxKind;

const LEADING_KEYWORDS = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'LOCK',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'SET',
  'VALUES',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'JOIN',
  'LEFT',
  'ORDER\\s+BY',
  'GROUP\\s+BY',
  'ON\\s+CONFLICT',
  'RETURNING',
];
const LEADING = new RegExp(
  `^\\s*(?:${LEADING_KEYWORDS.join('|')})(?:\\s|$)`,
  'i',
);

function looksLikeSql(text) {
  if (LEADING.test(text)) return true;
  if (text.includes('SELECT') && text.includes('FROM')) return true;
  if (text.includes('INSERT INTO') || text.includes('DELETE FROM')) return true;
  const update = text.indexOf('UPDATE');
  return update >= 0 && text.indexOf(' SET ', update) >= 0;
}

// ---------------------------------------------------------------- scanning

function die(message) {
  console.error(message);
  process.exit(2);
}

function* walkFiles(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      yield full;
    }
  }
}

function collectFiles(roots) {
  const files = new Set();
  for (const root of roots) {
    const absolute = path.resolve(root);
    if (!fs.existsSync(absolute)) continue;
    if (fs.statSync(absolute).isFile()) files.add(fs.realpathSync(absolute));
    else
      for (const file of walkFiles(absolute)) files.add(fs.realpathSync(file));
  }
  return [...files].sort();
}

function loadCompilerOptions() {
  const configPath = path.join(REPO_ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) die('cannot read tsconfig.json');
  return ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT).options;
}

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

function unwrap(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Returns {kind, text} when the node is a string/template literal, else null. */
function literalText(sf, node) {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return { kind: 'literal', text: inner.text };
  }
  if (ts.isTemplateExpression(inner)) {
    let text = inner.head.text;
    for (const span of inner.templateSpans) {
      text += `\${${collapse(span.expression.getText(sf))}}${span.literal.text}`;
    }
    return { kind: 'template', text };
  }
  return null;
}

function resolveConst(checker, sf, identifier) {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return null;
    }
  }
  for (const declaration of symbol?.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      declaration.parent.flags & ts.NodeFlags.Const
    ) {
      const resolved = literalText(
        declaration.getSourceFile(),
        declaration.initializer,
      );
      if (resolved) return resolved;
    }
  }
  return null;
}

function enclosingName(node) {
  let outermostVariable = null;
  for (let current = node.parent; current; current = current.parent) {
    switch (current.kind) {
      case SK.FunctionDeclaration:
      case SK.MethodDeclaration:
      case SK.GetAccessor:
      case SK.SetAccessor:
        if (current.name) return current.name.getText();
        break;
      case SK.Constructor:
        return 'constructor';
      case SK.FunctionExpression:
      case SK.ArrowFunction: {
        if (current.kind === SK.FunctionExpression && current.name) {
          return current.name.text;
        }
        const owner = current.parent;
        if (
          (ts.isVariableDeclaration(owner) ||
            ts.isPropertyAssignment(owner) ||
            ts.isPropertyDeclaration(owner)) &&
          owner.name &&
          owner.initializer === current
        ) {
          return owner.name.getText();
        }
        break;
      }
      case SK.VariableDeclaration:
        if (ts.isIdentifier(current.name))
          outermostVariable = current.name.text;
        break;
      default:
    }
  }
  return outermostVariable ?? '<module>';
}

function inventory(roots) {
  const files = collectFiles(roots);
  const program = ts.createProgram(files, {
    ...loadCompilerOptions(),
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const wanted = new Set(files);
  const entries = [];

  for (const sf of program.getSourceFiles()) {
    const real = fs.existsSync(sf.fileName)
      ? fs.realpathSync(sf.fileName)
      : sf.fileName;
    if (!wanted.has(real)) continue;
    const file = path.relative(REPO_ROOT, real).split(path.sep).join('/');
    const consumed = new Set();
    const add = (category, kind, text, node) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      entries.push({
        category,
        kind,
        text,
        file,
        line: line + 1,
        function: enclosingName(node),
      });
    };

    // Query calls first, so their literal arguments are not counted twice.
    const visitQueries = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'query' &&
        node.arguments.length > 0
      ) {
        const argument = node.arguments[0];
        const literal = literalText(sf, argument);
        if (literal) {
          consumed.add(unwrap(argument));
          add('query', literal.kind, literal.text, argument);
        } else {
          const inner = unwrap(argument);
          const constant = ts.isIdentifier(inner)
            ? resolveConst(checker, sf, inner)
            : null;
          if (constant) add('query', 'const', constant.text, argument);
          else
            add('query', 'dynamic', collapse(argument.getText(sf)), argument);
        }
      }
      ts.forEachChild(node, visitQueries);
    };
    visitQueries(sf);

    const visitLiterals = (node) => {
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateExpression(node)) &&
        !consumed.has(node)
      ) {
        const literal = literalText(sf, node);
        if (literal && looksLikeSql(literal.text)) {
          add('sql-literal', literal.kind, literal.text, node);
        }
      }
      ts.forEachChild(node, visitLiterals);
    };
    visitLiterals(sf);
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  entries.sort(
    (a, b) =>
      cmp(a.category, b.category) ||
      cmp(a.text, b.text) ||
      cmp(a.file, b.file) ||
      a.line - b.line,
  );
  return entries;
}

// -------------------------------------------------------------- comparison

const kindGroup = (kind) =>
  kind === 'literal' || kind === 'const' ? 'static' : kind;

function normalizeText(text, mode) {
  const spaced = collapse(text);
  if (mode !== 'whitespace+keyword-case') return spaced;
  let out = '';
  for (let i = 0; i < spaced.length; ) {
    const ch = spaced[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < spaced.length) {
        if (spaced[j] === ch) {
          if (spaced[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      out += spaced.slice(i, j + 1);
      i = j + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < spaced.length && /[A-Za-z0-9_]/.test(spaced[j])) j++;
      out += spaced.slice(i, j).toUpperCase();
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const keyOf = (entry, text = entry.text) =>
  JSON.stringify([entry.category, kindGroup(entry.kind), text]);

function globToRegExp(pattern) {
  if (pattern.endsWith('/')) return new RegExp(`^${escapeRegExp(pattern)}`);
  const source = pattern
    .split('**')
    .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

function escapeRegExp(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function describe(entry) {
  const text =
    entry.text.length > 110 ? `${entry.text.slice(0, 107)}...` : entry.text;
  return `${entry.file}:${entry.line} (${entry.function}) [${entry.category}/${entry.kind}] ${JSON.stringify(text)}`;
}

function groupByKey(entries, keyFn) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyFn(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

function compareInventories(oldEntries, newEntries, options = {}) {
  const normalizeMode = options.normalize ?? 'whitespace';
  const normalizers = (options.normalizeFiles ?? []).map(globToRegExp);
  const inNormalizedFile = (entry) =>
    normalizers.some((re) => re.test(entry.file));

  const oldGroups = groupByKey(oldEntries, (e) => keyOf(e));
  const newGroups = groupByKey(newEntries, (e) => keyOf(e));

  const oldResidue = [];
  const newResidue = [];
  const moved = [];
  for (const key of new Set([...oldGroups.keys(), ...newGroups.keys()])) {
    const o = oldGroups.get(key) ?? [];
    const n = newGroups.get(key) ?? [];
    const common = Math.min(o.length, n.length);
    if (o.length > common) oldResidue.push(...o.slice(common));
    if (n.length > common) newResidue.push(...n.slice(common));
    if (common) {
      const oldFiles = new Map();
      for (const e of o) oldFiles.set(e.file, (oldFiles.get(e.file) ?? 0) + 1);
      const gone = [];
      for (const e of n) {
        const left = oldFiles.get(e.file) ?? 0;
        if (left > 0) oldFiles.set(e.file, left - 1);
        else gone.push(e.file);
      }
      const away = [...oldFiles]
        .filter(([, count]) => count > 0)
        .map(([f]) => f);
      if (away.length || gone.length) {
        moved.push({ text: o[0].text, from: away, to: [...new Set(gone)] });
      }
    }
  }

  const available = groupByKey(oldResidue, (e) =>
    keyOf(e, normalizeText(e.text, normalizeMode)),
  );
  const explained = [];
  const unexplainedNew = [];
  for (const entry of newResidue) {
    if (inNormalizedFile(entry)) {
      const pool = available.get(
        keyOf(entry, normalizeText(entry.text, normalizeMode)),
      );
      if (pool?.length) {
        explained.push({ old: pool.pop(), new: entry });
        continue;
      }
    }
    unexplainedNew.push(entry);
  }
  const unexplainedOld = [...available.values()].flat();
  return { unexplainedOld, unexplainedNew, explained, moved };
}

function counts(entries) {
  const table = {};
  for (const entry of entries) {
    const key = `${entry.category}/${entry.kind}`;
    table[key] = (table[key] ?? 0) + 1;
  }
  return table;
}

// -------------------------------------------------------------------- LIKE

function likeToRegExp(pattern, insensitive) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length)
      source += escapeRegExp(pattern[++i]);
    else if (ch === '%') source += '[\\s\\S]*';
    else if (ch === '_') source += '[\\s\\S]';
    else source += escapeRegExp(ch);
  }
  return new RegExp(`^${source}$`, insensitive ? 'i' : '');
}

function observedPatterns() {
  const patterns = [];
  for (const file of collectFiles([path.join(REPO_ROOT, 'tests')])) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('pg_stat_activity')) continue;
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)
      ) {
        const literal = literalText(sf, node);
        if (literal?.text.includes('pg_stat_activity')) {
          for (const match of literal.text.matchAll(
            /query\s+(I?LIKE)\s+'((?:[^']|'')*)'/gi,
          )) {
            patterns.push({
              operator: match[1].toUpperCase(),
              pattern: match[2].replace(/''/g, "'"),
              file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
            });
          }
        }
        if (!ts.isTemplateExpression(node)) return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return patterns;
}

function matchesFor(patterns, entries) {
  return patterns.map((p) => {
    const re = likeToRegExp(p.pattern, p.operator === 'ILIKE');
    return { ...p, matches: entries.filter((e) => re.test(e.text)) };
  });
}

// ---------------------------------------------------------------- commands

function parseArgs(argv) {
  const flags = { positional: [], roots: null, normalizeFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--normalize') flags.normalize = argv[++i];
    else if (arg === '--roots' || arg === '--normalize-files') {
      const list = [];
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) list.push(argv[++i]);
      if (arg === '--roots') flags.roots = list;
      else flags.normalizeFiles.push(...list);
    } else if (arg.startsWith('--')) die(`unknown option ${arg}`);
    else flags.positional.push(arg);
  }
  if (
    flags.normalize &&
    flags.normalize !== 'whitespace' &&
    flags.normalize !== 'whitespace+keyword-case'
  ) {
    die('--normalize must be whitespace or whitespace+keyword-case');
  }
  return flags;
}

const readSnapshot = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function cmdSnapshot(flags) {
  if (!flags.out) die('snapshot needs --out <file.json>');
  const roots = flags.roots ?? DEFAULT_ROOTS;
  const entries = inventory(roots);
  fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
  fs.writeFileSync(
    flags.out,
    `${JSON.stringify({ meta: { roots }, entries }, null, 2)}\n`,
  );
  console.log(`${entries.length} entries -> ${flags.out}`);
  for (const [key, count] of Object.entries(counts(entries)).sort()) {
    console.log(`  ${key}: ${count}`);
  }
}

function cmdCompare(flags) {
  const [oldPath, newPath] = flags.positional;
  if (!oldPath || !newPath) die('compare needs <old.json> <new.json>');
  const result = compareInventories(
    readSnapshot(oldPath).entries,
    readSnapshot(newPath).entries,
    flags,
  );
  const print = (title, list) => {
    console.log(`${title}:${list.length ? '' : ' (none)'}`);
    for (const line of list) console.log(`  ${line}`);
  };
  print('only in old', result.unexplainedOld.map(describe));
  print('only in new', result.unexplainedNew.map(describe));
  print(
    'normalization-only differences (exact text differs, normalized text equal)',
    result.explained.flatMap(({ old, new: entry }) => [
      `old ${describe(old)}`,
      `new ${describe(entry)}`,
    ]),
  );
  print(
    'moved (information only)',
    result.moved.map(
      (m) =>
        `${JSON.stringify(m.text.slice(0, 80))}: ${m.from.join(',') || '-'} -> ${m.to.join(',') || '-'}`,
    ),
  );
  console.log(
    `summary: ${result.unexplainedOld.length} only-old, ${result.unexplainedNew.length} only-new, ${result.explained.length} normalization-only, ${result.moved.length} moved`,
  );
  process.exit(
    result.unexplainedOld.length || result.unexplainedNew.length ? 1 : 0,
  );
}

function cmdObserved(flags) {
  const [first, second] = flags.positional;
  if (!first) die('observed needs <snapshot.json> [<snapshot2.json>]');
  const patterns = observedPatterns();
  console.log(`${patterns.length} observed patterns in tests/`);
  const a = matchesFor(patterns, readSnapshot(first).entries);
  const b = second ? matchesFor(patterns, readSnapshot(second).entries) : null;
  let bad = 0;
  a.forEach((p, i) => {
    console.log(`\n${p.operator} ${JSON.stringify(p.pattern)}  (${p.file})`);
    console.log(`  ${p.matches.length} match(es) in ${first}`);
    for (const entry of p.matches) console.log(`    ${describe(entry)}`);
    if (b) {
      const texts = (list) => list.map((e) => `${e.category}|${e.text}`).sort();
      const left = texts(p.matches);
      const right = texts(b[i].matches);
      const same =
        left.length === right.length && left.every((t, k) => t === right[k]);
      console.log(
        `  ${b[i].matches.length} match(es) in ${second}: ${same ? 'SAME' : 'DIFFERENT'}`,
      );
      if (!same) {
        bad++;
        for (const entry of b[i].matches) console.log(`    ${describe(entry)}`);
      }
    }
  });
  if (b) console.log(`\nsummary: ${bad} pattern(s) with changed matches`);
  process.exit(bad ? 1 : 0);
}

// --------------------------------------------------------------- self-test

function selfTest() {
  let failures = 0;
  const check = (ok, message) => {
    if (!ok) {
      failures++;
      console.error(`FAIL: ${message}`);
    } else console.log(`ok: ${message}`);
  };
  const entry = (text, over = {}) => ({
    category: 'query',
    kind: 'literal',
    text,
    file: 'a.ts',
    line: 1,
    function: 'f',
    ...over,
  });

  check(
    looksLikeSql('  select 1'),
    'sql-like: leading keyword, case-insensitive',
  );
  check(looksLikeSql('ORDER   BY id'), 'sql-like: ORDER BY with spaces');
  check(!looksLikeSql('hello world'), 'sql-like: prose rejected');
  check(looksLikeSql('x SELECT y FROM z'), 'sql-like: SELECT and FROM inside');
  check(looksLikeSql('x UPDATE t SET a=1'), 'sql-like: UPDATE ... SET');
  check(
    !looksLikeSql('x SET UPDATE t'),
    'sql-like: SET before UPDATE rejected',
  );

  const same = compareInventories(
    [entry('SELECT 1')],
    [entry('SELECT 1', { file: 'b.ts' })],
  );
  check(
    !same.unexplainedOld.length && !same.unexplainedNew.length,
    'compare: file move is allowed',
  );
  check(same.moved.length === 1, 'compare: move reported as information');

  const group = compareInventories(
    [entry('SELECT 1')],
    [entry('SELECT 1', { kind: 'const' })],
  );
  check(
    !group.unexplainedOld.length && !group.unexplainedNew.length,
    'compare: literal and const are one group',
  );

  const dup = compareInventories(
    [entry('SELECT 1'), entry('SELECT 1')],
    [entry('SELECT 1')],
  );
  check(dup.unexplainedOld.length === 1, 'compare: multiset counts duplicates');

  const space = compareInventories([entry('SELECT  1')], [entry('SELECT 1')]);
  check(
    space.unexplainedOld.length === 1 && space.unexplainedNew.length === 1,
    'compare: whitespace change fails by default',
  );

  const normalized = compareInventories(
    [entry('SELECT  1')],
    [entry('SELECT 1')],
    {
      normalizeFiles: ['a.ts'],
    },
  );
  check(
    !normalized.unexplainedOld.length &&
      !normalized.unexplainedNew.length &&
      normalized.explained.length === 1,
    'compare: --normalize-files explains whitespace-only change',
  );
  const elsewhere = compareInventories(
    [entry('SELECT  1')],
    [entry('SELECT 1')],
    {
      normalizeFiles: ['other.ts'],
    },
  );
  check(
    elsewhere.unexplainedNew.length === 1,
    'compare: normalization applies only to listed new files',
  );
  const keyword = compareInventories(
    [entry("select 'a b'")],
    [entry("SELECT 'a b'")],
    {
      normalizeFiles: ['*.ts'],
      normalize: 'whitespace+keyword-case',
    },
  );
  check(keyword.explained.length === 1, 'compare: keyword case normalized');
  const quoted = compareInventories(
    [entry("select 'a b'")],
    [entry("SELECT 'A b'")],
    {
      normalizeFiles: ['*.ts'],
      normalize: 'whitespace+keyword-case',
    },
  );
  check(
    quoted.unexplainedNew.length === 1,
    'compare: case inside quoted strings is not normalized',
  );
  const both = compareInventories([entry('SELECT x')], [entry('SELECT y')], {
    normalizeFiles: ['a.ts'],
  });
  check(
    both.unexplainedOld.length === 1 && both.unexplainedNew.length === 1,
    'compare: real text change fails',
  );

  check(
    likeToRegExp('%FROM asset%', false).test('SELECT 1 FROM asset a'),
    'LIKE: % matches runs',
  );
  check(
    !likeToRegExp('%FROM asset%', false).test('select 1 from asset'),
    'LIKE: case-sensitive',
  );
  check(
    likeToRegExp('%FROM asset%', true).test('select 1 from asset'),
    'ILIKE: case-insensitive',
  );
  check(
    likeToRegExp('a_c', false).test('abc') &&
      !likeToRegExp('a_c', false).test('abbc'),
    'LIKE: _ matches one char',
  );
  check(
    !likeToRegExp('FROM', false).test('SELECT FROM'),
    'LIKE: match is against the whole text',
  );

  const dir = fs.mkdtempSync(
    path.join(REPO_ROOT, 'node_modules', '.sql-inventory-'),
  );
  try {
    const file = path.join(dir, 'sample.ts');
    fs.writeFileSync(
      file,
      [
        "const GET = 'SELECT id FROM t WHERE a=$1';",
        'function run(client: any, name: string, dynamic: string) {',
        "  client.query('SELECT 1');",
        '  client.query(`SELECT ${name}  FROM x`);',
        '  client.query(GET, [1]);',
        '  client?.query<number>(dynamic);',
        "  const other = 'DELETE FROM u';",
        '  return client.query(`WITH a AS (SELECT 1) SELECT * FROM a`);',
        '}',
      ].join('\n'),
    );
    const found = inventory([dir]);
    const row = (category, kind, text) =>
      found.some(
        (e) => e.category === category && e.kind === kind && e.text === text,
      );
    check(
      row('query', 'literal', 'SELECT 1'),
      'inventory: string literal query',
    );
    check(
      row('query', 'template', 'SELECT ${name}  FROM x'),
      'inventory: template query with placeholder',
    );
    check(
      row('query', 'const', 'SELECT id FROM t WHERE a=$1'),
      'inventory: const resolved through checker',
    );
    check(
      row('query', 'dynamic', 'dynamic'),
      'inventory: dynamic identifier, optional call with type args',
    );
    check(
      row('query', 'literal', 'WITH a AS (SELECT 1) SELECT * FROM a'),
      'inventory: no-substitution template query',
    );
    check(
      row('sql-literal', 'literal', 'DELETE FROM u'),
      'inventory: bare sql literal',
    );
    check(
      row('sql-literal', 'literal', 'SELECT id FROM t WHERE a=$1'),
      'inventory: const declaration literal is also listed',
    );
    check(
      !found.some((e) => e.category === 'sql-literal' && e.text === 'SELECT 1'),
      'inventory: query argument not double counted',
    );
    check(
      found.find((e) => e.text === 'SELECT 1')?.function === 'run',
      'inventory: enclosing function name',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`${failures} self-test failure(s)`);
    process.exit(1);
  }
  console.log('self-test passed');
}

// -------------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2);
if (command === '--self-test') selfTest();
else {
  const flags = parseArgs(rest);
  if (command === 'snapshot') cmdSnapshot(flags);
  else if (command === 'compare') cmdCompare(flags);
  else if (command === 'observed') cmdObserved(flags);
  else {
    die(
      'usage: sql-inventory.mjs snapshot|compare|observed|--self-test (see file header)',
    );
  }
}
