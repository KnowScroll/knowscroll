/**
 * ADR-0021 phase-1 proof lane (#89): generates the SubmitRequest and Cutroom stand-in script
 * bundles the joined proof needs, by dynamically importing upstream Cutroom's OWN test-support
 * builders (never a `*.test.ts` file with node:test registrations) from a pinned, read-only
 * runtime checkout given by `--runtime`. This is data production only: the generator itself never
 * starts a Cutroom API, worker or process. Importing test-support like this is allowed ONLY in this
 * generator (docs/decisions/0021-cutroom-successor-pin-and-local-host.md, phase-1 brief); a host
 * must never do it.
 *
 * Plain Node (erasable TypeScript only: no enum/namespace/parameter-property syntax), run with
 * `. ./scripts/env.sh` sourced first so TMPDIR/caches stay on the SSD. This script writes only
 * under its own `--out-dir` (default docs/journeys/evidence/cutroom-local); it never writes inside
 * the Cutroom runtime.
 *
 * Usage:
 *   node scripts/cutroom-local/make-standin-script.ts --runtime <cutroom runtime dir> \
 *     [--variant complete-video|restart-first|restart-second|cancel|all] \
 *     [--request-id <base id>] [--budget-cents 300] [--out-dir docs/journeys/evidence/cutroom-local]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------- shapes this generator produces

/** The stand-in script a host composes for the worker, in the shape ADR-0021 section 3 defines: no
 * key beyond these six plus the optional `holdAtCall`. */
export interface Standin {
  model: FakeScript
  images: Record<string, unknown>
  sensors: Record<string, unknown>
  video: Record<string, unknown>
  narration: Record<string, unknown>
  media: Record<string, unknown>
  /** The model call — counted across every role and every port method, from 1 — this run's stand-in
   * never answers: the process prints `{"held":true,"call":n}` and waits there instead. */
  holdAtCall?: number
}

type FakeScript = Partial<Record<'planner' | 'reconciler' | 'witness' | 'judge', readonly unknown[]>>

interface SourceFile {
  path: string
  sha256: string
}

interface Bundle {
  label: string
  cutroomRevision: string
  sourceFiles: SourceFile[]
  builders: string[]
  request: unknown
  standin: Standin
  /** Present only for a restart pair: the harness's own short lease, read from its restart
   * test-support, so a joined-proof host claims the abandoned job soon after the kill. */
  recommendedLeaseMs?: number
  notes?: string
}

// ---------------------------------------------------------------- loose shapes of what we import

interface VideoModule {
  videoRequest(requestId: string, budgetCents?: number): unknown
  videoScript(shape: unknown, pics: readonly unknown[]): FakeScript
  takesOf(shape: unknown): readonly unknown[]
  clipsScript(takes: readonly unknown[]): FakeScript
}
interface StillsModule {
  THREE_RANKS: unknown
  THREE_RANKS_PICS: readonly unknown[]
}
interface RestartModule {
  LEASE_MS: number
}

// ---------------------------------------------------------------- CLI

interface Args {
  runtime: string
  variant: string
  requestId: string
  budgetCents: number
  outDir: string
}

