#!/usr/bin/env node
/*
 * export-surface: prove a package's public API does not change while code moves between
 * files inside it (issue #196).
 *
 * Usage (from the repo root):
 *   node scripts/refactor/export-surface.mjs snapshot --out <file.json> [--internal <glob ...>]
 *   node scripts/refactor/export-surface.mjs compare <old.json> <new.json>
 *        [--allow <names.txt>] [--by-module --move-map <map.json>]
 *
 * snapshot  Builds a ts.Program from the root tsconfig and lists, for every module under
 *           packages/{contracts,core,db}/src, its exports (aliases followed to the original
 *           symbol) with kind (value | type | value+type), declaration kinds and a type string
 *           (import("...") qualifiers stripped, so moving files does not change it). Classes,
 *           interfaces and enums are expanded to their member lists, because a bare name would
 *           hide member changes. Aggregated per package as name -> {kind, type, modules}.
 *           Modules matching --internal globs (repo-relative, `*` and `**`) go into a separate
 *           `internal` section and are left out of the package aggregate. For apps/api and
 *           apps/worker the surface covers only modules imported (statically or via import())
 *           from tests/** or scripts/**.
 * compare   Per package/app prints added / removed / changed names. --allow takes a file of
 *           `pkg:name` lines (pkg = contracts|core|db|api|worker) whose difference is expected.
 *           --by-module also compares each module's exports after mapping old module paths
 *           through the move map ({"old/path.ts": "new/path.ts"}). Exit 1 on any unexplained
 *           difference.
 * Output is deterministic (sorted keys); `modules` lists are informational and never compared
 * in the default mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cmp,
  parseArgs,
  REPO,
  resolveSpecifier,
  scanSource,
  sortKeys,
  toRel,
  ts,
  walk,
} from './import-graph.mjs';

const PACKAGES = ['contracts', 'core', 'db'];
const APPS = ['api', 'worker'];
const FORMAT =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') i++;
        re += '(?:.*/)?';
        // `**` alone at the end matches anything below
        if (i === glob.length - 1) re = re.replace(/\(\?:\.\*\/\)\?$/, '.*');
      } else re += '[^/]*';
    } else if ('.+^${}()|[]\\?'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function stripImports(s) {
  return s
    .replace(/import\("[^"]*"\)\./g, '')
    .replace(/import\("[^"]*"\)/g, 'module');
}

function declKind(decl) {
  switch (decl.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
      return 'function';
    case ts.SyntaxKind.ClassDeclaration:
      return 'class';
    case ts.SyntaxKind.VariableDeclaration: {
      const flags = decl.parent?.flags ?? 0;
      if (flags & ts.NodeFlags.Const) return 'const';
      if (flags & ts.NodeFlags.Let) return 'let';
      return 'var';
    }
    case ts.SyntaxKind.EnumDeclaration:
      return 'enum';
    case ts.SyntaxKind.InterfaceDeclaration:
      return 'interface';
    case ts.SyntaxKind.TypeAliasDeclaration:
      return 'type';
    case ts.SyntaxKind.ModuleDeclaration:
      return 'namespace';
    case ts.SyntaxKind.ExportAssignment:
      return 'default-expression';
    case ts.SyntaxKind.NamespaceExport:
    case ts.SyntaxKind.SourceFile:
      return 'namespace';
    default:
      return ts.SyntaxKind[decl.kind];
  }
}

function makeDescriber(checker) {
  const members = (type, decl) => {
    const parts = [];
    for (const p of checker.getPropertiesOfType(type)) {
      const pd = p.valueDeclaration ?? p.declarations?.[0] ?? decl;
      const t = checker.typeToString(
        checker.getTypeOfSymbolAtLocation(p, pd),
        undefined,
        FORMAT,
      );
      const ro =
        ts.getCombinedModifierFlags?.(pd) & ts.ModifierFlags.Readonly
          ? 'readonly '
          : '';
      const mods = ts.getCombinedModifierFlags?.(pd) ?? 0;
      const vis =
        mods & ts.ModifierFlags.Private
          ? 'private '
          : mods & ts.ModifierFlags.Protected
            ? 'protected '
            : '';
      const opt = p.flags & ts.SymbolFlags.Optional ? '?' : '';
      parts.push(`${vis}${ro}${p.name}${opt}: ${t}`);
    }
    parts.sort(cmp);
    for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
      for (const sig of checker.getSignaturesOfType(type, kind)) {
        parts.push(
          `${kind === ts.SignatureKind.Construct ? '' : 'call '}${checker.signatureToString(sig, decl, FORMAT, kind)}`,
        );
      }
    }
    for (const info of checker.getIndexInfosOfType(type)) {
      parts.push(
        `[${checker.typeToString(info.keyType)}]: ${checker.typeToString(info.type, undefined, FORMAT)}`,
      );
    }
    return `{ ${parts.join('; ')} }`;
  };
  return { members };
}

/** Describes one exported symbol (already alias-resolved). */
function describeSymbol(checker, describer, exported, moduleExports) {
  let target = exported;
  if (target.flags & ts.SymbolFlags.Alias) {
    try {
      target = checker.getAliasedSymbol(target);
    } catch {}
  }
  const decls = target.declarations ?? [];
  const decl = target.valueDeclaration ?? decls[0];
  if (!decl || target.flags & ts.SymbolFlags.Alias) {
    return { kind: 'unknown', decl: 'unknown', type: 'unknown' };
  }
  const hasValue = !!(target.flags & ts.SymbolFlags.Value);
  const hasType = !!(target.flags & ts.SymbolFlags.Type);
  const hasNamespace = !!(target.flags & ts.SymbolFlags.Namespace);
  const kind =
    hasValue && hasType
      ? 'value+type'
      : hasValue
        ? 'value'
        : hasType
          ? 'type'
          : hasNamespace
            ? 'namespace'
            : 'unknown';
  const entry = {
    kind,
    decl: [...new Set(decls.map(declKind))].sort(cmp).join('+'),
  };

  const valueType = () => {
    const t = checker.getTypeOfSymbolAtLocation(target, decl);
    let s = checker.typeToString(t, undefined, FORMAT);
    if (
      target.flags &
      (ts.SymbolFlags.Class | ts.SymbolFlags.Enum | ts.SymbolFlags.ValueModule)
    ) {
      s = `${s} ${describer.members(t, decl)}`;
    }
    return stripImports(s);
  };
  const declaredType = () => {
    const t = checker.getDeclaredTypeOfSymbol(target);
    let s = checker.typeToString(
      t,
      undefined,
      FORMAT | ts.TypeFormatFlags.InTypeAlias,
    );
    if (
      target.flags &
      (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum)
    ) {
      s = `${s} ${describer.members(t, decl)}`;
    }
    return stripImports(s);
  };

  if (hasNamespace && !hasValue && !hasType) {
    const names = checker
      .getExportsOfModule(target)
      .map((s) => s.name)
      .sort(cmp);
    entry.type = `namespace { ${names.join(', ')} }`;
  } else if (hasValue) {
    entry.type = valueType();
    if (hasType) entry.declaredType = declaredType();
  } else if (hasType) {
    entry.type = declaredType();
  } else entry.type = 'unknown';
  void moduleExports;
  return entry;
}

function entrySignature(e) {
  return JSON.stringify([e.kind, e.decl, e.type, e.declaredType ?? null]);
}

function aggregate(perModule) {
  // perModule: {modulePath: {name: entry}}  ->  {name: entry+modules | {conflict:[...]}}
  const byName = new Map();
  for (const [mod, names] of Object.entries(perModule)) {
    for (const [name, e] of Object.entries(names)) {
      const variants = byName.get(name) ?? new Map();
      const sig = entrySignature(e);
      const v = variants.get(sig) ?? { entry: e, modules: [] };
      v.modules.push(mod);
      variants.set(sig, v);
      byName.set(name, variants);
    }
  }
  const out = {};
  for (const [name, variants] of byName) {
    const list = [...variants.values()].map((v) => ({
      ...v.entry,
      modules: v.modules.sort(cmp),
    }));
    list.sort((a, b) => cmp(entrySignature(a), entrySignature(b)));
    out[name] = list.length === 1 ? list[0] : { conflict: list };
  }
  return out;
}

function buildProgram() {
  const configPath = path.join(REPO, 'tsconfig.json');
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, REPO);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function moduleExportsOf(program, checker, rel) {
  const sf = program.getSourceFile(path.join(REPO, rel));
  if (!sf) return null;
  const sym = checker.getSymbolAtLocation(sf);
  if (!sym) return {};
  const describer = makeDescriber(checker);
  const out = {};
  for (const exp of checker.getExportsOfModule(sym)) {
    out[exp.name] = describeSymbol(checker, describer, exp);
  }
  return out;
}

/** Modules under apps/<app>/src imported from tests/** or scripts/**. */
function importedAppModules() {
  const sources = [];
  for (const d of ['tests', 'scripts']) {
    walk(d, ['.ts', '.tsx', '.mts', '.mjs'], sources);
  }
  const found = {};
  for (const app of APPS) found[app] = new Set();
  for (const rel of sources) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const s of scanSource(rel, text).specs) {
      const r = resolveSpecifier(s.spec, rel);
      if (r.kind !== 'file') continue;
      for (const app of APPS) {
        if (r.rel.startsWith(`apps/${app}/src/`)) found[app].add(r.rel);
      }
    }
  }
  return found;
}

