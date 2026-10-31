#!/usr/bin/env node
// `pnpm boundaries:probe`: proves the dependency-cruiser rules bite. Writes a set of deliberately
// forbidden imports into the working tree (paths that must not exist yet), cruises only those
// files, checks that every probe edge is rejected by the expected rule, and removes the files
// again whatever happens. Run from the repository root (CI `static` job).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';

const B = 'packages/backend/src';
const wire = `${B}/modules/content/adapters/cutroom/wire-v1/errors.ts`;

/**
 * What the play wall (D-063) is for: the modules that rank, plan, remember or form places from what a
 * person does, and the reasoning engine they call. `jev` is part of composer today; it is named in
 * case it becomes a module of its own.
 */
const playWalled = ['composer', 'jev', 'planner', 'evidence', 'personal-context', 'geography', 'scenes'];
/**
 * Modules the wall does not name, which an allow-list must stop all the same: `planner` imports
 * `supply`, so planner to supply to play is a path nobody wrote on a list.
 */
const playOthers = ['supply', 'social', 'rooms'];
/** Every folder whose public surface play must not import, and whose code must not import play. */
const playFolders = [
  ...playWalled.map((name) => `modules/${name}`),
  'reasoning',
  ...playOthers.map((name) => `modules/${name}`),
];
/**
 * The wall around a pick on a thread's call (D-156) is the same allow-list: Social stores it, so no module that is
 * not on the rule's short list may import Social. One forbidden import from every walled module, the reasoning
 * engine, and the modules a deny-list would forget (supply, play and the three Play depends on).
 */
const socialForbidden = [
  ...playWalled.map((name) => `modules/${name}`),
  'reasoning',
  'modules/supply',
  'modules/play',
  'modules/identity',
  'modules/content',
  'modules/experience',
];
const importsSocial = 'thread-pick-wall-only-listed-modules-import-social';
const importsPlay = 'play-wall-only-roots-import-play';
const playImports = 'play-wall-play-imports-three-public-surfaces';