function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === undefined || !key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      flags[name] = 'true'
      continue
    }
    flags[name] = value
    i += 1
  }
  const runtime = flags.runtime
  if (runtime === undefined) {
    throw new Error('--runtime <cutroom runtime dir> is required')
  }
  return {
    runtime: resolve(runtime),
    variant: flags.variant ?? 'all',
    requestId: flags['request-id'] ?? `proof-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    budgetCents: flags['budget-cents'] === undefined ? 300 : Number(flags['budget-cents']),
    outDir: resolve(flags['out-dir'] ?? 'docs/journeys/evidence/cutroom-local'),
  }
}

// ---------------------------------------------------------------- runtime provenance

function runtimeRevision(runtime: string): string {
  return execFileSync('git', ['-C', runtime, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  }).trim()
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sourceFilesOf(runtime: string, relPaths: readonly string[]): SourceFile[] {
  return relPaths.map((path) => ({ path, sha256: sha256File(join(runtime, path)) }))
}

async function importFromRuntime<T>(runtime: string, relPath: string): Promise<T> {
  const url = pathToFileURL(join(runtime, relPath)).href
  return (await import(url)) as T
}

// ---------------------------------------------------------------- one bundle per variant

interface Generated {
  bundle: Bundle
  standin: Standin
}

/** Every default `tests/engine/harness.ts` applies for a port script a fixture leaves out: an empty
 * object, so the stand-in's own good-picture/good-clip defaults apply untouched (S-036, S-047). */
const HARNESS_DEFAULT_PORT_SCRIPTS = { images: {}, sensors: {}, video: {}, narration: {}, media: {} }

async function completeVideo(runtime: string, requestId: string, budgetCents: number): Promise<Generated> {
  const video = await importFromRuntime<VideoModule>(runtime, 'tests/engine/video.ts')
  const stills = await importFromRuntime<StillsModule>(runtime, 'tests/engine/stills.ts')
  const request = video.videoRequest(requestId, budgetCents)
  const model = video.videoScript(stills.THREE_RANKS, stills.THREE_RANKS_PICS)
  const standin: Standin = { model, ...HARNESS_DEFAULT_PORT_SCRIPTS }
  return {
    standin,
    bundle: {
      label: 'upstream test-support stand-in script — a complete video run (THREE_RANKS)',
      cutroomRevision: runtimeRevision(runtime),
      sourceFiles: sourceFilesOf(runtime, [
        'tests/engine/harness.ts',
        'tests/engine/plans.ts',
        'tests/engine/stills.ts',
        'tests/engine/video.ts',
      ]),
      builders: ['videoRequest', 'videoScript', 'THREE_RANKS', 'THREE_RANKS_PICS'],
      request,
      standin,
      notes:
        'Every take passes every gate (2-5) on its first attempt and Gate 7 accepts the cut, so the ' +
        "run's record lists six takes, all used:true (upstream tests/reel-takes-record.test.ts, " +
        '"a completed video run").',
    },
  }
}

/**
 * A pair: the FIRST worker holds call 12 — shot 0's reconcile call (Gates 2, 3 and 4 already
 * reached, cut off before Gate 5) — matching upstream's reel-takes-record.test.ts "a restarted
 * run". The SECOND worker answers a fresh script starting at call 1, because reel.clips restarts
 * from the beginning at this pin (S-076: Slice 5's checkpoints are not implemented yet), so its
 * script is `clipsScript(takesOf(THREE_RANKS))` — every take's witness/reconcile plus Gate 7 — with
 * no `holdAtCall`.
 */
async function restartPair(
  runtime: string,
  requestId: string,
  budgetCents: number,
): Promise<{ first: Generated; second: Generated }> {
  const video = await importFromRuntime<VideoModule>(runtime, 'tests/engine/video.ts')
  const stills = await importFromRuntime<StillsModule>(runtime, 'tests/engine/stills.ts')
  const restart = await importFromRuntime<RestartModule>(runtime, 'tests/engine/restart.ts')
  const request = video.videoRequest(requestId, budgetCents)
  const holdAtCall = 12
  const firstModel = video.videoScript(stills.THREE_RANKS, stills.THREE_RANKS_PICS)
  const takes = video.takesOf(stills.THREE_RANKS)
  const secondModel = video.clipsScript(takes)
  const sourceFiles = sourceFilesOf(runtime, [
    'tests/engine/harness.ts',
    'tests/engine/plans.ts',
    'tests/engine/stills.ts',
    'tests/engine/video.ts',
    'tests/engine/restart.ts',
  ])
  const firstStandin: Standin = { model: firstModel, ...HARNESS_DEFAULT_PORT_SCRIPTS, holdAtCall }
  const secondStandin: Standin = { model: secondModel, ...HARNESS_DEFAULT_PORT_SCRIPTS }
  return {
    first: {
      standin: firstStandin,
      bundle: {
        label: "upstream test-support stand-in script — the FIRST worker of a restart, held at shot 0's reconcile call",
        cutroomRevision: runtimeRevision(runtime),
        sourceFiles,
        builders: ['videoRequest', 'videoScript', 'THREE_RANKS', 'THREE_RANKS_PICS'],
        request,
        standin: firstStandin,
        recommendedLeaseMs: restart.LEASE_MS,
        notes:
          'Kill this worker once it prints {"held":true,"call":12} on stdout — never before — then ' +
          'wait at least recommendedLeaseMs before starting the second worker, so the job is claimed ' +
          'again only once its lease has genuinely run out (D-002, S-027).',
      },
    },
    second: {
      standin: secondStandin,
      bundle: {
        label: 'upstream test-support stand-in script — the SECOND worker of a restart, taking up the same run',
        cutroomRevision: runtimeRevision(runtime),
        sourceFiles,
        builders: ['takesOf', 'clipsScript', 'THREE_RANKS'],
        request,
        standin: secondStandin,
        recommendedLeaseMs: restart.LEASE_MS,
        notes:
          'A fresh process with a fresh stand-in: its script answers again from call 1, because a new ' +
          "worker process's model port holds no memory of the killed one's answers. reel.clips is run " +
          'again from its start at this pin, so every one of the six takes is scripted again.',
      },
    },
  }
}

/** No standin content is needed: the joined proof submits this request and cancels it before any
 * worker is ever started, so no model, image, sensor, video, narration or media call is made. */
async function cancelOnly(runtime: string, requestId: string, budgetCents: number): Promise<Generated> {
  const video = await importFromRuntime<VideoModule>(runtime, 'tests/engine/video.ts')
  const request = video.videoRequest(requestId, budgetCents)
  const standin: Standin = {
    model: {},
    images: {},
    sensors: {},
    video: {},
    narration: {},
    media: {},
  }
  return {
    standin,
    bundle: {
      label: 'upstream test-support stand-in script — cancel while no worker runs (unused)',
      cutroomRevision: runtimeRevision(runtime),
      sourceFiles: sourceFilesOf(runtime, [
        'tests/engine/harness.ts',
        'tests/engine/plans.ts',
        'tests/engine/stills.ts',
        'tests/engine/video.ts',
      ]),
      builders: ['videoRequest'],
      request,
      standin,
      notes:
        'This variant needs only the request: submit it, confirm status is "running" with no worker ' +
        'started, then POST /v1/runs/<id>/cancel and confirm the accepted RunStatus reports it. The ' +
        'standin here is a placeholder only — no host worker should ever be started against it.',
    },
  }
}

// ---------------------------------------------------------------- writing

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeGenerated(outDir: string, name: string, generated: Generated): { bundlePath: string; standinPath: string } {
  const bundlePath = join(outDir, `joined-proof-${name}.bundle.json`)
  const standinPath = join(outDir, `joined-proof-${name}.standin.json`)
  writeJson(bundlePath, generated.bundle)
  writeJson(standinPath, generated.standin)
  return { bundlePath, standinPath }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.outDir, { recursive: true })
  const written: string[] = []

  const wantsAll = args.variant === 'all'

  if (wantsAll || args.variant === 'complete-video') {
    const generated = await completeVideo(args.runtime, `${args.requestId}-complete-video`, args.budgetCents)
    const paths = writeGenerated(args.outDir, 'complete-video', generated)
    written.push(paths.bundlePath, paths.standinPath)
  }

  if (wantsAll || args.variant === 'restart-first' || args.variant === 'restart-second') {
    const pair = await restartPair(args.runtime, `${args.requestId}-restart`, args.budgetCents)
    if (wantsAll || args.variant === 'restart-first') {
      const paths = writeGenerated(args.outDir, 'restart-first', pair.first)
      written.push(paths.bundlePath, paths.standinPath)
    }
    if (wantsAll || args.variant === 'restart-second') {
      const paths = writeGenerated(args.outDir, 'restart-second', pair.second)
      written.push(paths.bundlePath, paths.standinPath)
    }
  }

  if (wantsAll || args.variant === 'cancel') {
    const generated = await cancelOnly(args.runtime, `${args.requestId}-cancel`, args.budgetCents)
    const paths = writeGenerated(args.outDir, 'cancel', generated)
    written.push(paths.bundlePath, paths.standinPath)
  }

  if (written.length === 0) {
    throw new Error(
      `--variant ${args.variant} is not one of complete-video, restart-first, restart-second, cancel, all`,
    )
  }

  for (const path of written) process.stdout.write(`wrote ${path}\n`)
}

await main()
