/**
 * Import boundaries of the v2 workspace (blueprint §22). Every rule is an error: `pnpm
 * boundaries` fails CI on the first violation, and `pnpm boundaries:probe` proves in CI that the
 * rules reject a set of deliberately forbidden imports. Paths are repository-relative.
 *
 * Module code lives in packages/backend/src/modules/<module>/ and the shared execution engine
 * in packages/backend/src/reasoning/; both follow the onion layout domain/ → application/ →
 * adapters/, with a framework-free public.ts (and events.ts for job/event schemas) at the root.
 */
const layered = '^packages/backend/src/(modules/[^/]+|reasoning)';
const anyLayered = '^packages/backend/src/(?:modules/[^/]+|reasoning)';
// Generic folders at the top of a package root and anywhere below it (depcruise refuses the
// single pattern `(?:.*/)?` as an unsafe regular expression, so two patterns).
const genericFolder = [
  '^(?:apps|packages|migrations|tests)/(?:shared|utils?|lib|common|helpers)/',
  '^(?:apps|packages|migrations|tests)/.*/(?:shared|utils?|lib|common|helpers)/',
];
const thirdPartyInfrastructure =
  'node_modules/(?:@nestjs|kysely|pg|pg-boss|pg-pool|pg-protocol|pino|socket\\.io|socket\\.io-client|express|@orpc|reflect-metadata|rxjs)/';