/** Each probe file and the edges it must produce, with the rule that must reject each edge. */
const probes = [
  // Production's root protocol may import framework-free capability types, never runtime grants.
  {
    file: `${B}/infrastructure/zz-probe-production.ts`,
    source:
      "import { PRODUCTION_REASONING_HARNESS } from '../reasoning/public.js';\nexport const p = PRODUCTION_REASONING_HARNESS;\n",
    expect: [
      [`${B}/reasoning/public.ts`, 'production-protocol-public-types-only'],
      [`${B}/reasoning/public.ts`, 'production-protocol-only'],
    ],
  },
  {
    file: `${B}/infrastructure/zz-probe-production-type.ts`,
    source:
      "import type { ProductionAuthority } from '../reasoning/public.js';\nexport type P = ProductionAuthority;\n",
    expect: [[`${B}/reasoning/public.ts`, 'production-protocol-only']],
  },
  // M1: imports into the vendored wire schema are checked (it is a leaf, not excluded).
  {
    file: `${B}/modules/content/application/zz-probe.ts`,
    source: "import * as w from '../adapters/cutroom/wire-v1/errors.js';\nexport const p = w;\n",
    expect: [[wire, 'application-allowlist']],
  },
  {
    file: `${B}/modules/zz-probe-geography/application/wire.ts`,
    source: "import * as w from '../../content/adapters/cutroom/wire-v1/errors.js';\nexport const p = w;\n",
    expect: [[wire, 'cross-module-through-public']],
  },
  {
    file: 'apps/client/theme/zz-probe.ts',
    source:
      "import * as w from '../../../packages/backend/src/modules/content/adapters/cutroom/wire-v1/errors.js';\nexport const p = w;\n",
    expect: [[wire, 'clients-never-import-backend']],
  },
  // M2: a generic package at the top level.
  { file: 'packages/shared/index.ts', source: 'export const shared = 1;\n', expect: [] },
  {
    file: 'packages/common/index.ts',
    source: "import { shared } from '../shared/index.js';\nexport const common = shared;\n",
    expect: [['packages/shared/index.ts', 'no-generic-folders']],
  },
  // M3: a client package importing backend code (client-core exists since S1.4, so the probe is a
  // new file inside it rather than the whole package).
  {
    file: 'packages/client-core/src/zz-probe-backend.ts',
    source:
      "import { readApiConfig } from '../../backend/src/infrastructure/config/index.js';\nexport const c = readApiConfig;\n",
    expect: [[`${B}/infrastructure/config/index.ts`, 'clients-never-import-backend']],
  },
  // M4 and M5: a module whose public.ts leaks an adapter and Kysely, and an app reaching inside it.
  {
    file: `${B}/modules/zz-probe-geography/adapters/postgres-store.ts`,
    source: "import { sql } from 'kysely';\nexport const store = sql`select 1`;\n",
    expect: [],
  },
  {
    file: `${B}/modules/zz-probe-geography/domain/model.ts`,
    source: "import { randomUUID } from 'node:crypto';\nexport const model = randomUUID;\n",
    expect: [['node:crypto', 'domain-is-pure']],
  },
  {
    file: `${B}/modules/zz-probe-geography/public.ts`,
    source:
      "import { Kysely } from 'kysely';\nexport { store } from './adapters/postgres-store.js';\nexport const k = Kysely;\n",
    expect: [
      [`${B}/modules/zz-probe-geography/adapters/postgres-store.ts`, 'public-surface-is-framework-free'],
      ['kysely', 'public-surface-is-framework-free'],
    ],
  },
  {
    file: 'apps/api/src/http/zz-probe.controller.ts',
    source:
      "import { store } from '../../../../packages/backend/src/modules/zz-probe-geography/adapters/postgres-store.js';\nimport { model } from '../../../../packages/backend/src/modules/zz-probe-geography/domain/model.js';\nexport const p = [store, model];\n",
    expect: [
      [`${B}/modules/zz-probe-geography/adapters/postgres-store.ts`, 'apps-reach-modules-through-public-or-wiring'],
      [`${B}/modules/zz-probe-geography/domain/model.ts`, 'apps-reach-modules-through-public-or-wiring'],
    ],
  },
  // M6: application importing Node I/O, a provider-style client, infrastructure and Kysely.
  {
    file: `${B}/infrastructure/zz-probe-media-store/vps.ts`,
    source: "import { writeFileSync } from 'node:fs';\nexport const upload = writeFileSync;\n",
    expect: [],
  },
  {
    file: `${B}/modules/zz-probe-planning/application/use.ts`,
    source:
      "import { request } from 'node:http';\nimport { sql } from 'kysely';\nimport { upload } from '../../../infrastructure/zz-probe-media-store/vps.js';\nexport const use = [request, sql, upload];\n",
    expect: [
      ['node:http', 'application-allowlist'],
      ['kysely', 'application-allowlist'],
      [`${B}/infrastructure/zz-probe-media-store/vps.ts`, 'application-allowlist'],
    ],
  },
  // Anchored composition roots: a file merely named like one is not a root.
  {
    file: `${B}/modules/zz-probe-geography/adapters/nest-providers.ts`,
    source: 'export const providers = [];\n',
    expect: [],
  },
  {
    file: 'apps/worker/src/jobs-zz-probe.ts',
    source:
      "import { providers } from '../../../packages/backend/src/modules/zz-probe-geography/adapters/nest-providers.js';\nexport const p = providers;\n",
    expect: [
      [`${B}/modules/zz-probe-geography/adapters/nest-providers.ts`, 'nest-providers-only-in-composition-roots'],
    ],
  },
  // S2.1: Scroll provenance and the producer contract stay backend-only; scroll-model stays portable.
  {
    file: 'apps/client/theme/zz-probe-scroll.ts',
    source:
      "import { ScrollProvenance } from '../../../packages/scroll-model/src/internal/index.js';\nexport const p = ScrollProvenance;\n",
    expect: [['packages/scroll-model/src/internal/index.ts', 'clients-never-import-scroll-internals']],
  },
  {
    file: 'apps/client/theme/zz-probe-scroll-name.ts',
    source:
      "import { compileDraft } from '@knowscroll/scroll-model/producer';\nimport { honestyIssues } from '@knowscroll/scroll-model/internal';\nimport internal from '../../../packages/scroll-model/fixtures/producer/weight-other-worlds.internal.json';\nexport const p = [compileDraft, honestyIssues, internal];\n",
    // `apps/client` declares scroll-model (S1.6), so the specifiers resolve to its sources.
    expect: [
      ['packages/scroll-model/src/producer/index.ts', 'clients-never-import-scroll-internals'],
      ['packages/scroll-model/src/internal/index.ts', 'clients-never-import-scroll-internals'],
      [
        'packages/scroll-model/fixtures/producer/weight-other-worlds.internal.json',
        'clients-never-import-scroll-producer-fixtures',
      ],
    ],
  },
  {
    file: 'packages/ui/src/zz-probe.ts',
    source:
      "import { ScrollProvenance } from '@knowscroll/scroll-model/internal';\nimport { compileDraft } from '@knowscroll/scroll-model/producer';\nexport const p = [ScrollProvenance, compileDraft];\n",
    // `packages/ui` declares scroll-model (S2.1 part 2), so the specifiers resolve to its sources.
    expect: [
      ['packages/scroll-model/src/internal/index.ts', 'clients-never-import-scroll-internals'],
      ['packages/scroll-model/src/producer/index.ts', 'clients-never-import-scroll-internals'],
    ],
  },
  {
    file: 'apps/client/theme/zz-probe-scroll-admission.ts',
    source: "import { admitDocument } from '@knowscroll/scroll-model/admission';\nexport const p = admitDocument;\n",
    // The app declares scroll-model now; package and relative imports both resolve to the source.
    // Separate probe files prove each form independently instead of expecting duplicate graph edges.
    expect: [['packages/scroll-model/src/admission/index.ts', 'clients-never-import-scroll-admission']],
  },
  {
    file: 'apps/client/theme/zz-probe-scroll-admission-relative.ts',
    source:
      "import { admitBlock } from '../../../packages/scroll-model/src/admission/index.js';\nexport const p = admitBlock;\n",
    expect: [['packages/scroll-model/src/admission/index.ts', 'clients-never-import-scroll-admission']],
  },
  {
    file: 'packages/ui/src/zz-probe-admission.ts',
    source:
      "import { validateDocument } from '@knowscroll/scroll-model/admission';\nexport const p = validateDocument;\n",
    // `packages/ui` and `packages/client-core` declare scroll-model (S2.1 part 2), so the specifier
    // resolves to its sources, as the producer and internal probes above do.
    expect: [['packages/scroll-model/src/admission/index.ts', 'clients-never-import-scroll-admission']],
  },
  {
    file: 'packages/client-core/src/zz-probe-admission.ts',
    source: "import { admitDocument } from '@knowscroll/scroll-model/admission';\nexport const p = admitDocument;\n",
    expect: [['packages/scroll-model/src/admission/index.ts', 'clients-never-import-scroll-admission']],
  },
  {
    file: 'packages/contracts/src/zz-probe.ts',
    source: "import { honestyIssues } from '@knowscroll/scroll-model/internal';\nexport const p = honestyIssues;\n",
    expect: [['packages/scroll-model/src/internal/index.ts', 'contracts-are-wire-only']],
  },
  {
    file: 'packages/scroll-model/src/zz-probe.ts',
    source:
      "import { readFileSync } from 'node:fs';\nimport fc from 'fast-check';\nimport { compileDraft } from './producer/index.js';\nimport { admitDocument } from './admission/index.js';\nexport const p = [readFileSync, fc, compileDraft, admitDocument];\n",
    expect: [
      ['node:fs', 'scroll-model-is-portable'],
      ['fast-check', 'scroll-model-depends-on-zod-only'],
      ['packages/scroll-model/src/producer/index.ts', 'scroll-model-public-entry-is-self-contained'],
      ['packages/scroll-model/src/admission/index.ts', 'scroll-model-public-entry-is-self-contained'],
    ],
  },
  // A module reaches the reasoning engine only through reasoning/public.ts: not its application
  // code, its ledger adapter or its composition wiring (it could build its own harness around the
  // harness's admission, budgets and ledger).
  {
    file: `${B}/modules/zz-probe-planning/application/zz-reasoning.ts`,
    source:
      "import { makeAttemptLedger } from '../../../reasoning/adapters/postgres-ledger.js';\nimport { makeReasoningHarness } from '../../../reasoning/application/propose.js';\nimport { reasoningProviders } from '../../../reasoning/adapters/nest-providers.js';\nexport const p = [makeAttemptLedger, makeReasoningHarness, reasoningProviders];\n",
    expect: [
      [`${B}/reasoning/adapters/postgres-ledger.ts`, 'cross-module-through-public'],
      [`${B}/reasoning/application/propose.ts`, 'cross-module-through-public'],
      [`${B}/reasoning/adapters/nest-providers.ts`, 'cross-module-through-public'],
      [`${B}/reasoning/adapters/nest-providers.ts`, 'nest-providers-only-in-composition-roots'],
    ],
  },
  // An app reaches the reasoning engine only through its public.ts or, from a composition root,
  // its nest-providers.
  {
    file: 'apps/api/src/http/zz-probe-reasoning.controller.ts',
    source:
      "import { makeAttemptLedger } from '../../../../packages/backend/src/reasoning/adapters/postgres-ledger.js';\nexport const p = makeAttemptLedger;\n",
    expect: [[`${B}/reasoning/adapters/postgres-ledger.ts`, 'apps-reach-modules-through-public-or-wiring']],
  },
  // D-063, the play wall. Only play, the apps' roots, tests and the erasure registry may import play: one
  // forbidden import from every module and from the reasoning engine ...
  ...playFolders.map((folder) => ({
    file: `${B}/${folder}/application/zz-probe-play.ts`,
    source: `import * as play from '${posix.relative(`${B}/${folder}/application`, `${B}/modules/play/public.js`)}';\nexport const probe = play;\n`,
    expect: [[`${B}/modules/play/public.ts`, importsPlay]],
  })),
  // ... and play may import only the public surfaces of identity, content and experience: one forbidden
  // import of every other public surface, the reasoning engine's included. `jev` has no folder yet, so
  // the probe makes the public surface it would have.
  {
    file: `${B}/modules/jev/public.ts`,
    source: 'export const jev = 1;\n',
    expect: [],
  },
  ...playFolders.map((folder) => ({
    file: `${B}/modules/play/application/zz-probe-${folder.replace('modules/', '')}.ts`,
    source: `import * as surface from '${posix.relative(`${B}/modules/play/application`, `${B}/${folder}/public.js`)}';\nexport const probe = surface;\n`,
    expect: [[`${B}/${folder}/public.ts`, playImports]],
  })),
  // D-156: only Social and the three modules that already use its reads (feedback, rooms, scenarios) import Social ...
  ...socialForbidden.map((folder) => ({
    file: `${B}/${folder}/application/zz-probe-social.ts`,
    source: `import * as social from '${posix.relative(`${B}/${folder}/application`, `${B}/modules/social/public.js`)}';
export const probe = social;
`,
    expect: [[`${B}/modules/social/public.ts`, importsSocial]],
  })),
  // Apps never import each other; no cycles.
  {
    file: 'apps/api/src/zz-probe-cross-app.ts',
    source: "import { jobConsumers } from '../../worker/src/jobs.js';\nexport const p = jobConsumers;\n",
    expect: [['apps/worker/src/jobs.ts', 'apps-never-import-each-other']],
  },
  {
    file: `${B}/infrastructure/zz-probe-cycle/a.ts`,
    source: "import { b } from './b.js';\nexport const a = () => b;\n",
    expect: [[`${B}/infrastructure/zz-probe-cycle/b.ts`, 'no-circular']],
  },
  {
    file: `${B}/infrastructure/zz-probe-cycle/b.ts`,
    source: "import { a } from './a.js';\nexport const b = () => a;\n",
    expect: [],
  },
];

