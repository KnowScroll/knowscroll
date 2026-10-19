/**
 * Import boundaries of the v2 workspace (blueprint §22). Every rule is an error: `pnpm
 * boundaries` fails CI on the first violation. Paths are repository-relative.
 *
 * Module code lives in packages/backend/src/modules/<module>/ and the shared execution engine
 * in packages/backend/src/reasoning/; both follow the onion layout domain/ → application/ →
 * adapters/.
 */
const layered = '^packages/backend/src/(modules/[^/]+|reasoning)';
const genericFolder = '^(?:apps|packages|migrations|tests)/.*/(?:shared|utils?|lib|common|helpers)/';
const thirdPartyInfrastructure =
  'node_modules/(?:@nestjs|kysely|pg|pg-boss|pg-pool|pg-protocol|pino|socket\\.io|socket\\.io-client|express|@orpc|reflect-metadata|rxjs)/';

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
      from: { path: `${layered}/domain/` },
      to: {
        pathNot: ['^packages/backend/src/$1/domain/', 'node_modules/zod/', '^packages/contracts/src/ids\\.ts$'],
      },
    },
    {
      name: 'application-is-framework-free',
      comment:
        'application/ never imports Nest, Kysely, pg, pg-boss, provider SDKs, adapters, apps or the database/job/notice infrastructure; it receives ports.',
      severity: 'error',
      from: { path: `${layered}/application/` },
      to: {
        path: [
          thirdPartyInfrastructure,
          '^apps/',
          '/adapters/',
          '^packages/backend/src/infrastructure/(?:postgres|jobs|notices|lifecycle|config)/',
        ],
      },
    },
    {
      name: 'nest-providers-only-in-composition-roots',
      comment: "Only the apps' composition roots select concrete implementations through a module's nest-providers.",
      severity: 'error',
      from: { pathNot: '^apps/(?:api/src/(?:app\\.module|modules/)|worker/src/(?:worker\\.module|jobs))' },
      to: { path: '/adapters/nest-providers\\.ts$' },
    },
    {
      name: 'cross-module-through-public',
      comment: "A module reaches another module only through that module's public.ts.",
      severity: 'error',
      from: { path: '^packages/backend/src/modules/([^/]+)/' },
      to: {
        path: '^packages/backend/src/(?:modules/[^/]+|reasoning)/',
        pathNot: [
          '^packages/backend/src/modules/$1/',
          '^packages/backend/src/(?:modules/[^/]+|reasoning)/public\\.ts$',
        ],
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
        pathNot: '^packages/backend/src/modules/identity/public\\.ts$',
      },
    },
    {
      name: 'contracts-are-wire-only',
      comment: 'packages/contracts holds JSON-native wire schemas: Zod and oRPC contract definitions only.',
      severity: 'error',
      from: { path: '^packages/contracts/src/', pathNot: '\\.test\\.ts$' },
      to: { pathNot: ['^packages/contracts/src/', 'node_modules/(?:zod|@orpc/contract)/'] },
    },
    {
      name: 'clients-never-import-backend',
      severity: 'error',
      from: { path: '^apps/client/' },
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
      comment: 'No shared/utils/lib/common: name a reusable facility by its purpose.',
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
        pathNot: ['\\.test\\.ts$', '/test-support/'],
      },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: [
        '^(?:apps|packages)/[^/]+/dist/',
        '^migrations/dist/',
        '^apps/client/\\.expo/',
        // Vendored byte-for-byte from Cutroom (CF-61); not yet imported by anything.
        '^packages/backend/src/modules/content/adapters/cutroom/wire-v1/',
      ],
    },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['@knowscroll/source', 'import', 'require', 'node', 'default'],
      mainFields: ['module', 'main', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