// Byte-for-byte vendored Cutroom wire schema (CF-61): kept in the graph so imports *into* it are
// checked, but its own imports are not followed. Its bytes are pinned by the `integrity` job.
const vendoredWire = '^packages/backend/src/modules/content/adapters/cutroom/wire-v1/';
// Packages that run in the client (they do not all exist yet; the rule applies when they do).
const clientPackages = '^(?:apps/client|packages/(?:client-core|ui|design-tokens|scroll-model|scene-core))/';
// The apps' composition roots: the only files that choose concrete implementations.
const compositionRoots = [
  '^apps/api/src/app\\.module\\.ts$',
  '^apps/api/src/modules/[^/]+\\.ts$',
  '^apps/worker/src/worker\\.module\\.ts$',
  '^apps/worker/src/jobs\\.ts$',
  // The worker's operator command composes the reasoning ledger for write-offs (S2.2).
  '^apps/worker/src/operator\\.ts$',
];
const testFile = '\\.test\\.tsx?$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Import cycles hide ownership and initialisation order.',
      severity: 'error',
      from: { path: '^(apps|packages|migrations|tests)/' },
      to: { circular: true },
    },
    {
      name: 'domain-is-pure',
      comment: 'domain/ imports only its own domain code, Zod and public ID types from contracts.',
      severity: 'error',
      from: { path: `${layered}/domain/`, pathNot: testFile },
      to: {
        pathNot: ['^packages/backend/src/$1/domain/', 'node_modules/zod/', '^packages/contracts/src/ids\\.ts$'],
      },
    },
    {
      name: 'application-allowlist',
      comment:
        "application/ imports only its own domain/application code and events.ts, other modules' (or the reasoning engine's) framework-free public.ts, the observability types, wire contracts and Zod. Everything else (Nest, Kysely, pg, pg-boss, provider SDKs, Node I/O, adapters, infrastructure) reaches it through ports.",
      severity: 'error',
      from: { path: `${layered}/application/`, pathNot: testFile },
      to: {
        pathNot: [
          '^packages/backend/src/$1/(?:domain|application)/',
          '^packages/backend/src/$1/events\\.ts$',
          `${anyLayered}/public\\.ts$`,
          '^packages/backend/src/infrastructure/observability/index\\.ts$',
          '^packages/contracts/src/',
          'node_modules/zod/',
        ],
      },
    },
    {
      name: 'public-surface-is-framework-free',
      comment:
        'public.ts and events.ts are the small framework-free cross-module surface: no adapters, no Nest/Kysely/pg/pg-boss, no infrastructure except the pure queue declarations.',
      severity: 'error',
      from: { path: `${anyLayered}/(?:public|events)\\.ts$` },
      to: {
        path: ['/adapters/', thirdPartyInfrastructure, '^packages/backend/src/infrastructure/'],
        pathNot: '^packages/backend/src/infrastructure/jobs/queues\\.ts$',
      },
    },
    {
      name: 'nest-providers-only-in-composition-roots',
      comment:
        "Only the apps' composition roots (and integration tests, which compose real adapters the same way) select concrete implementations through a module's nest-providers.",
      severity: 'error',
      from: { pathNot: [...compositionRoots, '^tests/integration/'] },
      to: { path: '/adapters/nest-providers\\.ts$' },
    },
    {
      name: 'apps-reach-modules-through-public-or-wiring',
      comment:
        'Apps use a module only through its public.ts, or its nest-providers from a composition root; never its domain, application or adapters.',
      severity: 'error',
      from: { path: '^apps/(?:api|worker)/' },
      to: {
        path: `${anyLayered}/`,
        pathNot: [`${anyLayered}/public\\.ts$`, `${anyLayered}/adapters/nest-providers\\.ts$`],
      },
    },
    {
      name: 'cross-module-through-public',
      comment: "A module reaches another module only through that module's public.ts.",
      severity: 'error',
      from: { path: '^packages/backend/src/modules/([^/]+)/' },
      to: {
        path: `${anyLayered}/`,
        pathNot: ['^packages/backend/src/modules/$1/', `${anyLayered}/public\\.ts$`],
      },
    },
    {
      name: 'reasoning-through-public',
      comment:
        'Modules use the shared reasoning engine only through reasoning/public.ts; reasoning owns no role and imports no module internals.',
      severity: 'error',
      from: { path: '^packages/backend/src/reasoning/' },
      to: { path: '^packages/backend/src/modules/[^/]+/', pathNot: '^packages/backend/src/modules/[^/]+/public\\.ts$' },
    },
    {
      name: 'infrastructure-below-modules',
      comment:
        'Infrastructure adapters never import modules, the reasoning engine or apps (identity public types excepted).',
      severity: 'error',
      from: { path: '^packages/backend/src/infrastructure/' },
      to: {
        path: ['^packages/backend/src/(?:modules|reasoning)/', '^apps/'],
        pathNot: [
          '^packages/backend/src/modules/identity/public\\.ts$',
          '^packages/backend/src/reasoning/public\\.ts$',
        ],
      },
    },
    {
      name: 'production-protocol-public-types-only',
      severity: 'error',
      from: { path: '^packages/backend/src/infrastructure/' },
      to: { path: '^packages/backend/src/reasoning/public\\.ts$', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'production-protocol-only',
      severity: 'error',
      from: {
        path: '^packages/backend/src/infrastructure/',
        pathNot: '^packages/backend/src/infrastructure/postgres/production-scope\\.ts$',
      },
      to: { path: '^packages/backend/src/reasoning/public\\.ts$' },
    },
    {
      name: 'contracts-are-wire-only',
      comment:
        "packages/contracts holds JSON-native wire schemas: Zod and oRPC contract definitions, and re-exports of the canonical scroll-model/scene-core schemas (blueprint §22) — never scroll-model's internal provenance or producer contract.",
      severity: 'error',
      from: { path: '^packages/contracts/src/', pathNot: testFile },
      to: {
        pathNot: [
          '^packages/contracts/src/',
          '^packages/scroll-model/src/(?!internal/|producer/|admission/)',
          '^packages/scene-core/src/',
          'node_modules/(?:zod|@orpc/contract)/',
        ],
      },
    },
    {
      name: 'clients-never-import-scroll-internals',
      comment:
        "Scroll provenance (claims, sources, checks) and the producer contract are backend-only: the client app and client packages never import scroll-model's internal or producer entries, resolved or not.",
      severity: 'error',
      from: { path: '^(?:apps/client|packages/(?:client-core|ui|design-tokens|scene-core))/' },
      to: {
        path: [
          '^packages/scroll-model/src/(?:internal|producer)/',
          '^@knowscroll/scroll-model/(?:internal|producer)(?:/|$)',
        ],
      },
    },
    {
      name: 'clients-never-import-scroll-admission',
      comment:
        "Admission proves every simulation over its whole grid (milliseconds on a JIT, tens to hundreds on Hermes): the client app and client packages never import scroll-model's admission entry, resolved or not. Their entry point is `parseDocument` / `parseBlock` on the public entry.",
      severity: 'error',
      from: { path: '^(?:apps/client|packages/(?:client-core|ui|design-tokens|scene-core))/' },
      to: {
        path: ['^packages/scroll-model/src/admission/', '^@knowscroll/scroll-model/admission(?:/|$)'],
      },
    },
    {
      name: 'clients-never-import-scroll-producer-fixtures',
      comment:
        'Only consumer-document fixtures are client-reachable: drafts, compile inputs and internal provenance fixtures (claims, sources) stay with the backend and tests.',
      severity: 'error',
      from: { path: '^(?:apps/client|packages/(?:client-core|ui|design-tokens|scene-core))/' },
      to: { path: '^packages/scroll-model/fixtures/producer/' },
    },
    {
      name: 'scroll-model-public-entry-is-self-contained',
      comment:
        "scroll-model's public modules never reach its internal, producer or admission entries, so a client cannot get them transitively.",
      severity: 'error',
      from: {
        path: '^packages/scroll-model/src/',
        pathNot: ['^packages/scroll-model/src/(?:internal|producer|admission)/', testFile, '/test-support/'],
      },
      to: { path: '^packages/scroll-model/src/(?:internal|producer|admission)/' },
    },
    {
      name: 'scroll-model-is-portable',
      comment: 'scroll-model runs unchanged on the server, the web and React Native: no Node built-ins outside tests.',
      severity: 'error',
      from: { path: '^packages/scroll-model/src/', pathNot: [testFile, '/test-support/'] },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'scroll-model-depends-on-zod-only',
      comment: 'scroll-model is pure TypeScript and Zod (no React, no SDKs) outside tests.',
      severity: 'error',
      from: { path: '^packages/scroll-model/src/', pathNot: [testFile, '/test-support/'] },
      to: { path: 'node_modules/', pathNot: 'node_modules/zod/' },
    },
    {
      name: 'clients-never-import-backend',
      comment: 'Client packages and the client app never import backend code, apps or migrations.',
      severity: 'error',
      from: { path: clientPackages },
      to: { path: ['^packages/backend/', '^apps/(?:api|worker)/', '^migrations/'] },
    },
    {
      name: 'apps-never-import-each-other',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'packages-never-import-apps',
      severity: 'error',
      from: { path: '^(packages|migrations)/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-generic-folders',
      comment: 'No shared/utils/lib/common/helpers package or folder: name a reusable facility by its purpose.',
      severity: 'error',
      from: { path: '^(apps|packages|migrations|tests)/' },
      to: { path: genericFolder, pathNot: 'node_modules/' },
    },
    {
      name: 'no-generic-folders-source',
      severity: 'error',
      from: { path: genericFolder, pathNot: 'node_modules/' },
      to: {},
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: { path: '^(apps|packages|migrations|tests)/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-undeclared-dependency',
      comment: "Every imported package is declared in the importing workspace package's package.json.",
      severity: 'error',
      from: { path: '^(apps|packages|migrations|tests)/' },
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'production-code-not-to-dev-dependencies',
      severity: 'error',
      from: {
        path: '^(?:apps/(?:api|worker)|packages/[^/]+|migrations)/src/',
        pathNot: [testFile, '/test-support/'],
      },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', vendoredWire] },
    exclude: {
      path: ['^(?:apps|packages)/[^/]+/dist/', '^migrations/dist/', '^apps/client/\\.expo/'],
    },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['@knowscroll/source', 'import', 'require', 'node', 'default'],
      mainFields: ['module', 'main', 'types'],
      extensions: ['.ts', '.tsx', '.web.tsx', '.native.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
