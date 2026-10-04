#!/usr/bin/env node
/*
 * import-graph: module map, cycle counts and boundary checks (issue #196).
 *
 * Usage (from the repo root):
 *   node scripts/refactor/import-graph.mjs report [--with-tests-scripts] [--with-web]
 *        [--json <out.json>] [--markdown <out.md>]
 *   node scripts/refactor/import-graph.mjs compare <old.json> <new.json>
 *
 * report   Parses apps/api/src, apps/worker/src, packages/*\/src (+ tests, scripts, ops with
 *          --with-tests-scripts; + apps/web/src with --with-web), resolves every specifier
 *          with ts.resolveModuleName + realpath, and prints package-pair edge counts,
 *          strongly connected components (file and folder level, all edges and value-only
 *          edges), boundary violations and unresolved specifiers. Output is deterministic.
 * compare  Exit 1 if the new report has package-level edges or boundary violations the old
 *          one lacked (folder-level new edges are listed but do not fail the run).
 *
 * This module also exports the scanning/resolution helpers used by export-surface.mjs and
 * rewrite-imports.mjs, so the three tools resolve specifiers identically.
 */
import fs from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
);
export const ts = createRequire(path.join(REPO, 'package.json'))('typescript');

/** Package roots, longest first so `apps/web` wins over a hypothetical `apps`. */
export const PACKAGE_ROOTS = [
  'apps/api',
  'apps/worker',
  'apps/web',
  'packages/contracts',
  'packages/core',
  'packages/db',
  'tests',
  'scripts',
  'ops',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.tmp',
  'test-results',
  'playwright-report',
  '.superpowers',
]);

export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function toRel(abs) {
  return path.relative(REPO, abs).split(path.sep).join('/');
}

export function unitOf(rel) {
  for (const root of PACKAGE_ROOTS) {
    if (rel === root || rel.startsWith(`${root}/`)) return unitName(root);
  }
  return 'other';
}

export function rootOf(rel) {
  for (const root of PACKAGE_ROOTS) {
    if (rel === root || rel.startsWith(`${root}/`)) return root;
  }
  return null;
}

function unitName(root) {
  return root.split('/').pop();
}

/** Recursively lists files under `dirRel` with one of `exts`, sorted. */
export function walk(dirRel, exts, out = []) {
  const abs = path.join(REPO, dirRel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => cmp(a.name, b.name));
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = `${dirRel}/${e.name}`;
    if (e.isDirectory()) walk(rel, exts, out);
    else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort(cmp)) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

export function parseArgs(argv, valueFlags, boolFlags) {
  const flags = {};
  const multi = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (boolFlags.includes(name)) flags[name] = true;
      else if (valueFlags.includes(name)) {
        // value flags may take several values (`--roots a b c`) until the next flag
        const vals = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          vals.push(argv[++i]);
        }
        flags[name] = vals.length === 1 ? vals[0] : vals;
        multi[name] = vals;
      } else throw new Error(`unknown flag ${a}`);
    } else positional.push(a);
  }
  return { flags, multi, positional };
}

// ---------------------------------------------------------------- resolution

const optionsCache = new Map();

function compilerOptionsFor(configRel) {
  if (!optionsCache.has(configRel)) {
    const configPath = path.join(REPO, configRel);
    const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      cfg.config,
      ts.sys,
      path.dirname(configPath),
    );
    const options = parsed.options;
    optionsCache.set(configRel, {
      options,
      cache: ts.createModuleResolutionCache(REPO, (x) => x, options),
    });
  }
  return optionsCache.get(configRel);
}

/** Web files resolve with web's own (bundler) tsconfig, everything else with the root one. */
function configFor(rel) {
  return rel.startsWith('apps/web/')
    ? 'apps/web/tsconfig.app.json'
    : 'tsconfig.json';
}

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

