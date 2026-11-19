// Writes documents/{fence,seasons,broad-street}-v3-ci.json: the three hand-written `scroll-document.v3` fixtures,
// compiled from their editorial sources at revision 1, for the reader's tests, the gallery and screenshots. They are
// labelled (kicker "Fixture") and are imported into dev only (#759, decision K). The sources are data in the backend's
// content module; this script reads them as JSON and compiles them with this package's own compile. Run it with the
// built package:
//   pnpm --filter @knowscroll/scroll-model build && node packages/scroll-model/fixtures/regenerate-v3.mjs
// A backend test compiles each source again and checks it equals the committed file, so the two never drift.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileEditorialV3 } from '@knowscroll/scroll-model/producer';

const directory = dirname(fileURLToPath(import.meta.url));
const sources = join(directory, '../../backend/src/modules/content/fixtures/document-v3');

for (const name of ['fence', 'seasons', 'broad-street']) {
  const source = JSON.parse(readFileSync(join(sources, `${name}.editorial-scroll-v3.json`), 'utf8'));
  const compiled = compileEditorialV3({
    authored: source.scroll,
    publication: {
      assetId: source.assetId,
      revision: 1,
      language: source.language,
      explanationUnitId: source.explanationUnitId,
    },
    claims: source.claims,
    sources: source.sources,
    production: { kind: 'authored-editorial', reference: source.reference },
  });
  if (compiled.kind !== 'compiled') throw new Error(`${name}: ${compiled.stage} ${JSON.stringify(compiled.issues)}`);
  writeFileSync(join(directory, 'documents', `${name}-v3-ci.json`), `${JSON.stringify(compiled.document, null, 2)}\n`);
  console.log(`${name}-v3-ci.json`, compiled.document.integrity.sha256);
}