const createdDirectories = [
  `${B}/modules/zz-probe-geography`,
  `${B}/modules/zz-probe-planning`,
  `${B}/infrastructure/zz-probe-media-store`,
  `${B}/infrastructure/zz-probe-cycle`,
  `${B}/modules/jev`,
  'packages/shared',
  'packages/common',
];

for (const probe of probes) {
  if (existsSync(probe.file)) {
    console.error(`boundaries:probe: ${probe.file} already exists; refusing to overwrite it`);
    process.exit(2);
  }
}
for (const directory of createdDirectories) {
  if (existsSync(directory)) {
    console.error(`boundaries:probe: ${directory} already exists; refusing to touch it`);
    process.exit(2);
  }
}

/** Runs dependency-cruiser over the probe files with a config; the violations it finds. */
function cruise(config, files) {
  const run = spawnSync('pnpm', ['exec', 'depcruise', '--config', config, '--output-type', 'json', ...files], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.stdout === '') throw new Error(`depcruise produced no output: ${run.stderr}`);
  return JSON.parse(run.stdout).summary.violations;
}

/**
 * `node:x` matches the core module `x`; a bare package name matches its resolved node_modules
 * path, or itself when it is a workspace specifier the importer cannot resolve.
 */
const targetMatches = (actual, expected) =>
  expected.startsWith('node:')
    ? actual === expected.slice(5)
    : /^(?:packages|apps|migrations|tests)\//.test(expected)
      ? actual === expected
      : actual === expected || actual.includes(`/node_modules/${expected}/`);