export function externalName(spec) {
  if (spec.startsWith('node:')) return spec;
  if (BUILTINS.has(spec.split('/')[0])) return `node:${spec.split('/')[0]}`;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const ASSET_EXT = /\.(css|json|svg|png|jpe?g|gif|webp|ico|woff2?|txt|md)$/;

/**
 * Resolves one specifier. Returns {kind:'file', rel}, {kind:'external', name},
 * {kind:'asset'} or {kind:'unresolved'}.
 */
export function resolveSpecifier(spec, fromRel) {
  const isRelative = spec.startsWith('.') || spec.startsWith('/');
  if (!isRelative) {
    if (spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0])) {
      return { kind: 'external', name: externalName(spec) };
    }
  }
  const { options, cache } = compilerOptionsFor(configFor(fromRel));
  const res = ts.resolveModuleName(
    spec,
    path.join(REPO, fromRel),
    options,
    ts.sys,
    cache,
    undefined,
    ts.ModuleKind.ESNext,
  );
  const resolved = res.resolvedModule?.resolvedFileName;
  if (resolved) {
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {}
    const rel = toRel(real);
    if (!rel.startsWith('..') && !rel.split('/').includes('node_modules')) {
      return { kind: 'file', rel };
    }
    return { kind: 'external', name: externalName(spec) };
  }
  if (!isRelative) {
    // Bare specifier with no types/resolution (e.g. a package without .d.ts)
    return { kind: 'external', name: externalName(spec) };
  }
  const guess = path.resolve(path.dirname(path.join(REPO, fromRel)), spec);
  if (ASSET_EXT.test(spec) && fs.existsSync(guess)) return { kind: 'asset' };
  return { kind: 'unresolved' };
}

// ------------------------------------------------------------------ scanning

function importIsTypeOnly(node) {
  switch (node.kind) {
    case ts.SyntaxKind.ImportDeclaration: {
      const c = node.importClause;
      if (!c) return false;
      if (c.isTypeOnly) return true;
      if (c.name) return false;
      const nb = c.namedBindings;
      return !!(
        nb &&
        ts.isNamedImports(nb) &&
        nb.elements.length > 0 &&
        nb.elements.every((e) => e.isTypeOnly)
      );
    }
    case ts.SyntaxKind.ExportDeclaration: {
      if (node.isTypeOnly) return true;
      const c = node.exportClause;
      return !!(
        c &&
        ts.isNamedExports(c) &&
        c.elements.length > 0 &&
        c.elements.every((e) => e.isTypeOnly)
      );
    }
    case ts.SyntaxKind.ImportEqualsDeclaration:
      return !!node.isTypeOnly;
    default:
      return false;
  }
}

/**
 * Finds every module specifier in a source file. Each hit carries the exact range of the
 * literal's text (quotes excluded) so callers can edit it in place.
 */
export function scanSource(rel, text) {
  const ext = path.extname(rel);
  const kind =
    ext === '.tsx'
      ? ts.ScriptKind.TSX
      : ext === '.mjs' || ext === '.js'
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const specs = [];
  const dynamicNonLiteral = [];
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const addLiteral = (lit, kindName, typeOnly) => {
    const start = lit.getStart(sf);
    specs.push({
      spec: lit.text,
      start: start + 1,
      end: lit.end - 1,
      quote: text[start],
      line: lineOf(start),
      kind: kindName,
      typeOnly,
    });
  };
  const isLit = (n) =>
    n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && isLit(node.moduleSpecifier)) {
        addLiteral(node.moduleSpecifier, 'static', importIsTypeOnly(node));
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isLit(node.moduleReference.expression)
    ) {
      addLiteral(
        node.moduleReference.expression,
        'import-equals',
        importIsTypeOnly(node),
      );
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      if (isLit(arg)) addLiteral(arg, 'dynamic', false);
      else {
        dynamicNonLiteral.push({
          line: lineOf(node.getStart(sf)),
          text: node.getText(sf).split('\n')[0].slice(0, 120),
        });
      }
    } else if (ts.isImportTypeNode(node)) {
      const lit = ts.isLiteralTypeNode(node.argument)
        ? node.argument.literal
        : null;
      if (isLit(lit)) addLiteral(lit, 'import-type', true);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  specs.sort((a, b) => a.start - b.start);
  return { specs, dynamicNonLiteral };
}

