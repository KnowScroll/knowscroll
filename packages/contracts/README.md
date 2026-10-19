# @knowscroll/contracts

JSON-native wire contracts shared by the API and its clients (blueprint §6): Zod schemas, oRPC
contract routes, public IDs and the stable problem-code catalogue. Nothing here runs on only one
side, and nothing here transforms data: parse first, then convert in the receiving adapter.

| File | Contents |
|---|---|
| `src/problems.ts` | `problemCatalogue` (code → HTTP status, fixed title), RFC 9457 `ProblemDetailsSchema`, `problemDetails()` |
| `src/health.ts` | `GET /health` response and contract |
| `src/router.ts` | `apiContract`: every HTTP route the API serves |

Rules:

- A problem code never changes meaning; a new meaning gets a new code. Codes double as
  `reasonCode` in diagnostics.
- Job payloads, model outputs and internal projections are backend-local and never live here.
- Allowed imports: `zod` and `@orpc/contract` only (enforced by dependency-cruiser,
  `contracts-are-wire-only`).
- `src/openapi.test.ts` proves the contract generates an OpenAPI document with RFC 9457 errors.

Build: `tsc -p tsconfig.build.json` → `dist/`. Inside the workspace, TypeScript, Vitest and
dependency-cruiser read the sources through the `@knowscroll/source` export condition
(`docs/v2/engineering/workspace.md`).
