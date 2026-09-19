/**
 * ADR-0021 (docs/decisions/0021-cutroom-successor-pin-and-local-host.md) section 4's joined proof —
 * NOT YET IMPLEMENTED. This is a documented skeleton only: issue #89's proof lane (phase 1) built
 * the request/stand-in generator (scripts/cutroom-local/make-standin-script.ts), the in-process
 * feasibility check (scripts/cutroom-local/validate-standin-inprocess.ts) and the KnowScroll-side
 * helpers (scripts/cutroom-local/{containment,intent-store,lost-response-proxy}.ts). Phase 2, a
 * separate lane, integrates this runner with `ops/cutroom-host/host.ts` (built in parallel; this
 * lane does not implement or edit it).
 *
 * What phase 2 still has to do here, in order:
 *  1. Spawn `node ops/cutroom-host/host.ts api --cutroom <runtime> --expect-revision <pin> --instance
 *     <dir> --port <n>` and `... worker ... --standin-script <one of this lane's *.standin.json>
 *     [--render-profile small|default] [--lease-ms <n>]` as separate child processes, each with an
 *     explicit allowlisted environment only (PATH, HOME, TMPDIR, KS_DEV_ROOT, LANG) — never this
 *     repository's own `.env` — and read each process's one readiness JSON line from stdout.
 *  2. Use the REPINNED, real `apps/worker/src/cutroom/http-client.ts` (ADR-0021) against the host's
 *     observed `baseUrl`, never a synthetic fixture, for every request in this proof:
 *       - complete-video: submit, page events with `intent-store.ts` persisting the cursor, poll to
 *         a finished run, fetch the result and record, verify the video's path with
 *         `containment.ts` against the instance's own artifact root, and ffprobe-read it.
 *       - restart pair: submit, hold the first worker at its scripted call, kill it, start a second
 *         worker on the SAME instance database with the second stand-in script once its lease has
 *         run out, and verify the run still finishes with a reconstructed caller that re-verifies
 *         its persisted request bytes/digest via `intent-store.ts` before ever POSTing again.
 *       - a genuinely lost response: arm `lost-response-proxy.ts` in front of the host's API for one
 *         connection, submit through the proxy so the transport call fails, then reconcile using
 *         only the original requestId via lookup — never a new identity.
 *       - cancel: submit with no worker started, POST cancel, and confirm the accepted RunStatus.
 *  3. Verify process/port cleanup (both host processes exit 0 on SIGTERM/SIGINT; nothing is left
 *     listening; the instance directory holds only what ADR-0021 section 3 names).
 *  4. Write `docs/journeys/evidence/cutroom-local/joined-proof-<date>.json`, labelled explicitly as
 *     "real local service with upstream stand-in providers" — never real generation, never product
 *     acceptance.
 *
 * Running this file today prints that summary and exits non-zero: there is no host to integrate
 * with yet, and this lane must not build one (ADR-0021 section 2's boundary; the phase-1 brief).
 */

function main(): never {
  process.stderr.write(
    [
      'scripts/run-local-cutroom-journey.ts is a documented skeleton (issue #89, proof lane, phase 1).',
      'It does not run a joined proof yet: ops/cutroom-host/host.ts (a parallel lane) is not this',
      "lane's to build or call. See this file's header comment for phase 2's exact plan, and",
      'scripts/cutroom-local/{make-standin-script,validate-standin-inprocess}.ts for what phase 1',
      'already produced and verified in-process.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

main()