// --------------------------------------------------------------------- graph

export function collectFiles({ withTestsScripts, withWeb }) {
  const files = [];
  const ts_ = ['.ts', '.tsx', '.mts'];
  for (const d of ['apps/api/src', 'apps/worker/src']) walk(d, ts_, files);
  for (const p of ['contracts', 'core', 'db']) {
    walk(`packages/${p}/src`, ts_, files);
  }
  if (withTestsScripts)
    for (const d of ['tests', 'scripts', 'ops']) walk(d, ts_, files);
  if (withWeb) walk('apps/web/src', ts_, files);
  return [...new Set(files)].sort(cmp);
}

export function buildGraph(opts) {
  const files = collectFiles(opts);
  const statements = [];
  const unresolved = [];
  const dynamicNonLiteral = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const scan = scanSource(rel, text);
    for (const d of scan.dynamicNonLiteral) {
      dynamicNonLiteral.push({ file: rel, line: d.line, text: d.text });
    }
    for (const s of scan.specs) {
      const r = resolveSpecifier(s.spec, rel);
      if (r.kind === 'asset') continue;
      if (r.kind === 'unresolved') {
        unresolved.push({ file: rel, line: s.line, spec: s.spec });
        continue;
      }
      statements.push({
        from: rel,
        line: s.line,
        spec: s.spec,
        typeOnly: s.typeOnly,
        relative: s.spec.startsWith('.'),
        to: r.kind === 'file' ? r.rel : null,
        ext: r.kind === 'external' ? r.name : null,
      });
    }
  }
  return { files, statements, unresolved, dynamicNonLiteral };
}

/** Tarjan SCC (iterative); returns components with more than one node, sorted. */
export function sccs(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) {
    if (adj.has(a) && adj.has(b)) adj.get(a).push(b);
  }
  for (const list of adj.values()) list.sort(cmp);
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  let counter = 0;
  for (const root of [...nodes].sort(cmp)) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      if (i === 0 && !index.has(v)) {
        index.set(v, counter);
        low.set(v, counter);
        counter++;
        stack.push(v);
        onStack.add(v);
      }
      const succ = adj.get(v);
      if (i < succ.length) {
        frame[1]++;
        const w = succ[i];
        if (!index.has(w)) work.push([w, 0]);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      } else {
        if (low.get(v) === index.get(v)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          if (comp.length > 1) out.push(comp.sort(cmp));
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
      }
    }
  }
  return out.sort((a, b) => cmp(a[0], b[0]));
}

const CORE_BANNED = ['pg', 'fastify', 'ai', 'vercel-minimax-ai-provider'];
const PACKAGE_UNITS = ['contracts', 'core', 'db'];
const APP_UNITS = ['api', 'worker', 'web'];

function violationsOf(st) {
  const fromUnit = unitOf(st.from);
  const toUnit = st.to ? unitOf(st.to) : null;
  const ext = st.ext;
  const rules = [];
  if (PACKAGE_UNITS.includes(fromUnit) && APP_UNITS.includes(toUnit)) {
    rules.push('package-imports-app');
  }
  if (fromUnit === 'core') {
    if (toUnit === 'db') rules.push('core-imports-db');
    if (CORE_BANNED.includes(ext)) rules.push(`core-imports-${ext}`);
  }
  if (fromUnit === 'contracts' && (toUnit === 'core' || toUnit === 'db')) {
    rules.push(`contracts-imports-${toUnit}`);
  }
  if (fromUnit === 'db' && (ext === 'fastify' || ext === 'ai')) {
    rules.push(`db-imports-${ext}`);
  }
  if (fromUnit === 'api') {
    if (ext === 'ai' || ext === 'vercel-minimax-ai-provider') {
      rules.push(`api-imports-${ext}`);
    }
    if (toUnit === 'worker') rules.push('api-imports-worker');
  }
  if (fromUnit === 'worker') {
    if (ext === 'fastify') rules.push('worker-imports-fastify');
    if (toUnit === 'api') rules.push('worker-imports-api');
  }
  if (st.relative && st.to) {
    const fromRoot = rootOf(st.from);
    const toRoot = rootOf(st.to);
    if (fromRoot !== toRoot) {
      const harness = fromUnit === 'tests' || fromUnit === 'scripts';
      if (harness && APP_UNITS.includes(toUnit)) {
        // allowed: tests/scripts import apps by relative path
      } else if (harness && PACKAGE_UNITS.includes(toUnit)) {
        rules.push('relative-into-package');
      } else rules.push('relative-cross-package');
    }
  }
  return rules;
}

