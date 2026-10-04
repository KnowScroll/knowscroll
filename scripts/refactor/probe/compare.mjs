#!/usr/bin/env node
// node scripts/refactor/probe/compare.mjs <old.json> <new.json>
// Prints a per-case diff of two http-surface probe outputs; exits 1 on any difference.
import { readFileSync } from 'node:fs';

const [, , oldPath, newPath] = process.argv;
if (!oldPath || !newPath) {
  console.error('usage: compare.mjs <old.json> <new.json>');
  process.exit(2);
}
const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
const a = load(oldPath);
const b = load(newPath);

const show = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? '<absent>' : text.length > 400 ? `${text.slice(0, 400)}...` : text;
};

function diff(x, y, path, out) {
  if (JSON.stringify(x) === JSON.stringify(y)) return;
  const bothObjects =
    x !== null && y !== null && typeof x === 'object' && typeof y === 'object' &&
    Array.isArray(x) === Array.isArray(y);
  if (!bothObjects) {
    out.push(`    ${path || '(root)'}: ${show(x)}  ->  ${show(y)}`);
    return;
  }
  if (Array.isArray(x)) {
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i += 1) diff(x[i], y[i], `${path}[${i}]`, out);
    return;
  }
  for (const key of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort())
    diff(x[key], y[key], path ? `${path}.${key}` : key, out);
}

let differences = 0;
const say = (line) => console.log(line);

const routesOld = a.routes ?? [];
const routesNew = b.routes ?? [];
for (const route of routesOld.filter((r) => !routesNew.includes(r))) {
  say(`ROUTE REMOVED: ${route}`);
  differences += 1;
}
for (const route of routesNew.filter((r) => !routesOld.includes(r))) {
  say(`ROUTE ADDED: ${route}`);
  differences += 1;
}

const keyOf = (c) => `${c.route} :: ${c.name}`;
const oldCases = new Map(a.cases.map((c) => [keyOf(c), c]));
const newCases = new Map(b.cases.map((c) => [keyOf(c), c]));
for (const [key, c] of oldCases) {
  if (!newCases.has(key)) {
    say(`CASE MISSING in new: ${key}`);
    differences += 1;
    continue;
  }
  const out = [];
  diff(c, newCases.get(key), '', out);
  if (out.length > 0) {
    differences += 1;
    say(`CASE DIFFERS: ${key}  [${c.request}]`);
    for (const line of out) say(line);
  }
}
for (const key of newCases.keys()) {
  if (!oldCases.has(key)) {
    say(`CASE ADDED in new: ${key}`);
    differences += 1;
  }
}
const orderOld = a.cases.map(keyOf).join('\n');
const orderNew = b.cases.map(keyOf).join('\n');
if (differences === 0 && orderOld !== orderNew) {
  say('CASE ORDER differs');
  differences += 1;
}
const metaOld = JSON.stringify(a.meta);
const metaNew = JSON.stringify(b.meta);
if (metaOld !== metaNew) {
  say(`META differs: ${metaOld} -> ${metaNew}`);
  differences += 1;
}
say(differences === 0 ? `identical (${a.cases.length} cases, ${routesOld.length} routes)` : `${differences} difference(s)`);
process.exit(differences === 0 ? 0 : 1);
