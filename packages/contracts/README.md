# @knowscroll/contracts

JSON-native wire contracts shared by the API and its clients (blueprint §6): Zod schemas, oRPC
contract routes, public IDs and the stable problem-code catalogue. Nothing here runs on only one
side, and nothing here transforms data: parse first, then convert in the receiving adapter.

| File | Contents |
|---|---|
| `src/problems.ts` | `problemCatalogue` (code → HTTP status, fixed title), RFC 9457 `ProblemDetailsSchema`, `problemDetails()` |
| `src/health.ts` | `GET /health` response and contract |
| `src/identity.ts` | `/auth/*` sign-in and session routes, the link and session token shapes, the session cookie names (D-022) |
| `src/router.ts` | `apiContract`: every HTTP route the API serves |
| `src/content.ts` | Re-export of the canonical `ScrollDocument` (`scroll-document.v1`) and `ClientCapabilities` from `@knowscroll/scroll-model`; never copied, and never its internal provenance or producer entries |
| `src/experience.ts` | `POST /v1/actions`, `GET /v1/saved`, and the exposure routes: `POST /v1/experience/open`, `POST /v1/experience/activate`, `GET /v1/experience/exposures/{id}/document` |
| `src/interactions.ts` | `interaction.v1`: the observation envelope and the three `scroll.*` payloads, `observation-limits.v1` (shared with the recorder), `POST /v1/observations/batch` and the dev-only `GET /v1/diagnostics/exposures/{id}/evidence` |

Rules:

- A problem code never changes meaning; a new meaning gets a new code. Codes double as
  `reasonCode` in diagnostics.
- Job payloads, model outputs and internal projections are backend-local and never live here.
- Allowed imports: `zod`, `@orpc/contract` and the public entry of `@knowscroll/scroll-model`
  only (enforced by dependency-cruiser, `contracts-are-wire-only`).
- `src/openapi.test.ts` proves the contract generates an OpenAPI document with RFC 9457 errors.

Build: `tsc -p tsconfig.build.json` → `dist/`. Inside the workspace, TypeScript, Vitest and
dependency-cruiser read the sources through the `@knowscroll/source` export condition
(`docs/v2/engineering/workspace.md`).