const bump = (map, key, typeOnly) => {
  const e = map[key] ?? (map[key] = { type: 0, value: 0 });
  e[typeOnly ? 'type' : 'value']++;
};

export function analyze(opts) {
  const g = buildGraph(opts);
  // Unique (from,to,typeOnly) edges; `statements` counts import statements.
  const edgeMap = new Map();
  const extEdgeMap = new Map();
  const stmtPairs = {};
  for (const st of g.statements) {
    const fromUnit = unitOf(st.from);
    const toKey = st.to ? unitOf(st.to) : `external:${st.ext}`;
    bump(stmtPairs, `${fromUnit}->${toKey}`, st.typeOnly);
    if (st.to) {
      const k = `${st.from}\0${st.to}\0${st.typeOnly}`;
      edgeMap.set(k, (edgeMap.get(k) ?? 0) + 1);
    } else {
      const k = `${st.from}\0${st.ext}\0${st.typeOnly}`;
      extEdgeMap.set(k, (extEdgeMap.get(k) ?? 0) + 1);
    }
  }
  const edges = [...edgeMap.entries()]
    .map(([k, n]) => {
      const [from, to, t] = k.split('\0');
      return { from, to, typeOnly: t === 'true', statements: n };
    })
    .sort(
      (a, b) =>
        cmp(a.from, b.from) || cmp(a.to, b.to) || a.typeOnly - b.typeOnly,
    );

  const pkgPairs = {};
  const pkgFilePairs = {};
  for (const e of edges) {
    const key = `${unitOf(e.from)}->${unitOf(e.to)}`;
    if (unitOf(e.from) === unitOf(e.to)) continue;
    bump(pkgPairs, key, e.typeOnly);
    bump(pkgFilePairs, key, e.typeOnly);
  }
  for (const [k, n] of extEdgeMap) {
    const [from, ext, t] = k.split('\0');
    bump(pkgPairs, `${unitOf(from)}->external:${ext}`, t === 'true');
    void n;
  }
  const dir = (f) => path.posix.dirname(f);
  const folderPairs = {};
  for (const e of edges) {
    if (dir(e.from) === dir(e.to)) continue;
    bump(folderPairs, `${dir(e.from)} -> ${dir(e.to)}`, e.typeOnly);
  }

  const fileNodes = g.files;
  const folderNodes = [...new Set(g.files.map(dir))];
  const fileEdgesAll = edges.map((e) => [e.from, e.to]);
  const fileEdgesValue = edges
    .filter((e) => !e.typeOnly)
    .map((e) => [e.from, e.to]);
  const folderEdges = (list) =>
    list
      .filter(([a, b]) => dir(a) !== dir(b))
      .map(([a, b]) => [dir(a), dir(b)]);
  const cycles = {
    file: {
      all: sccs(fileNodes, fileEdgesAll),
      value: sccs(fileNodes, fileEdgesValue),
    },
    folder: {
      all: sccs(folderNodes, folderEdges(fileEdgesAll)),
      value: sccs(folderNodes, folderEdges(fileEdgesValue)),
    },
  };
  const selfImports = edges.filter((e) => e.from === e.to).map((e) => e.from);
  const countFiles = (list) => list.reduce((n, c) => n + c.length, 0);

  const violations = [];
  for (const st of g.statements) {
    for (const rule of violationsOf(st)) {
      violations.push({
        rule,
        file: st.from,
        line: st.line,
        spec: st.spec,
        target: st.to ?? `external:${st.ext}`,
      });
    }
  }
  violations.sort(
    (a, b) =>
      cmp(a.rule, b.rule) ||
      cmp(a.file, b.file) ||
      a.line - b.line ||
      cmp(a.spec, b.spec),
  );

  return sortKeys({
    version: 1,
    options: {
      withTestsScripts: !!opts.withTestsScripts,
      withWeb: !!opts.withWeb,
    },
    fileCount: g.files.length,
    packagePairs: pkgPairs,
    packageStatements: stmtPairs,
    folderPairs,
    cycles,
    cycleSummary: {
      directSelfImports: selfImports,
      fileSccCount: {
        all: cycles.file.all.length,
        value: cycles.file.value.length,
      },
      filesInFileSccs: {
        all: countFiles(cycles.file.all),
        value: countFiles(cycles.file.value),
      },
      folderSccCount: {
        all: cycles.folder.all.length,
        value: cycles.folder.value.length,
      },
    },
    violations,
    unresolved: g.unresolved.sort(
      (a, b) => cmp(a.file, b.file) || a.line - b.line,
    ),
    dynamicNonLiteral: g.dynamicNonLiteral.sort(
      (a, b) => cmp(a.file, b.file) || a.line - b.line,
    ),
    edges,
  });
}