function snapshot(internalGlobs) {
  const program = buildProgram();
  const checker = program.getTypeChecker();
  const internalRes = internalGlobs.map(globToRegex);
  const isInternal = (rel) => internalRes.some((re) => re.test(rel));
  const snap = {
    version: 1,
    internalGlobs: [...internalGlobs].sort(cmp),
    packages: {},
    apps: {},
    byModule: {},
    internal: {},
  };
  for (const pkg of PACKAGES) {
    const modules = walk(`packages/${pkg}/src`, ['.ts']);
    const perModule = {};
    snap.internal[pkg] = {};
    for (const rel of modules) {
      const exps = moduleExportsOf(program, checker, rel);
      if (exps === null) continue;
      snap.byModule[rel] = exps;
      if (isInternal(rel)) snap.internal[pkg][rel] = exps;
      else perModule[rel] = exps;
    }
    snap.packages[pkg] = aggregate(perModule);
  }
  const imported = importedAppModules();
  for (const app of APPS) {
    const perModule = {};
    for (const rel of [...imported[app]].sort(cmp)) {
      const exps = moduleExportsOf(program, checker, rel);
      if (exps === null) continue;
      snap.byModule[rel] = exps;
      perModule[rel] = exps;
    }
    snap.apps[app] = aggregate(perModule);
  }
  return sortKeys(snap);
}

