# Repository scripts

Run these commands from the repository root after the frozen workspace install. They support
contributors and operators; a script with no TypeScript importer can still be a public CLI.
Package scripts, hosted workflows and the operation runbooks are its callers.

## Choose the operation

| Entry point | Caller and effects | Check or recovery |
| --- | --- | --- |
| `pnpm issue-context 679` or `pnpm issue-context new "short symptom"` | Contributors; reads tracked files and optionally GitHub, prints reading pointers. Creates no issue or branch. | `node --test scripts/issue-context/*.test.mjs`; [usage](../docs/v2/engineering/issue-context.md) includes offline mode. |
| `pnpm lint` | Contributors and CI; runs typed ESLint in separate processes so the whole tree fits in memory. It checks every part even when one fails. | Exit 0 only when every part passes; `--fix` is forwarded to every part and edits files. |
| `node scripts/build-cutroom-wire.mjs` | Backend build; compiles pinned wire schemas into backend `dist/`, preserving source bytes. | Build and integrity CI verify it; never edit the vendored schema to fix generated output. |
| `node scripts/check-library-sources.mjs --only seasons,tides` | Operator source check; imports the built backend and fetches public pages through the production research policy. No model call or database write. | Prints counts/refusal codes and failed URLs; exit 1 if a recipe fails. Wait between requests rather than bypassing fetch policy. |
| `node scripts/release/build.mjs --out "$KS_DEV_ROOT/tmp/cleanup-release"` | CI release builder; requires built API, worker and web output. Writes a release tar and checksum under the chosen output directory. | Uses the host's release validators. Build once and promote the same bytes; rebuilding one commit need not reproduce the same artifact. |
| `node scripts/release/smoke.mjs <release-tar>` | CI/operator artifact validation; checks and unpacks the tar into temporary storage. | `--start` also migrates and starts API/worker, so use only a disposable database. See [release operations](../docs/v2/operations/environments.md). |
| `scripts/promote.sh stage` | Coordinator promotion; checks dev health and the exact commit's successful checks before moving stage. | Follow the [promotion runbook](../docs/v2/operations/environments.md#promote-scriptspromotesh-stage). Live promotion is owner-only. |

The examples use authored recipe names and local output paths, not live requests or credentials.
`KS_DEV_ROOT` must name the dedicated data directory. The release builder needs GNU tar; read
[the release workflow](../.github/workflows/checks.yml) for its build prerequisites and environment.

## Where to read next

- [Issue-context implementation](issue-context/cli.mjs) and its [tests](issue-context/lookup.test.mjs).
- [Release builder](release/build.mjs), [file helpers](release/files.mjs), [smoke runner](release/smoke.mjs).
- [Host release policy](../ops/vps/tool/plan.ts) and [tree checks](../ops/vps/tool/tree.ts), shared by the
  builder, smoke runner and root-operated host tool.
- [Scroll source-check procedure](../docs/v2/operations/scroll-production.md) and
  [public-page boundary](../packages/backend/src/infrastructure/research/README.md).

Run `node --test ops/vps/tool/plan.test.ts ops/vps/tool/tree.test.ts ops/vps/backup/scripts.test.ts`
for pure release/recovery fixtures. They do not deploy, exercise a real systemd host or prove a
production rollback. Hosted integration and installed-release checks remain separate.