// -------------------------------------------------------------------- output

function formatText(r) {
  const lines = [];
  lines.push(`files: ${r.fileCount}`);
  lines.push('', 'package-level edges (file-pair edges; value / type):');
  for (const [k, v] of Object.entries(r.packagePairs)) {
    lines.push(`  ${k}: value ${v.value}, type ${v.type}`);
  }
  lines.push('', 'package-level import statements (value / type):');
  for (const [k, v] of Object.entries(r.packageStatements)) {
    lines.push(`  ${k}: value ${v.value}, type ${v.type}`);
  }
  const showSccs = (title, list) => {
    lines.push(`${title}: ${list.length}`);
    for (const c of list) {
      lines.push(`  [${c.length}] ${c.join(', ')}`);
    }
  };
  lines.push('');
  showSccs('file SCCs (all edges)', r.cycles.file.all);
  showSccs('file SCCs (value edges)', r.cycles.file.value);
  showSccs('folder SCCs (all edges)', r.cycles.folder.all);
  showSccs('folder SCCs (value edges)', r.cycles.folder.value);
  lines.push(
    '',
    `files in file-level SCCs: all ${r.cycleSummary.filesInFileSccs.all}, value ${r.cycleSummary.filesInFileSccs.value}`,
    `direct self-imports: ${r.cycleSummary.directSelfImports.length}`,
  );
  lines.push('', `boundary violations: ${r.violations.length}`);
  const byRule = {};
  for (const v of r.violations) (byRule[v.rule] ??= []).push(v);
  for (const [rule, list] of Object.entries(byRule)) {
    lines.push(`  ${rule}: ${list.length}`);
    for (const v of list) lines.push(`    ${v.file}:${v.line} ${v.spec}`);
  }
  lines.push('', `unresolved specifiers: ${r.unresolved.length}`);
  for (const u of r.unresolved) lines.push(`  ${u.file}:${u.line} ${u.spec}`);
  lines.push('', `non-literal dynamic imports: ${r.dynamicNonLiteral.length}`);
  for (const d of r.dynamicNonLiteral) {
    lines.push(`  ${d.file}:${d.line} ${d.text}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatMarkdown(r) {
  const L = [];
  L.push('# Module map', '');
  L.push(`Files parsed: ${r.fileCount}`, '');
  L.push('## Package-level edges', '');
  L.push('| from -> to | value | type |', '| --- | ---: | ---: |');
  for (const [k, v] of Object.entries(r.packagePairs)) {
    L.push(`| ${k} | ${v.value} | ${v.type} |`);
  }
  L.push('', '## Folder-level edges', '');
  const byFrom = {};
  for (const [k, v] of Object.entries(r.folderPairs)) {
    const [from, to] = k.split(' -> ');
    const unit = unitOf(from);
    ((byFrom[unit] ??= {})[from] ??= []).push({ to, ...v });
  }
  for (const [unit, folders] of Object.entries(byFrom)) {
    L.push(`### ${unit}`, '');
    for (const [from, tos] of Object.entries(folders)) {
      L.push(`- \`${from}\``);
      for (const t of tos) {
        L.push(`  - -> \`${t.to}\` (value ${t.value}, type ${t.type})`);
      }
    }
    L.push('');
  }
  L.push('## Cycles', '');
  for (const [level, kinds] of Object.entries(r.cycles)) {
    for (const [kind, list] of Object.entries(kinds)) {
      L.push(`### ${level}-level, ${kind} edges: ${list.length} SCC(s)`, '');
      for (const c of list) {
        L.push(`- ${c.length} nodes: ${c.map((x) => `\`${x}\``).join(', ')}`);
      }
      L.push('');
    }
  }
  L.push('## Boundary violations', '');
  if (r.violations.length === 0) L.push('None.', '');
  const byRule = {};
  for (const v of r.violations) (byRule[v.rule] ??= []).push(v);
  for (const [rule, list] of Object.entries(byRule)) {
    L.push(`### ${rule} (${list.length})`, '');
    for (const v of list)
      L.push(`- \`${v.file}:${v.line}\` imports \`${v.spec}\``);
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

function compareReports(oldR, newR) {
  const out = [];
  let fail = false;
  const keysOf = (r, field) =>
    Object.keys(r[field]).filter((k) => {
      const v = r[field][k];
      return v.value + v.type > 0;
    });
  const newPkg = keysOf(newR, 'packagePairs').filter(
    (k) => !(k in oldR.packagePairs),
  );
  const newFolder = Object.keys(newR.folderPairs).filter(
    (k) => !(k in oldR.folderPairs),
  );
  const vkey = (v) => `${v.rule}|${v.file}|${v.spec}|${v.target}`;
  const oldV = new Set(oldR.violations.map(vkey));
  const newV = newR.violations.filter((v) => !oldV.has(vkey(v)));
  out.push(`new package-level edges: ${newPkg.length}`);
  for (const k of newPkg) out.push(`  ${k}`);
  out.push(`new folder-level edges: ${newFolder.length}`);
  for (const k of newFolder) out.push(`  ${k}`);
  out.push(`new violations: ${newV.length}`);
  for (const v of newV) out.push(`  ${v.rule} ${v.file}:${v.line} ${v.spec}`);
  if (newPkg.length || newV.length) fail = true;
  return { text: `${out.join('\n')}\n`, fail };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'report') {
    const { flags } = parseArgs(
      rest,
      ['json', 'markdown'],
      ['with-tests-scripts', 'with-web'],
    );
    const r = analyze({
      withTestsScripts: !!flags['with-tests-scripts'],
      withWeb: !!flags['with-web'],
    });
    if (flags.json) {
      fs.writeFileSync(flags.json, `${JSON.stringify(r, null, 2)}\n`);
    }
    if (flags.markdown) fs.writeFileSync(flags.markdown, formatMarkdown(r));
    process.stdout.write(formatText(r));
  } else if (cmd === 'compare') {
    const [a, b] = rest;
    if (!a || !b) throw new Error('usage: compare <old.json> <new.json>');
    const res = compareReports(
      JSON.parse(fs.readFileSync(a, 'utf8')),
      JSON.parse(fs.readFileSync(b, 'utf8')),
    );
    process.stdout.write(res.text);
    process.exit(res.fail ? 1 : 0);
  } else {
    process.stderr.write(
      'usage: import-graph.mjs report [--with-tests-scripts] [--with-web] [--json f] [--markdown f] | compare old.json new.json\n',
    );
    process.exit(2);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
}
