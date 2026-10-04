#!/usr/bin/env node
/*
 * rewrite-imports: the codemod behind every file move and the package-specifier switch
 * (issue #196). Edits are TEXT edits at the exact range of each specifier string literal
 * (quote character kept); files are never reprinted, and nothing else is touched.
 *
 * Usage (from the repo root):
 *   node scripts/refactor/rewrite-imports.mjs --mode packages --pkg <contracts|core|db>
 *        [--roots <dir ...>] [--dry-run] [--verbose]
 *   node scripts/refactor/rewrite-imports.mjs --mode moves --map <moves.json>
 *        [--roots <dir ...>] [--dry-run] [--verbose]
 *
 * Default roots: apps/api apps/worker packages tests scripts ops. Covered specifiers: static
 * import/export-from (incl. `import type`), side-effect imports, import('x') with a string or
 * no-substitution-template argument, `typeof import('x')` types, `import x = require('x')`.
 * import() with a non-literal argument is LISTED (file:line), never guessed.
 *
 * Mode packages: specifiers outside packages/<pkg>/ that resolve into packages/<pkg>/src/
 *   become `@knowscroll/<pkg>` (src/index.ts) or `@knowscroll/<pkg>/<path under src, no .ts>`.
 *   Inside packages/<pkg>/ relative `.js` specifiers whose `.ts` sibling exists become `.ts`.
 *   packages/contracts/src/cutroom-v1/** is vendored and is never edited. String literals
 *   naming packages/<pkg>/src/... are LISTED, not edited.
 *
 * Mode moves: moves.json is {"<old repo-relative file>": "<new repo-relative file>"}.
 *   Aborts (nothing written, nothing moved) on a dirty tree, an existing target, or an
 *   untracked source. Then git-mv's every file; rewrites every specifier whose importer or
 *   target moved (relative specifiers recomputed from the importer's new directory,
 *   package-style specifiers get the new subpath, others stay byte-identical); rewrites path
 *   string literals in scripts/tests/ops/apps sources and in *.py / *.sh files; and LISTS
 *   every remaining occurrence of an old path (full, or relative to its src/) in
 *   *.md *.json *.yml *.yaml *.py *.sh *.ts *.mjs for hand editing.
 *   Re-running with the same map after it was applied is a no-op.
 *   Undo a completed run: `git reset --hard` in the tree that was clean when you started.
 *
 * Exit codes: 0 success (also dry-run), 1 abort or unresolved problems that block the run,
 * 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cmp,
  parseArgs,
  REPO,
  resolveSpecifier,
  scanSource,
  toRel,
  ts,
} from './import-graph.mjs';

const DEFAULT_ROOTS = [
  'apps/api',
  'apps/worker',
  'packages',
  'tests',
  'scripts',
  'ops',
];
const SRC_EXT = ['.ts', '.tsx', '.mts', '.mjs', '.js'];
const VENDORED = 'packages/contracts/src/cutroom-v1/';
const WORKSPACE_SPEC = /^@knowscroll\/(contracts|core|db)(?:\/(.+))?$/;
const PKGS = ['contracts', 'core', 'db'];

class Abort extends Error {}

// ------------------------------------------------------------------- helpers

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO,
    maxBuffer: 1 << 28,
    encoding: 'utf8',
  });
}

function repoFiles() {
  return git(['ls-files', '-co', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(REPO, f)))
    .sort(cmp);
}

const inRoots = (f, roots) =>
  roots.some((r) => f === r || f.startsWith(`${r}/`));
const hasExt = (f, exts) => exts.some((e) => f.endsWith(e));
const posix = (p) => p.split(path.sep).join('/');

function lineAt(text, index) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** Resolves a specifier; workspace specifiers resolve by path so node_modules links are optional. */
function resolveSpec(spec, fromRel) {
  const m = WORKSPACE_SPEC.exec(spec);
  if (m) {
    const rel = m[2]
      ? `packages/${m[1]}/src/${m[2]}.ts`
      : `packages/${m[1]}/src/index.ts`;
    if (fs.existsSync(path.join(REPO, rel))) return { kind: 'file', rel };
  }
  return resolveSpecifier(spec, fromRel);
}

function pkgSpecifier(rel) {
  const m = /^packages\/(contracts|core|db)\/src\/(.+)\.ts$/.exec(rel);
  if (!m) return null;
  return m[2] === 'index' ? `@knowscroll/${m[1]}` : `@knowscroll/${m[1]}/${m[2]}`;
}