// ------------------------------------------------------------------- compare

const comparable = (e) =>
  e.conflict
    ? JSON.stringify(e.conflict.map(entrySignature).sort(cmp))
    : entrySignature(e);

function diffMaps(oldMap, newMap) {
  const added = Object.keys(newMap)
    .filter((n) => !(n in oldMap))
    .sort(cmp);
  const removed = Object.keys(oldMap)
    .filter((n) => !(n in newMap))
    .sort(cmp);
  const changed = Object.keys(newMap)
    .filter(
      (n) => n in oldMap && comparable(oldMap[n]) !== comparable(newMap[n]),
    )
    .sort(cmp);
  return { added, removed, changed };
}

function brief(e) {
  if (!e) return '';
  if (e.conflict) return `conflict(${e.conflict.length})`;
  return `${e.kind} ${e.decl}: ${e.type}${e.declaredType ? ` | type: ${e.declaredType}` : ''}`;
}

function loadAllow(file) {
  if (!file) return new Set();
  return new Set(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*/, '').trim())
      .filter(Boolean),
  );
}

function compareSnapshots(oldS, newS, { allow, byModule, moveMap }) {
  const lines = [];
  let failures = 0;
  const used = new Set();
  const section = (title, oldMap, newMap, key) => {
    const d = diffMaps(oldMap, newMap);
    const report = (label, names, show) => {
      const unexplained = names.filter((n) => {
        if (allow.has(`${key}:${n}`)) {
          used.add(`${key}:${n}`);
          return false;
        }
        return true;
      });
      const allowed = names.length - unexplained.length;
      lines.push(
        `  ${label}: ${unexplained.length}${allowed ? ` (+${allowed} allowed)` : ''}`,
      );
      for (const n of unexplained)
        lines.push(`    ${n}${show ? `  ${show(n)}` : ''}`);
      failures += unexplained.length;
    };
    lines.push(`${title}:`);
    report('added', d.added, (n) => brief(newMap[n]).slice(0, 200));
    report('removed', d.removed, (n) => brief(oldMap[n]).slice(0, 200));
    report(
      'changed',
      d.changed,
      (n) =>
        `\n      old: ${brief(oldMap[n]).slice(0, 400)}\n      new: ${brief(newMap[n]).slice(0, 400)}`,
    );
  };
  for (const pkg of PACKAGES) {
    section(
      `package ${pkg}`,
      oldS.packages[pkg] ?? {},
      newS.packages[pkg] ?? {},
      pkg,
    );
  }
  for (const app of APPS) {
    section(`app ${app}`, oldS.apps[app] ?? {}, newS.apps[app] ?? {}, app);
  }
  if (byModule) {
    lines.push('by module (old paths mapped through the move map):');
    const mapPath = (p) => moveMap[p] ?? p;
    const isTracked = (p) => p.startsWith('packages/') || p.startsWith('apps/');
    const newMods = new Set(Object.keys(newS.byModule));
    const mapped = new Set();
    for (const oldMod of Object.keys(oldS.byModule).sort(cmp)) {
      if (!isTracked(oldMod)) continue;
      const newMod = mapPath(oldMod);
      mapped.add(newMod);
      if (!newMods.has(newMod)) {
        const names = Object.keys(oldS.byModule[oldMod]);
        // A module that is no longer imported by tests/scripts simply drops out of the app view
        if (oldMod.startsWith('apps/')) continue;
        lines.push(
          `  module missing: ${oldMod} -> ${newMod} (${names.length} exports)`,
        );
        failures++;
        continue;
      }
      const d = diffMaps(oldS.byModule[oldMod], newS.byModule[newMod]);
      const pkgKey = oldMod.startsWith('packages/')
        ? oldMod.split('/')[1]
        : oldMod.split('/')[1];
      const un = (names) =>
        names.filter((n) => {
          if (allow.has(`${pkgKey}:${n}`)) {
            used.add(`${pkgKey}:${n}`);
            return false;
          }
          return true;
        });
      const a = un(d.added);
      const r = un(d.removed);
      const c = un(d.changed);
      if (a.length || r.length || c.length) {
        lines.push(`  ${oldMod}${oldMod === newMod ? '' : ` -> ${newMod}`}:`);
        for (const n of a) lines.push(`    added ${n}`);
        for (const n of r) lines.push(`    removed ${n}`);
        for (const n of c) lines.push(`    changed ${n}`);
        failures += a.length + r.length + c.length;
      }
    }
    for (const newMod of [...newMods].sort(cmp)) {
      if (!mapped.has(newMod) && !(newMod in oldS.byModule)) {
        lines.push(`  new module (informational): ${newMod}`);
      }
    }
  }
  for (const a of allow) {
    if (!used.has(a)) lines.push(`warning: allow entry never matched: ${a}`);
  }
  lines.push(
    failures
      ? `UNEXPLAINED DIFFERENCES: ${failures}`
      : 'OK: no unexplained differences',
  );
  return { text: `${lines.join('\n')}\n`, failures };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'snapshot') {
    const { flags, multi } = parseArgs(rest, ['out', 'internal'], []);
    if (!flags.out) throw new Error('snapshot needs --out <file.json>');
    const snap = snapshot(multi.internal ?? []);
    fs.writeFileSync(flags.out, `${JSON.stringify(snap, null, 2)}\n`);
    const count = (m) => Object.keys(m).length;
    for (const p of PACKAGES) {
      console.log(
        `package ${p}: ${count(snap.packages[p])} exports, ${Object.keys(snap.internal[p]).length} internal modules`,
      );
    }
    for (const a of APPS) {
      const mods = new Set(
        Object.values(snap.apps[a]).flatMap((e) =>
          e.conflict ? e.conflict.flatMap((x) => x.modules) : e.modules,
        ),
      );
      console.log(
        `app ${a}: ${count(snap.apps[a])} exports across ${mods.size} test/script-imported modules`,
      );
    }
    const conflicts = [
      ...PACKAGES.map((p) => [p, snap.packages[p]]),
      ...APPS.map((a) => [a, snap.apps[a]]),
    ].flatMap(([k, m]) =>
      Object.entries(m)
        .filter(([, e]) => e.conflict)
        .map(([n]) => `${k}:${n}`),
    );
    console.log(
      `name conflicts (same name, different kind/type): ${conflicts.length}${conflicts.length ? ` ${conflicts.join(', ')}` : ''}`,
    );
  } else if (cmd === 'compare') {
    const { flags, positional } = parseArgs(
      rest,
      ['allow', 'move-map'],
      ['by-module'],
    );
    const [a, b] = positional;
    if (!a || !b) throw new Error('usage: compare <old.json> <new.json>');
    const byModule = !!flags['by-module'];
    if (byModule && !flags['move-map'])
      throw new Error('--by-module needs --move-map <map.json>');
    const res = compareSnapshots(
      JSON.parse(fs.readFileSync(a, 'utf8')),
      JSON.parse(fs.readFileSync(b, 'utf8')),
      {
        allow: loadAllow(flags.allow),
        byModule,
        moveMap: byModule
          ? JSON.parse(fs.readFileSync(flags['move-map'], 'utf8'))
          : {},
      },
    );
    process.stdout.write(res.text);
    process.exit(res.failures ? 1 : 0);
  } else {
    process.stderr.write(
      'usage: export-surface.mjs snapshot --out f.json [--internal globs...] | compare old.json new.json [--allow names.txt] [--by-module --move-map map.json]\n',
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
void toRel;
