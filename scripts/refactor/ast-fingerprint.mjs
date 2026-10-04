#!/usr/bin/env node
// Behavior-preservation proof tool for the backend refactor (issue #196).
//
// Fingerprints every source file by a canonical AST serialization, so that
// formatting-only, comment-only and specifier-only commits can be proven
// to change nothing. When unsure, the tool reports a difference: a false
// "no change" is the one defect it must never have.
//
// Usage (from the repo root):
//   node scripts/refactor/ast-fingerprint.mjs snapshot --out f.json [--resolve-specifiers] [roots...]
//   node scripts/refactor/ast-fingerprint.mjs compare old.json new.json [--move-map map.json]
//   node scripts/refactor/ast-fingerprint.mjs snapshot-decls --out d.json [--resolve-specifiers] [roots...]
//   node scripts/refactor/ast-fingerprint.mjs compare-decls old.json new.json
//   node scripts/refactor/ast-fingerprint.mjs same-body <file>#<name> <file>#<name> [...]
//   node scripts/refactor/ast-fingerprint.mjs --self-test
//
// Default roots: apps/api apps/worker packages tests scripts ops
// apps/web/src apps/web/e2e (.ts .tsx .mts .mjs .js; node_modules, dist,
// build and artifacts are skipped).
//
// With --resolve-specifiers every module specifier is replaced by the repo
// relative file it resolves to (or external:<spec> / unresolved:<spec>), and
// the snapshot also writes <out>.specifiers.json holding, per file, the
// serialization hash with every specifier replaced by a placeholder
// ("skeleton") plus the ordered resolved targets. `compare --move-map`
// uses that sidecar: old targets are mapped through the move map and must
// equal the new targets, and the skeletons must match. A pure `git mv` with
// correct specifier rewrites therefore compares identical, a specifier that
// now resolves elsewhere is reported as changed.
//
// Known invisible by design: comments (including `@ts-ignore` and
// `biome-ignore` directives), whitespace, redundant parentheses around
// expressions, quote style, trailing commas, semicolons, property-key quoting.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
);
const DEFAULT_ROOTS = [
  'apps/api',
  'apps/worker',
  'packages',
  'tests',
  'scripts',
  'ops',
  'apps/web/src',
  'apps/web/e2e',
];
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'artifacts',
  '.git',
]);
const SK = ts.SyntaxKind;
const BUILTINS = new Set(builtinModules);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// ts.SyntaxKind has marker aliases (FirstNode, LastToken...) that shadow real
// names in the reverse mapping; prefer the real name.
const KIND_NAMES = new Map();
for (const [name, value] of Object.entries(SK)) {
  if (typeof value !== 'number') continue;
  const known = KIND_NAMES.get(value);
  if (!known || /^(First|Last)[A-Z]/.test(known)) KIND_NAMES.set(value, name);
}
const kindName = (kind) => KIND_NAMES.get(kind);

// ---------------------------------------------------------------- parsing

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.mjs') || file.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(file, text) {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
}

// ---------------------------------------------------- specifier resolution

function loadCompilerOptions() {
  const configPath = path.join(REPO_ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error('cannot read tsconfig.json');
  return ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT).options;
}

function makeResolver({ root, options, host, realpath }) {
  const cache = ts.createModuleResolutionCache(root, (name) => name, options);
  return (specifier, containingFile) => {
    if (specifier.startsWith('node:') || BUILTINS.has(specifier)) {
      return `external:${specifier}`;
    }
    const result = ts.resolveModuleName(
      specifier,
      containingFile,
      options,
      host,
      cache,
    );
    const resolved = result.resolvedModule?.resolvedFileName;
    if (!resolved) return `unresolved:${specifier}`;
    let real;
    try {
      real = realpath(resolved);
    } catch {
      return `unresolved:${specifier}`;
    }
    if (real.split(path.sep).includes('node_modules')) {
      return `external:${specifier}`;
    }
    if (real === root || real.startsWith(root + path.sep)) {
      return path.relative(root, real).split(path.sep).join('/');
    }
    return `external:${specifier}`;
  };
}

let realResolver;
function resolveReal(specifier, containingFile) {
  realResolver ??= makeResolver({
    root: REPO_ROOT,
    options: loadCompilerOptions(),
    host: ts.sys,
    realpath: (p) => fs.realpathSync(p),
  });
  return realResolver(specifier, containingFile);
}

// ---------------------------------------------------- canonical serializer

const SKIP_KEYS = new Set([
  'parent',
  'jsDoc',
  'jsDocCache',
  'original',
  'flowNode',
  'symbol',
  'locals',
  'nextContainer',
  'endFlowNode',
  'returnFlowNode',
]);

const PROPERTY_NAME_OWNERS = new Set([
  SK.PropertyAssignment,
  SK.MethodDeclaration,
  SK.PropertyDeclaration,
  SK.PropertySignature,
  SK.MethodSignature,
  SK.GetAccessor,
  SK.SetAccessor,
  SK.EnumMember,
  SK.ShorthandPropertyAssignment,
]);