function relativeSpecifier(fromRel, toRel_, like) {
  let r = posix(
    path.relative(path.join(REPO, path.dirname(fromRel)), path.join(REPO, toRel_)),
  );
  // Keep the extension style of the original specifier.
  const ext = path.extname(like);
  const targetExt = path.extname(toRel_);
  if (like.endsWith('.js') && targetExt === '.ts') r = r.replace(/\.ts$/, '.js');
  else if (!['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'].includes(ext)) {
    r = r.replace(/\.(ts|tsx|mts)$/, '');
    if (/(^|\/)index$/.test(r) && !/(^|\/)index$/.test(like)) {
      r = r.replace(/\/?index$/, '') || '.';
    }
  }
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
}

function applyEdits(text, edits, label) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  let prev = Infinity;
  for (const e of sorted) {
    if (e.end > prev) throw new Error(`overlapping edits in ${label}`);
    if (out.slice(e.start, e.end) !== e.old) {
      throw new Error(`stale edit range in ${label}:${e.line}`);
    }
    out = out.slice(0, e.start) + e.next + out.slice(e.end);
    prev = e.start;
  }
  return out;
}

/** All string literals (not template substitutions) with raw ranges, for path-string handling. */
function scanStringLiterals(rel, text) {
  const ext = path.extname(rel);
  const kind =
    ext === '.tsx'
      ? ts.ScriptKind.TSX
      : ext === '.mjs' || ext === '.js'
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const start = n.getStart(sf);
      out.push({
        start: start + 1,
        end: n.end - 1,
        text: text.slice(start + 1, n.end - 1),
        line: sf.getLineAndCharacterOfPosition(start).line + 1,
      });
    } else if (ts.isTemplateExpression(n)) {
      const parts = [n.head, ...n.templateSpans.map((s) => s.literal)];
      for (const p of parts) {
        const raw = text.slice(p.getStart(sf), p.end);
        out.push({
          start: p.getStart(sf) + 1,
          end: p.end - (p === n.templateSpans.at(-1)?.literal ? 1 : 2),
          text: raw,
          line: sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1,
          template: true,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------- mode: packages

function runPackages({ pkg, roots, dryRun }) {
  if (!PKGS.includes(pkg)) throw new Abort('--pkg must be contracts, core or db');
  const files = repoFiles().filter(
    (f) => inRoots(f, roots) && hasExt(f, SRC_EXT),
  );
  const edits = new Map(); // file -> edit[]
  const listed = [];
  const problems = [];
  const unresolved = [];
  const dynamic = [];
  const pathStrings = [];
  const needle = `packages/${pkg}/src/`;
  for (const file of files) {
    if (file.startsWith(VENDORED)) continue;
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    const scan = scanSource(file, text);
    for (const d of scan.dynamicNonLiteral) {
      dynamic.push(`${file}:${d.line}: ${d.text}`);
    }
    const inPkg = file.startsWith(`packages/${pkg}/`);
    const specStarts = new Set();
    for (const s of scan.specs) {
      specStarts.add(s.start);
      let next = null;
      if (!inPkg) {
        const r = resolveSpec(s.spec, file);
        if (r.kind === 'unresolved') {
          unresolved.push(`${file}:${s.line}: ${s.spec}`);
          continue;
        }
        if (r.kind === 'file' && r.rel.startsWith(`packages/${pkg}/`)) {
          if (r.rel.startsWith(needle) && r.rel.endsWith('.ts')) {
            next = pkgSpecifier(r.rel);
          } else {
            problems.push(
              `${file}:${s.line}: ${s.spec} -> ${r.rel} is outside packages/${pkg}/src (not rewritten)`,
            );
          }
        }
      } else if (s.spec.startsWith('.') && s.spec.endsWith('.js')) {
        const sibling = path.resolve(
          REPO,
          path.dirname(file),
          s.spec.replace(/\.js$/, '.ts'),
        );
        if (fs.existsSync(sibling)) next = s.spec.replace(/\.js$/, '.ts');
      }
      if (next && next !== s.spec) {
        (edits.get(file) ?? edits.set(file, []).get(file)).push({
          start: s.start,
          end: s.end,
          old: s.spec,
          next,
          line: s.line,
        });
      }
    }
    if (text.includes(needle)) {
      for (const lit of scanStringLiterals(file, text)) {
        if (specStarts.has(lit.start)) continue;
        if (lit.text.includes(needle)) {
          pathStrings.push(`${file}:${lit.line}: ${lit.text.slice(0, 140)}`);
        }
      }
    }
  }
  void listed;
  const writes = new Map();
  for (const [file, list] of edits) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    writes.set(file, applyEdits(text, list, file));
  }
  summarize({ mode: `packages (${pkg})`, roots, edits, dryRun, verbose: false });
  report('path strings into packages/' + pkg + '/src (not edited)', pathStrings);
  report('outside-src cross-package imports (not rewritten)', problems);
  report('unresolved specifiers', unresolved);
  report('dynamic import() with non-literal argument (manual review)', dynamic);
  if (!dryRun) {
    for (const [file, content] of writes) {
      fs.writeFileSync(path.join(REPO, file), content);
    }
  }
  return edits;
}

// ----------------------------------------------------------------- mode: moves

function rewriteLiteral(lit, fileRel, newFileRel, map, oldSet) {
  if (oldSet.has(lit)) return map[lit];
  for (const oldP of Object.keys(map)) {
    if (lit.endsWith(`/${oldP}`)) {
      return lit.slice(0, lit.length - oldP.length) + map[oldP];
    }
  }
  const relLike = lit.startsWith('./') || lit.startsWith('../') || /^[\w.-]+\//.test(lit);
  if (relLike && !/[\s*?${}]/.test(lit)) {
    const abs = toRel(path.resolve(REPO, path.dirname(fileRel), lit));
    if (oldSet.has(abs)) {
      let r = posix(
        path.relative(
          path.join(REPO, path.dirname(newFileRel)),
          path.join(REPO, map[abs]),
        ),
      );
      if (lit.startsWith('.') && !r.startsWith('.')) r = `./${r}`;
      return r;
    }
  }
  return null;
}

function runMoves({ mapFile, roots, dryRun, verbose }) {
  const map = JSON.parse(fs.readFileSync(path.resolve(mapFile), 'utf8'));
  const olds = Object.keys(map).sort(cmp);
  if (olds.length === 0) throw new Abort('empty move map');
  const oldSet = new Set(olds);
  const newSet = new Set(Object.values(map));
  if (newSet.size !== olds.length) throw new Abort('move map has duplicate targets');

  // 1. Preconditions.
  const tracked = new Set(git(['ls-files', '-z']).split('\0').filter(Boolean));
  const absent = olds.filter((o) => !fs.existsSync(path.join(REPO, o)));
  const applied = olds.every(
    (o) => !tracked.has(o) && !fs.existsSync(path.join(REPO, o)) && fs.existsSync(path.join(REPO, map[o])),
  );
  if (applied) {
    console.log('move map already applied; nothing to do');
    return;
  }
  void absent;
  for (const o of olds) {
    if (o.startsWith(VENDORED) || map[o].startsWith(VENDORED)) {
      throw new Abort(`${o}: the vendored cutroom-v1 tree is never moved`);
    }
    if (!tracked.has(o)) throw new Abort(`old path is not tracked: ${o}`);
    if (fs.existsSync(path.join(REPO, map[o])) || tracked.has(map[o])) {
      throw new Abort(`target already exists: ${map[o]}`);
    }
    if (o === map[o]) throw new Abort(`no-op move: ${o}`);
  }
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) {
    const msg = `working tree is dirty:\n${dirty.split('\n').slice(0, 20).join('\n')}`;
    if (!dryRun) throw new Abort(msg);
    console.warn(`warning (dry-run only): ${msg}`);
  }

  const moved = (p) => map[p] ?? p;
  const all = repoFiles();
  const scanRoots = [...new Set([...roots, 'apps/web'])];
  const specFiles = all.filter(
    (f) => inRoots(f, scanRoots) && hasExt(f, SRC_EXT) && !f.startsWith(VENDORED),
  );

  // 2. Plan specifier edits against the CURRENT layout.
  const edits = new Map(); // old file path -> edits
  const unresolved = [];
  const dynamic = [];
  const problems = [];
  const specStartsByFile = new Map();
  const push = (file, e) => (edits.get(file) ?? edits.set(file, []).get(file)).push(e);
  for (const file of specFiles) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    const scan = scanSource(file, text);
    for (const d of scan.dynamicNonLiteral) dynamic.push(`${file}:${d.line}: ${d.text}`);
    const starts = new Set();
    specStartsByFile.set(file, starts);
    const newFile = moved(file);
    for (const s of scan.specs) {
      starts.add(s.start);
      const isRel = s.spec.startsWith('.');
      const isWs = WORKSPACE_SPEC.test(s.spec);
      if (!isRel && !isWs) continue;
      const r = resolveSpec(s.spec, file);
      if (r.kind === 'unresolved') {
        unresolved.push(`${file}:${s.line}: ${s.spec}`);
        continue;
      }
      if (r.kind !== 'file') continue;
      const newTarget = moved(r.rel);
      let next = null;
      if (isWs) {
        if (newTarget === r.rel) continue;
        next = pkgSpecifier(newTarget);
        if (!next) {
          problems.push(`${file}:${s.line}: ${s.spec} -> ${newTarget} is no longer exportable as a package subpath`);
          continue;
        }
      } else {
        if (newTarget === r.rel && newFile === file) continue;
        next = relativeSpecifier(newFile, newTarget, s.spec);
      }
      if (next !== s.spec) {
        push(file, { start: s.start, end: s.end, old: s.spec, next, line: s.line, kind: 'specifier' });
      }
    }
  }

  // 3. Path-string literals.
  const pathEdits = [];
  const literalFiles = all.filter(
    (f) =>
      (/^(scripts|tests|ops|apps)\//.test(f) && hasExt(f, SRC_EXT) && !f.startsWith(VENDORED)) ||
      f.endsWith('.py') ||
      f.endsWith('.sh'),
  );
  for (const file of literalFiles) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    if (!olds.some((o) => text.includes(path.basename(o))) && !/\.\.?\//.test(text)) continue;
    const newFile = moved(file);
    if (file.endsWith('.py') || file.endsWith('.sh')) {
      const re = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const inner = m[2];
        const next = rewriteLiteral(inner, file, newFile, map, oldSet);
        if (next !== null && next !== inner) {
          const start = m.index + 1;
          const e = { start, end: start + inner.length, old: inner, next, line: lineAt(text, start), kind: 'path-string' };
          push(file, e);
          pathEdits.push({ file, ...e });
        }
      }
    } else {
      const specStarts = specStartsByFile.get(file) ?? new Set();
      for (const lit of scanStringLiterals(file, text)) {
        if (specStarts.has(lit.start) || lit.template) continue;
        if (lit.text.includes('\\')) continue;
        const next = rewriteLiteral(lit.text, file, newFile, map, oldSet);
        if (next !== null && next !== lit.text) {
          const e = { start: lit.start, end: lit.end, old: lit.text, next, line: lit.line, kind: 'path-string' };
          push(file, e);
          pathEdits.push({ file, ...e });
        }
      }
    }
  }

  if (problems.length) {
    report('PROBLEMS (aborting; nothing written)', problems);
    throw new Abort('unrepresentable specifiers');
  }

  // 4. Compute final contents (old path -> new content), then the leftover listing.
  const finalContent = new Map(); // final path -> content
  for (const [file, list] of edits) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    finalContent.set(moved(file), applyEdits(text, list, file));
  }

  const needles = [];
  for (const o of olds) {
    needles.push({ old: o, text: o });
    const idx = o.indexOf('/src/');
    if (idx !== -1 && /^(apps|packages)\//.test(o)) {
      needles.push({ old: o, text: o.slice(idx + 5) });
    }
  }
  const LIST_EXT = ['.md', '.json', '.yml', '.yaml', '.py', '.sh', '.ts', '.mjs'];
  const leftovers = [];
  const movedNew = new Set(newSet);
  for (const f of all) {
    if (!hasExt(f, LIST_EXT)) continue;
    if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json)$/.test(f)) continue;
    const finalPath = moved(f);
    let content = finalContent.get(finalPath);
    if (content === undefined) {
      content = fs.readFileSync(path.join(REPO, f), 'utf8');
    }
    if (!needles.some((n) => content.includes(n.text))) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const n of needles) {
        const re = new RegExp(`(?<![A-Za-z0-9_-])${n.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`);
        if (re.test(lines[i])) {
          leftovers.push(`${finalPath}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
          break;
        }
      }
    }
  }
  void movedNew;

  summarize({ mode: 'moves', roots: [...scanRoots, 'scripts'], edits, dryRun, verbose, movedFiles: olds.length });
  report(
    'path-string rewrites (non-import string literals)',
    pathEdits.map((e) => `${e.file}:${e.line}: '${e.old}' -> '${e.next}'`),
  );
  report('REMAINING old-path occurrences (edit by hand)', [...new Set(leftovers)]);
  report('unresolved specifiers', unresolved);
  report('dynamic import() with non-literal argument (manual review)', dynamic);

  if (dryRun) {
    console.log(`dry-run: would git mv ${olds.length} file(s):`);
    for (const o of olds) console.log(`  ${o} -> ${map[o]}`);
    return;
  }

  // 5. Execute. Everything above is computed; a failure here is rolled back.
  const createdDirs = [];
  try {
    for (const o of olds) {
      const dir = path.dirname(path.join(REPO, map[o]));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        createdDirs.push(dir);
      }
      git(['mv', o, map[o]]);
    }
    for (const [finalPath, content] of finalContent) {
      fs.writeFileSync(path.join(REPO, finalPath), content);
    }
  } catch (e) {
    console.error(`execution failed (${e.message}); rolling back with git reset --hard`);
    git(['reset', '--hard', '-q', 'HEAD']);
    for (const d of createdDirs.reverse()) {
      try {
        fs.rmdirSync(d);
      } catch {}
    }
    throw new Abort('rolled back');
  }
  console.log(`moved ${olds.length} file(s). Undo: git reset --hard (tree was clean).`);
}

// -------------------------------------------------------------------- reporting

function summarize({ mode, roots, edits, dryRun, verbose, movedFiles }) {
  const rootOf = (f) =>
    [...roots].sort((a, b) => b.length - a.length).find((r) => f === r || f.startsWith(`${r}/`)) ?? '(other)';
  const per = {};
  for (const [file, list] of edits) {
    const r = rootOf(file);
    const e = per[r] ?? (per[r] = { files: 0, edits: 0 });
    e.files++;
    e.edits += list.length;
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}mode ${mode}${movedFiles ? `, ${movedFiles} file(s) moved` : ''}`);
  const keys = Object.keys(per).sort(cmp);
  if (keys.length === 0) console.log('  no edits');
  let tf = 0;
  let te = 0;
  for (const k of keys) {
    console.log(`  ${k}: ${per[k].files} file(s) changed, ${per[k].edits} edit(s)`);
    tf += per[k].files;
    te += per[k].edits;
  }
  console.log(`  total: ${tf} file(s), ${te} edit(s)`);
  if (dryRun || verbose) {
    for (const file of [...edits.keys()].sort(cmp)) {
      for (const e of edits.get(file).sort((a, b) => a.line - b.line)) {
        console.log(`    ${file}:${e.line}: ${e.old} -> ${e.next}`);
      }
    }
  }
}

function report(title, lines) {
  console.log(`${title}: ${lines.length}`);
  for (const l of lines) console.log(`  ${l}`);
}

// --------------------------------------------------------------------------- main

function main() {
  const { flags, multi } = parseArgs(
    process.argv.slice(2),
    ['mode', 'pkg', 'roots', 'map'],
    ['dry-run', 'verbose'],
  );
  const roots = multi.roots?.length ? multi.roots.map((r) => r.replace(/\/$/, '')) : DEFAULT_ROOTS;
  const opts = { roots, dryRun: !!flags['dry-run'], verbose: !!flags.verbose };
  if (flags.mode === 'packages') {
    if (!flags.pkg) throw new Abort('--mode packages needs --pkg');
    runPackages({ ...opts, pkg: flags.pkg });
  } else if (flags.mode === 'moves') {
    if (!flags.map) throw new Abort('--mode moves needs --map <moves.json>');
    runMoves({ ...opts, mapFile: flags.map });
  } else {
    process.stderr.write(
      'usage: rewrite-imports.mjs --mode packages --pkg <contracts|core|db> | --mode moves --map moves.json  [--roots dirs...] [--dry-run] [--verbose]\n',
    );
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`${e instanceof Abort ? 'ABORT: ' : ''}${e.message}\n`);
    if (!(e instanceof Abort)) process.stderr.write(`${e.stack}\n`);
    process.exit(e instanceof Abort ? 1 : 2);
  }
}
