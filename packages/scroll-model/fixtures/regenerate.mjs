// Recompiles the labelled fixtures: <name>.draft.json + <name>.provenance.json → <name>.document.json
// and <name>.internal.json, using the built package (run `pnpm --filter @knowscroll/scroll-model
// fixtures`, which builds first). The fixtures test asserts the committed outputs equal a fresh
// compile, so a change to compile, measures or hashing shows up as a reviewed fixture diff.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDraft } from '../dist/producer/index.js';

const directory = dirname(fileURLToPath(import.meta.url));
const names = ['attention-slowly', 'weight-other-worlds', 'spring-neap-tides'];
const read = (file) => JSON.parse(readFileSync(join(directory, file), 'utf8'));

let failed = false;
for (const name of names) {
  const outcome = compileDraft(read(`${name}.draft.json`), read(`${name}.provenance.json`));
  if (outcome.kind !== 'compiled') {
    failed = true;
    process.stderr.write(`${name}: refused at ${outcome.stage}\n${JSON.stringify(outcome.issues, null, 2)}\n`);
    continue;
  }
  writeFileSync(join(directory, `${name}.document.json`), `${JSON.stringify(outcome.document, null, 2)}\n`);
  writeFileSync(join(directory, `${name}.internal.json`), `${JSON.stringify(outcome.internalProvenance, null, 2)}\n`);
  process.stdout.write(`${name}: ${outcome.document.integrity.sha256}\n`);
}
process.exitCode = failed ? 1 : 0;