const FUNCTION_LIKE = new Set([
  SK.FunctionDeclaration,
  SK.FunctionExpression,
  SK.ArrowFunction,
  SK.MethodDeclaration,
  SK.Constructor,
  SK.GetAccessor,
  SK.SetAccessor,
  SK.ClassStaticBlockDeclaration,
]);

const CHAIN_KINDS = new Set([
  SK.PropertyAccessExpression,
  SK.ElementAccessExpression,
  SK.CallExpression,
  SK.NonNullExpression,
]);

/**
 * A `;` that is a whole statement in a statement list, or a `;` class
 * element, does nothing (formatters delete them). An EmptyStatement as the
 * body of if/for/while is meaningful and is kept.
 */
function isVacuous(node) {
  if (node.kind === SK.SemicolonClassElement) return true;
  if (node.kind !== SK.EmptyStatement) return false;
  const parent = node.parent;
  return (
    parent.kind === SK.Block ||
    parent.kind === SK.SourceFile ||
    parent.kind === SK.ModuleBlock ||
    parent.kind === SK.CaseClause ||
    parent.kind === SK.DefaultClause
  );
}

function childrenOf(node) {
  const out = [];
  ts.forEachChild(node, (child) => {
    if (!isVacuous(child)) out.push(child);
  });
  return out;
}

function labelsOf(node) {
  const labels = new Map();
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (!value || typeof value !== 'object') continue;
    if (typeof value.kind === 'number' && 'pos' in value) {
      if (!labels.has(value)) labels.set(value, key);
    } else if (Array.isArray(value)) {
      for (const element of value) {
        if (
          element &&
          typeof element.kind === 'number' &&
          !labels.has(element)
        ) {
          labels.set(element, key);
        }
      }
    }
  }
  return labels;
}

function normalizeNumber(text) {
  const value = Number(text);
  // Beyond 15 significant digits a Number round trip can merge distinct
  // literals, which would hide a real change.
  const digits = text.replace(/[^0-9]/g, '').replace(/^0+/, '');
  if (!Number.isFinite(value) || digits.length > 15) return `raw:${text}`;
  return String(value);
}

function templateRaw(sf, node) {
  const start = node.getStart(sf);
  const text = sf.text;
  let body;
  switch (node.kind) {
    case SK.NoSubstitutionTemplateLiteral:
    case SK.TemplateTail:
      body = text.slice(start + 1, node.end - 1);
      break;
    default:
      body = text.slice(start + 1, node.end - 2);
  }
  return body.replace(/\r\n?/g, '\n');
}

function bindingNames(name, out = []) {
  if (!name) return out;
  if (ts.isIdentifier(name)) out.push(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindingNames(element.name, out);
    }
  }
  return out;
}

function hoistedVars(node, out) {
  ts.forEachChild(node, (child) => {
    if (FUNCTION_LIKE.has(child.kind) || ts.isClassLike(child)) return;
    if (
      ts.isVariableDeclarationList(child) &&
      !(child.flags & ts.NodeFlags.BlockScoped)
    ) {
      for (const declaration of child.declarations) {
        bindingNames(declaration.name, out);
      }
    }
    hoistedVars(child, out);
  });
  return out;
}

function blockDeclared(statements, out) {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      if (statement.declarationList.flags & ts.NodeFlags.BlockScoped) {
        for (const declaration of statement.declarationList.declarations) {
          bindingNames(declaration.name, out);
        }
      }
    } else if (
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name &&
      ts.isIdentifier(statement.name)
    ) {
      out.push(statement.name.text);
    }
  }
  return out;
}

/** Names a node declares for the scope it opens, or null when it opens none. */
function scopeNames(node) {
  const names = [];
  if (FUNCTION_LIKE.has(node.kind)) {
    for (const p of node.typeParameters ?? []) names.push(p.name.text);
    for (const p of node.parameters ?? []) bindingNames(p.name, names);
    if (node.kind === SK.FunctionExpression && node.name) {
      names.push(node.name.text);
    }
    const body = node.body;
    if (body && ts.isBlock(body)) {
      blockDeclared(body.statements, names);
      hoistedVars(body, names);
    }
    return names;
  }
  switch (node.kind) {
    case SK.Block:
      if (
        node.parent &&
        FUNCTION_LIKE.has(node.parent.kind) &&
        node.parent.body === node
      ) {
        return null;
      }
      return blockDeclared(node.statements, names);
    case SK.ModuleBlock:
      return blockDeclared(node.statements, names);
    case SK.CaseBlock:
      for (const clause of node.clauses)
        blockDeclared(clause.statements, names);
      return names;
    case SK.ForStatement:
    case SK.ForInStatement:
    case SK.ForOfStatement: {
      const init = node.initializer;
      if (
        init &&
        ts.isVariableDeclarationList(init) &&
        init.flags & ts.NodeFlags.BlockScoped
      ) {
        for (const d of init.declarations) bindingNames(d.name, names);
      }
      return names;
    }
    case SK.CatchClause:
      if (node.variableDeclaration) {
        bindingNames(node.variableDeclaration.name, names);
      }
      return names;
    case SK.ClassDeclaration:
    case SK.ClassExpression:
      for (const p of node.typeParameters ?? []) names.push(p.name.text);
      if (node.kind === SK.ClassExpression && node.name)
        names.push(node.name.text);
      return names;
    default:
      return null;
  }
}

function isSpecifierPosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
  ) {
    return true;
  }
  if (ts.isExternalModuleReference(parent)) return true;
  if (
    ts.isCallExpression(parent) &&
    parent.expression.kind === SK.ImportKeyword &&
    parent.arguments[0] === node
  ) {
    return true;
  }
  return (
    ts.isLiteralTypeNode(parent) &&
    parent.parent &&
    ts.isImportTypeNode(parent.parent) &&
    parent.parent.argument === parent
  );
}

function isPropertyNameIdentifier(node) {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.kind) {
    case SK.PropertyAccessExpression:
      return parent.name === node;
    case SK.QualifiedName:
      return parent.right === node;
    case SK.BindingElement:
      return parent.propertyName === node;
    case SK.MetaProperty:
    case SK.LabeledStatement:
    case SK.BreakStatement:
    case SK.ContinueStatement:
    case SK.JsxAttribute:
    case SK.ImportAttribute:
    case SK.NamedTupleMember:
      return parent.name === node || parent.label === node;
    case SK.ImportSpecifier:
    case SK.ExportSpecifier:
      return true;
    default:
      return PROPERTY_NAME_OWNERS.has(parent.kind) && parent.name === node;
  }
}

function isPropertyNamePosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.kind === SK.BindingElement) return parent.propertyName === node;
  return PROPERTY_NAME_OWNERS.has(parent.kind) && parent.name === node;
}

/**
 * Serialize one node to canonical lines.
 * opts.mode: 'text' | 'marker' (specifiers become \0SPEC<i>\0 markers)
 * opts.rename: alpha-rename locals (same-body)
 * opts.selfName: name bound to `$self` in rename mode
 * opts.dropRootModifiers: drop `export`/`default` on the root node
 */