const rejects = (found, probe, [to, rule]) =>
  found.some(
    (violation) => violation.from === probe.file && violation.rule.name === rule && targetMatches(violation.to, to),
  );

/**
 * A copy of the real config with some rules loosened: `pathNot` entries added to one side of a rule.
 * Written next to the real config so its relative `require` resolves; removed with the probe files.
 */
const loosened = '.dependency-cruiser.zz-probe.cjs';
function loosenedConfig(adds) {
  writeFileSync(
    loosened,
    `const base = require('./.dependency-cruiser.cjs');
const adds = ${JSON.stringify(adds)};
module.exports = {
  ...base,
  forbidden: base.forbidden.map((rule) =>
    adds
      .filter((add) => add.rule === rule.name)
      .reduce(
        (changed, add) => ({
          ...changed,
          [add.side]: { ...changed[add.side], pathNot: [].concat(changed[add.side].pathNot ?? [], add.pathNot) },
        }),
        rule,
      ),
  ),
};
`,
  );
  return loosened;
}

let failed = false;
try {
  for (const probe of probes) {
    mkdirSync(dirname(probe.file), { recursive: true });
    writeFileSync(probe.file, probe.source);
  }
  const found = cruise(
    '.dependency-cruiser.cjs',
    probes.map((probe) => probe.file),
  );
  const violations = found.map((violation) => `${violation.from} → ${violation.to} [${violation.rule.name}]`);
  for (const probe of probes) {
    for (const edge of probe.expect) {
      const wanted = `${probe.file} → ${edge[0]} [${edge[1]}]`;
      if (rejects(found, probe, edge)) console.log(`rejected as expected: ${wanted}`);
      else {
        failed = true;
        console.error(`NOT REJECTED: ${wanted}`);
      }
    }
  }
  if (failed) console.error(`all violations found:\n  ${violations.join('\n  ')}`);

  // The play probes must be able to fail. Loosen the wall's rules and run the same files again: an edge a
  // loosened rule still rejects was never rejected by that rule, so the probe proves nothing.
  const wallProbes = probes.filter((probe) =>
    probe.expect.some(([, rule]) => rule === importsPlay || rule === playImports),
  );
  const wallFiles = wallProbes.map((probe) => probe.file);
  const everything = cruise(
    loosenedConfig([
      { rule: importsPlay, side: 'from', pathNot: '.' },
      { rule: playImports, side: 'from', pathNot: '.' },
    ]),
    wallFiles,
  );
  for (const probe of wallProbes)
    for (const edge of probe.expect)
      if (rejects(everything, probe, edge)) {
        failed = true;
        console.error(
          `STILL REJECTED with the wall's rules loosened (the probe cannot fail): ${probe.file} [${edge[1]}]`,
        );
      }
  // And each folder is held by the rule on its own, not by chance: loosen the rule for supply alone, and the
  // supply probe goes through while the others are still rejected.
  const supplyOnly = cruise(
    loosenedConfig([
      { rule: importsPlay, side: 'from', pathNot: `^${B}/modules/supply/` },
      { rule: playImports, side: 'to', pathNot: `^${B}/modules/supply/public\\.ts$` },
    ]),
    wallFiles,
  );
  for (const probe of wallProbes) {
    const supply = probe.file.includes('/supply/') || probe.file.endsWith('zz-probe-supply.ts');
    for (const edge of probe.expect) {
      const rejected = rejects(supplyOnly, probe, edge);
      if (rejected === supply) {
        failed = true;
        console.error(
          `${supply ? 'STILL REJECTED' : 'NOT REJECTED'} with the wall loosened for supply alone: ${probe.file} [${edge[1]}]`,
        );
      }
    }
  }
  if (!failed) console.log(`boundaries:probe: the ${wallProbes.length} play probes fail when the wall is loosened`);

  // The Social probes must be able to fail too: loosen the rule and run the same files again.
  const socialProbes = probes.filter((probe) => probe.expect.some(([, rule]) => rule === importsSocial));
  const socialLoosened = cruise(
    loosenedConfig([{ rule: importsSocial, side: 'from', pathNot: '.' }]),
    socialProbes.map((probe) => probe.file),
  );
  for (const probe of socialProbes)
    for (const edge of probe.expect)
      if (rejects(socialLoosened, probe, edge)) {
        failed = true;
        console.error(`STILL REJECTED with the Social wall loosened (the probe cannot fail): ${probe.file}`);
      }
  if (!failed) console.log(`boundaries:probe: the ${socialProbes.length} Social probes fail when the wall is loosened`);
} finally {
  for (const probe of probes) rmSync(probe.file, { force: true });
  for (const directory of createdDirectories) rmSync(directory, { recursive: true, force: true });
  rmSync(loosened, { force: true });
  rmSync('apps/client/theme/zz-probe.ts', { force: true });
  rmSync('apps/client/theme/zz-probe-scroll.ts', { force: true });
  rmSync('apps/client/theme/zz-probe-scroll-name.ts', { force: true });
  rmSync('apps/client/theme/zz-probe-scroll-admission.ts', { force: true });
}
if (failed) process.exit(1);
console.log(
  `boundaries:probe: all ${probes.reduce((count, probe) => count + probe.expect.length, 0)} forbidden edges rejected`,
);