function serializeNode(sf, root, opts = {}) {
  const lines = [];
  const specs = [];
  const scopes = [];
  let counter = 0;
  if (opts.rename) {
    const bottom = new Map();
    if (opts.selfName) bottom.set(opts.selfName, 'self');
    scopes.push(bottom);
  }

  const lookup = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const hit = scopes[i].get(name);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const emit = (depth, label, text) => {
    lines.push(`${' '.repeat(depth)}${label ? `${label}: ` : ''}${text}`);
  };

  function attrsOf(node) {
    const parts = [];
    switch (node.kind) {
      case SK.PrefixUnaryExpression:
      case SK.PostfixUnaryExpression:
      case SK.TypeOperator:
        parts.push(`op=${kindName(node.operator)}`);
        break;
      case SK.MetaProperty:
        parts.push(`kw=${kindName(node.keywordToken)}`);
        break;
      case SK.HeritageClause:
        parts.push(`token=${kindName(node.token)}`);
        break;
      case SK.ImportTypeNode:
        parts.push(`typeof=${Boolean(node.isTypeOf)}`);
        break;
      case SK.ExportAssignment:
        parts.push(`equals=${Boolean(node.isExportEquals)}`);
        break;
      case SK.VariableDeclarationList:
        parts.push(`decl=${node.flags & ts.NodeFlags.BlockScoped}`);
        break;
      case SK.ModuleDeclaration:
        parts.push(
          `ns=${node.flags & (ts.NodeFlags.Namespace | ts.NodeFlags.GlobalAugmentation | ts.NodeFlags.NestedNamespace)}`,
        );
        break;
      default:
    }
    if (CHAIN_KINDS.has(node.kind)) {
      parts.push(`chain=${Boolean(node.flags & ts.NodeFlags.OptionalChain)}`);
    }
    if ('isTypeOnly' in node && node.isTypeOnly) parts.push('typeOnly');
    if ('phaseModifier' in node && node.phaseModifier !== undefined) {
      parts.push(`phase=${kindName(node.phaseModifier)}`);
    }
    return parts.length ? `[${parts.join(',')}]` : '';
  }

  function leaf(node, depth, label) {
    switch (node.kind) {
      case SK.Identifier:
      case SK.PrivateIdentifier: {
        if (
          opts.rename &&
          node.kind === SK.Identifier &&
          !isPropertyNameIdentifier(node)
        ) {
          const local = lookup(node.text);
          if (local !== undefined) {
            emit(depth, label, `Local ${local}`);
            return true;
          }
        }
        emit(
          depth,
          label,
          `${kindName(node.kind)} ${JSON.stringify(node.text)}`,
        );
        return true;
      }
      case SK.StringLiteral:
        if (isSpecifierPosition(node)) {
          if (opts.mode === 'marker') {
            specs.push(node.text);
            emit(depth, label, `Specifier \0${specs.length - 1}\0`);
          } else {
            emit(depth, label, `Specifier ${JSON.stringify(node.text)}`);
          }
          return true;
        }
        emit(depth, label, `StringLiteral ${JSON.stringify(node.text)}`);
        return true;
      case SK.NoSubstitutionTemplateLiteral:
      case SK.TemplateHead:
      case SK.TemplateMiddle:
      case SK.TemplateTail:
        emit(
          depth,
          label,
          `${kindName(node.kind)} ${JSON.stringify(templateRaw(sf, node))}`,
        );
        return true;
      case SK.NumericLiteral:
        emit(depth, label, `NumericLiteral ${normalizeNumber(node.text)}`);
        return true;
      case SK.BigIntLiteral:
        emit(
          depth,
          label,
          `BigIntLiteral ${node.text.toLowerCase().replace(/_/g, '')}`,
        );
        return true;
      case SK.RegularExpressionLiteral:
        emit(
          depth,
          label,
          `RegularExpressionLiteral ${JSON.stringify(node.text)}`,
        );
        return true;
      case SK.JsxText: {
        const text = node.text.replace(/\s+/g, ' ').trim();
        if (text) emit(depth, label, `JsxText ${JSON.stringify(text)}`);
        return true;
      }
      default:
        return false;
    }
  }

  function nameText(node) {
    return ts.isNumericLiteral(node) ? normalizeNumber(node.text) : node.text;
  }

  function walk(node, depth, label, skipModifiers) {
    if (node.kind === SK.ParenthesizedType) {
      // Formatters add `(typeof x)[number]`; precedence lives in the tree.
      walk(node.type, depth, label, false);
      return;
    }
    if (node.kind === SK.ParenthesizedExpression) {
      let inner = node.expression;
      while (inner.kind === SK.ParenthesizedExpression)
        inner = inner.expression;
      if (
        node.parent?.kind === SK.ExpressionStatement &&
        ts.isStringLiteral(inner)
      ) {
        // `('use strict')` is an expression, `'use strict'` a directive.
        emit(depth, label, 'ParenthesizedStringStatement');
        walk(inner, depth + 1, 'expression', false);
        return;
      }
      walk(inner, depth, label, false);
      return;
    }

    if (
      (ts.isIdentifier(node) ||
        ts.isStringLiteral(node) ||
        ts.isNumericLiteral(node)) &&
      isPropertyNamePosition(node)
    ) {
      emit(depth, label, `Name ${JSON.stringify(nameText(node))}`);
      return;
    }

    if (leaf(node, depth, label)) return;

    emit(depth, label, `${kindName(node.kind)}${attrsOf(node)}`);

    const names = opts.rename ? scopeNames(node) : null;
    if (names) {
      const scope = new Map();
      for (const name of names) {
        if (!scope.has(name)) scope.set(name, String(++counter));
      }
      scopes.push(scope);
    }

    if (opts.rename) {
      if (node.kind === SK.ShorthandPropertyAssignment) {
        emit(depth + 1, 'key', `Name ${JSON.stringify(node.name.text)}`);
      } else if (
        node.kind === SK.BindingElement &&
        !node.propertyName &&
        ts.isIdentifier(node.name)
      ) {
        emit(depth + 1, 'key', `Name ${JSON.stringify(node.name.text)}`);
      }
    }

    const labels = labelsOf(node);
    for (const child of childrenOf(node)) {
      if (
        skipModifiers &&
        (child.kind === SK.ExportKeyword || child.kind === SK.DefaultKeyword)
      ) {
        continue;
      }
      if (
        opts.rename &&
        node.kind === SK.ShorthandPropertyAssignment &&
        child === node.name
      ) {
        walkRenamedShorthand(child, depth + 1);
        continue;
      }
      walk(child, depth + 1, labels.get(child) ?? '?', false);
    }

    if (names) scopes.pop();
  }

  function walkRenamedShorthand(identifier, depth) {
    const local = lookup(identifier.text);
    emit(
      depth,
      'value',
      local === undefined
        ? `Identifier ${JSON.stringify(identifier.text)}`
        : `Local ${local}`,
    );
  }

  if (root.kind === SK.SourceFile) {
    const shebang = /^#![^\n]*/.exec(sf.text);
    if (shebang) emit(0, '', `Shebang ${JSON.stringify(shebang[0].trimEnd())}`);
    emit(0, '', 'SourceFile');
    for (const statement of root.statements.filter((s) => !isVacuous(s)))
      walk(statement, 1, 'statements', false);
    emit(1, 'endOfFile', 'EndOfFileToken');
  } else {
    walk(root, 0, '', Boolean(opts.dropRootModifiers));
  }
  return { lines, specs };
}

// --------------------------------------------------------- file fingerprint

function fingerprintSource(
  file,
  text,
  { resolveSpecifiers = false, resolver } = {},
) {
  const sf = parse(file, text);
  if (sf.parseDiagnostics?.length) {
    // Syntax errors make the tree unreliable: any textual change must show.
    return { hash: sha256(`PARSE_ERROR\n${text}`) };
  }
  if (!resolveSpecifiers) {
    const { lines } = serializeNode(sf, sf, { mode: 'text' });
    return { hash: sha256(lines.join('\n')) };
  }
  const { lines, specs } = serializeNode(sf, sf, { mode: 'marker' });
  const absolute = path.isAbsolute(file) ? file : path.join(REPO_ROOT, file);
  const targets = specs.map((spec) => resolver(spec, absolute));
  const fill = (replacement) =>
    lines
      .map((line) =>
        line.replace(/\0(\d+)\0/g, (_, i) => replacement(Number(i))),
      )
      .join('\n');
  return {
    hash: sha256(fill((i) => JSON.stringify(targets[i]))),
    skeleton: sha256(fill(() => '<SPEC>')),
    targets,
  };
}

// ------------------------------------------------------------- file walking

function* walkFiles(absoluteDir) {
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name)))
      yield full;
  }
}

function collectFiles(roots) {
  const files = new Set();
  for (const root of roots) {
    const absolute = path.resolve(root);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (stat.isFile()) files.add(absolute);
    else for (const file of walkFiles(absolute)) files.add(file);
  }
  return [...files]
    .map((f) =>
      path.relative(REPO_ROOT, fs.realpathSync(f)).split(path.sep).join('/'),
    )
    .sort();
}

function sortedObject(entries) {
  return Object.fromEntries(
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

// ------------------------------------------------------------------ commands

function parseArgs(argv) {
  const flags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '--move-map')
      flags[arg.slice(2)] = argv[++i];
    else if (arg === '--resolve-specifiers') flags.resolve = true;
    else if (arg === '--self-test') flags.selfTest = true;
    else if (arg.startsWith('--')) die(`unknown option ${arg}`);
    else flags.positional.push(arg);
  }
  return flags;
}

function die(message) {
  console.error(message);
  process.exit(2);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cmdSnapshot(flags) {
  if (!flags.out) die('snapshot needs --out <file.json>');
  const roots = flags.positional.length ? flags.positional : DEFAULT_ROOTS;
  const files = collectFiles(roots.map((r) => path.resolve(r)));
  const entries = [];
  const sidecar = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const result = fingerprintSource(file, text, {
      resolveSpecifiers: flags.resolve,
      resolver: resolveReal,
    });
    entries.push([file, result.hash]);
    if (flags.resolve) {
      sidecar.push([
        file,
        {
          skeleton: result.skeleton ?? result.hash,
          targets: result.targets ?? null,
        },
      ]);
    }
  }
  writeJson(flags.out, {
    meta: { mode: flags.resolve ? 'resolve-specifiers' : 'plain', roots },
    files: sortedObject(entries),
  });
  if (flags.resolve)
    writeJson(`${flags.out}.specifiers.json`, sortedObject(sidecar));
  console.log(`${files.length} files fingerprinted -> ${flags.out}`);
}

function readSidecar(file) {
  const sidecarPath = `${file}.specifiers.json`;
  return fs.existsSync(sidecarPath) ? readJson(sidecarPath) : null;
}

function cmdCompare(flags) {
  const [oldPath, newPath] = flags.positional;
  if (!oldPath || !newPath) die('compare needs <old.json> <new.json>');
  const oldSnap = readJson(oldPath);
  const newSnap = readJson(newPath);
  const map = flags['move-map'] ? readJson(flags['move-map']) : {};
  const oldSide = readSidecar(oldPath);
  const newSide = readSidecar(newPath);
  const useSidecar = Boolean(flags['move-map'] && oldSide && newSide);
  const mapTarget = (target) => map[target] ?? target;

  const oldFiles = new Map();
  for (const [file, hash] of Object.entries(oldSnap.files)) {
    const mapped = map[file] ?? file;
    if (oldFiles.has(mapped)) die(`move map sends two old files to ${mapped}`);
    oldFiles.set(mapped, { original: file, hash });
  }
  const changed = [];
  const added = [];
  const removed = [];
  for (const [file, entry] of oldFiles) {
    const newHash = newSnap.files[file];
    if (newHash === undefined) {
      removed.push(file);
      continue;
    }
    let same;
    if (useSidecar) {
      const o = oldSide[entry.original];
      const n = newSide[file];
      same =
        Boolean(o && n) &&
        o.skeleton === n.skeleton &&
        JSON.stringify((o.targets ?? []).map(mapTarget)) ===
          JSON.stringify(n.targets ?? []);
    } else {
      same = entry.hash === newHash;
    }
    if (!same) changed.push(file);
  }
  for (const file of Object.keys(newSnap.files)) {
    if (!oldFiles.has(file)) added.push(file);
  }
  const print = (title, list) => {
    console.log(`${title}:${list.length ? '' : ' (none)'}`);
    for (const item of list.sort()) console.log(`  ${item}`);
  };
  print('changed', changed);
  print('added', added);
  print('removed', removed);
  console.log(
    `summary: ${changed.length} changed, ${added.length} added, ${removed.length} removed, ${oldFiles.size - removed.length - changed.length} identical`,
  );
  process.exit(changed.length || added.length || removed.length ? 1 : 0);
}

function declName(statement) {
  if (ts.isVariableStatement(statement)) {
    const names = [];
    for (const d of statement.declarationList.declarations)
      bindingNames(d.name, names);
    return names.length ? names.join(',') : '<anonymous>';
  }
  if (statement.name) {
    return ts.isIdentifier(statement.name) || ts.isStringLiteral(statement.name)
      ? statement.name.text
      : '<anonymous>';
  }
  return '<anonymous>';
}

function isImportLike(statement) {
  return ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement);
}

function declarationsOf(file, text, options) {
  const sf = parse(file, text);
  if (sf.parseDiagnostics?.length) {
    return [
      {
        hash: sha256(`PARSE_ERROR\n${text}`),
        name: '<parse-error>',
        kind: 'SourceFile',
      },
    ];
  }
  const out = [];
  for (const statement of sf.statements) {
    if (isImportLike(statement) || isVacuous(statement)) continue;
    const { lines, specs } = serializeNode(sf, statement, {
      mode: options.resolve ? 'marker' : 'text',
      dropRootModifiers: true,
    });
    let body = lines.join('\n');
    if (options.resolve) {
      const absolute = path.join(REPO_ROOT, file);
      const targets = specs.map((spec) => options.resolver(spec, absolute));
      body = body.replace(/\0(\d+)\0/g, (_, i) =>
        JSON.stringify(targets[Number(i)]),
      );
    }
    out.push({
      hash: sha256(body),
      name: declName(statement),
      kind: kindName(statement.kind),
    });
  }
  return out;
}

function cmdSnapshotDecls(flags) {
  if (!flags.out) die('snapshot-decls needs --out <file.json>');
  const roots = flags.positional.length ? flags.positional : DEFAULT_ROOTS;
  const files = collectFiles(roots.map((r) => path.resolve(r)));
  const byHash = {};
  let count = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const decl of declarationsOf(file, text, {
      resolve: flags.resolve,
      resolver: resolveReal,
    })) {
      (byHash[decl.hash] ??= []).push({
        file,
        name: decl.name,
        kind: decl.kind,
      });
      count++;
    }
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  for (const list of Object.values(byHash)) {
    list.sort(
      (a, b) =>
        cmp(a.file, b.file) || cmp(a.name, b.name) || cmp(a.kind, b.kind),
    );
  }
  writeJson(flags.out, {
    meta: { mode: flags.resolve ? 'resolve-specifiers' : 'plain', roots },
    decls: sortedObject(Object.entries(byHash)),
  });
  console.log(`${count} declarations in ${files.length} files -> ${flags.out}`);
}

function cmdCompareDecls(flags) {
  const [oldPath, newPath] = flags.positional;
  if (!oldPath || !newPath) die('compare-decls needs <old.json> <new.json>');
  const oldDecls = readJson(oldPath).decls;
  const newDecls = readJson(newPath).decls;
  const label = (e) => `${e.file}#${e.name} (${e.kind})`;
  const onlyOld = [];
  const onlyNew = [];
  const moved = [];
  for (const hash of new Set([
    ...Object.keys(oldDecls),
    ...Object.keys(newDecls),
  ])) {
    const o = oldDecls[hash] ?? [];
    const n = newDecls[hash] ?? [];
    if (o.length > n.length)
      onlyOld.push(`${o.length - n.length}x ${o.map(label).join(' | ')}`);
    if (n.length > o.length)
      onlyNew.push(`${n.length - o.length}x ${n.map(label).join(' | ')}`);
    const oldFiles = o.map((e) => e.file).sort();
    const newFiles = n.map((e) => e.file).sort();
    if (
      o.length &&
      n.length &&
      JSON.stringify(oldFiles) !== JSON.stringify(newFiles)
    ) {
      moved.push(
        `${o[0].name}: ${oldFiles.join(',')} -> ${newFiles.join(',')}`,
      );
    }
  }
  const print = (title, list) => {
    console.log(`${title}:${list.length ? '' : ' (none)'}`);
    for (const item of list.sort()) console.log(`  ${item}`);
  };
  print('only in old (missing or fewer copies in new)', onlyOld);
  print('only in new (added or more copies than old)', onlyNew);
  print('moved (information only)', moved);
  console.log(
    `summary: ${onlyOld.length} only-old, ${onlyNew.length} only-new, ${moved.length} moved`,
  );
  process.exit(onlyOld.length || onlyNew.length ? 1 : 0);
}

// ---------------------------------------------------------------- same-body

function findTarget(sf, name) {
  for (const statement of sf.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return { node: statement, dropRootModifiers: true };
    }
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
          let init = d.initializer;
          while (ts.isParenthesizedExpression(init)) init = init.expression;
          if (
            ts.isArrowFunction(init) ||
            ts.isFunctionExpression(init) ||
            ts.isClassExpression(init)
          ) {
            return { node: init, dropRootModifiers: false };
          }
        }
      }
    }
  }
  return null;
}

function renamedLines(spec) {
  const [file, name] = spec.split('#');
  if (!file || !name) die(`bad target ${spec}; use <file>#<name>`);
  const absolute = path.resolve(file);
  const text = fs.readFileSync(absolute, 'utf8');
  return renamedLinesFromSource(path.basename(absolute), text, name, spec);
}

function renamedLinesFromSource(file, text, name, label) {
  const sf = parse(file, text);
  const target = findTarget(sf, name);
  if (!target) die(`${label}: no top-level function/class named ${name}`);
  return serializeNode(sf, target.node, {
    mode: 'text',
    rename: true,
    selfName: name,
    dropRootModifiers: target.dropRootModifiers,
  }).lines;
}

function lineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 25_000_000) {
    const first = a.findIndex((line, i) => line !== b[i]);
    return [
      `  (too large for a full diff; first difference at line ${first + 1})`,
    ];
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

function compareBodies(specs, linesList) {
  const base = linesList[0];
  let same = true;
  for (let k = 1; k < linesList.length; k++) {
    const other = linesList[k];
    if (
      base.length === other.length &&
      base.every((line, i) => line === other[i])
    )
      continue;
    same = false;
    console.log(`--- ${specs[0]}`);
    console.log(`+++ ${specs[k]}`);
    for (const line of lineDiff(base, other)) console.log(line);
  }
  console.log(same ? 'IDENTICAL' : 'DIFFERENT');
  return same;
}

function cmdSameBody(flags) {
  if (flags.positional.length < 2)
    die('same-body needs at least two <file>#<name> targets');
  const same = compareBodies(
    flags.positional,
    flags.positional.map(renamedLines),
  );
  process.exit(same ? 0 : 1);
}

/** Debug aid: `dump <file> [<file2>]` prints the canonical lines, or their diff. */
function cmdDump(flags) {
  const load = (file) => {
    const sf = parse(file, fs.readFileSync(file, 'utf8'));
    return serializeNode(sf, sf, { mode: 'text' }).lines;
  };
  const [a, b] = flags.positional.map(load);
  if (!b) console.log(a.join('\n'));
  else for (const line of lineDiff(a, b)) console.log(line);
}

// ----------------------------------------------------------------- self-test

function selfTest() {
  let failures = 0;
  const check = (ok, message) => {
    if (!ok) {
      failures++;
      console.error(`FAIL: ${message}`);
    } else {
      console.log(`ok: ${message}`);
    }
  };
  const fp = (src, file = 'x.ts') => fingerprintSource(file, src).hash;
  const same = (a, b, message) => check(fp(a) === fp(b), `same: ${message}`);
  const diff = (a, b, message) => check(fp(a) !== fp(b), `differs: ${message}`);

  same(`const a = 'x';`, `const a = "x"`, 'quote style and semicolon');
  same(`const a = 'it\\'s';`, `const a = "it's";`, 'string escape spelling');
  same(
    `const a = (1 + 2) * 3;`,
    `const a = ((1 + 2)) * 3`,
    'redundant parentheses',
  );
  same(`f(a, b,);`, `f(a, b);`, 'trailing comma in call');
  same(
    `const o = {a: 1, b: 2,};`,
    `const o = {\n  a: 1,\n  b: 2\n};`,
    'object layout and trailing comma',
  );
  same(`// c\nconst a = 1; /* d */`, `const a = 1;`, 'comments');
  same(
    `const a = 1;\n\n\nconst b = 2;`,
    `const a = 1;\nconst b = 2;`,
    'blank lines',
  );
  same(
    `const o = {'a': 1, "b-c": 2, 1: 3};`,
    `const o = {a: 1, 'b-c': 2, '1': 3};`,
    'quoted vs unquoted keys',
  );
  same(
    `const o = {1.0: 1};`,
    `const o = {'1': 1};`,
    'numeric key normalization',
  );
  same(
    `const f = x => x;`,
    `const f = (x) => x;`,
    'arrow parameter parentheses',
  );
  same(
    `const n = 0XFF + 1_000 + .5;`,
    `const n = 0xff + 1000 + 0.5;`,
    'numeric literal spelling',
  );
  same(`const o = new Foo;`, `const o = new Foo();`, 'new without arguments');
  same(
    `const t = \`a\${x}b\`;`,
    `const t = \`a\${ x }b\`;`,
    'template substitution spacing',
  );
  same(
    `for (const a of b) {}`,
    `for (const a of b) { }`,
    'empty block spacing',
  );

  diff(`const a = 'x';`, `const a = 'y';`, 'string value');
  diff('const q = `a b`;', 'const q = `a  b`;', 'template whitespace');
  diff('const q = `a\n`;', 'const q = `a\n `;', 'template trailing whitespace');
  diff(`f(a, b);`, `f(b, a);`, 'argument order');
  diff(`const a = x + y;`, `const a = x - y;`, 'operator');
  diff(`const a = x;`, `const b = x;`, 'identifier rename');
  same(
    `type T = typeof A[number];`,
    `type T = (typeof A)[number];`,
    'parenthesized type',
  );
  same(
    `function f() { g();; }`,
    `function f() { g(); }`,
    'vacuous empty statement',
  );
  diff(`if (a);`, `if (a) {}`, 'empty statement as if body');
  diff(`const a = 1;`, `let a = 1;`, 'const vs let');
  diff(`const a = 1;`, `const a = 2;`, 'number value');
  diff(`const a = b.c;`, `const a = b?.c;`, 'optional chain');
  diff(
    `const a = (b?.c).d;`,
    `const a = b?.c.d;`,
    'parenthesized optional chain',
  );
  diff(`const a = !x;`, `const a = ~x;`, 'prefix operator');
  diff(
    `const a = x ?? (y || z);`,
    `const a = (x ?? y) || z;`,
    'precedence grouping',
  );
  diff(
    `import type { A } from 'a';`,
    `import { A } from 'a';`,
    'type-only import',
  );
  diff(`'use strict';`, `('use strict');`, 'directive vs parenthesized string');

  const sameBody = (a, b) => {
    const l = (src) => renamedLinesFromSource('s.ts', src, 'f', 'self-test');
    const la = l(a);
    const lb = l(b);
    return la.length === lb.length && la.every((x, i) => x === lb[i]);
  };
  check(
    sameBody(
      `function f(a, b) { const t = a + b; return helper(t); }`,
      `function f(x, y) { const sum = x + y; return helper(sum); }`,
    ),
    'same-body: local renames are IDENTICAL',
  );
  check(
    !sameBody(
      `function f(a, b) { const t = a + b; return helper(t); }`,
      `function f(a, b) { const t = a + b; return other(t); }`,
    ),
    'same-body: different free reference is DIFFERENT',
  );
  check(
    !sameBody(
      `function f(a) { { const b = 1; } return b; }`,
      `function f(a) { { const c = 1; } return c; }`,
    ),
    'same-body: out-of-scope reference to different outer names is DIFFERENT',
  );
  check(
    !sameBody(
      `function f(a) { return a.length; }`,
      `function f(a) { return a.size; }`,
    ),
    'same-body: property names are not renamed',
  );
  check(
    sameBody(
      `const f = async (a) => { try { await a(); } catch (e) { throw e; } };`,
      `const f = async (z) => { try { await z(); } catch (err) { throw err; } };`,
    ),
    'same-body: arrow and catch bindings renamed',
  );
  check(
    sameBody(
      `function f(n) { return n ? f(n - 1) : 0; }`,
      `function f(m) { return m ? f(m - 1) : 0; }`,
    ) &&
      !sameBody(
        `function f(n) { return n ? f(n - 1) : 0; }`,
        `function f(n) { return n ? g(n - 1) : 0; }`,
      ),
    'same-body: self recursion is local, other calls are free',
  );

  const options = loadCompilerOptions();
  const files = new Set(['/v/x.ts', '/v/y.ts', '/v/a/b.ts']);
  const dirs = new Set(['/', '/v', '/v/a']);
  const resolver = makeResolver({
    root: '/v',
    options,
    host: {
      fileExists: (p) => files.has(p),
      directoryExists: (p) => dirs.has(p),
      readFile: () => undefined,
      realpath: (p) => p,
      getCurrentDirectory: () => '/v',
      useCaseSensitiveFileNames: true,
    },
    realpath: (p) => p,
  });
  const rfp = (src) =>
    fingerprintSource('/v/a/b.ts', src, { resolveSpecifiers: true, resolver });
  const a = rfp(
    `import { x } from '../x.ts'; export const q = import('../x.ts');`,
  );
  const b = rfp(
    `import { x } from "../a/../x.ts"; export const q = import("./../x.ts");`,
  );
  const c = rfp(
    `import { x } from '../y.ts'; export const q = import('../x.ts');`,
  );
  check(
    a.hash === b.hash,
    'resolve-specifiers: equivalent specifiers to the same file are equal',
  );
  check(
    a.hash !== c.hash,
    'resolve-specifiers: a specifier resolving elsewhere differs',
  );
  check(
    a.skeleton === c.skeleton && a.targets[0] !== c.targets[0],
    'resolve-specifiers: skeleton equal, targets differ',
  );
  check(
    JSON.stringify(a.targets) === JSON.stringify(['x.ts', 'x.ts']),
    `resolve-specifiers: targets resolve to repo-relative files (${JSON.stringify(a.targets)})`,
  );
  check(
    fingerprintSource('x.ts', `import 'a';`).hash !==
      fingerprintSource('x.ts', `import 'b';`).hash,
    'plain mode: specifier text matters',
  );

  const declA = declarationsOf(
    'x.ts',
    `export function f(){return 1}\nimport {a} from 'a';\nexport { f };`,
    {},
  );
  const declB = declarationsOf('x.ts', `function f() { return 1; }`, {});
  check(
    declA.length === 1 &&
      declA[0].hash === declB[0].hash &&
      declA[0].name === 'f',
    'decls: export modifier and import/export lists are ignored',
  );

  if (failures) {
    console.error(`${failures} self-test failure(s)`);
    process.exit(1);
  }
  console.log('self-test passed');
}

// ---------------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2);
if (command === '--self-test') selfTest();
else {
  const flags = parseArgs(rest);
  switch (command) {
    case 'snapshot':
      cmdSnapshot(flags);
      break;
    case 'compare':
      cmdCompare(flags);
      break;
    case 'snapshot-decls':
      cmdSnapshotDecls(flags);
      break;
    case 'compare-decls':
      cmdCompareDecls(flags);
      break;
    case 'same-body':
      cmdSameBody(flags);
      break;
    case 'dump':
      cmdDump(flags);
      break;
    default:
      die(
        'usage: ast-fingerprint.mjs snapshot|compare|snapshot-decls|compare-decls|same-body|--self-test (see file header)',
      );
  }
}
