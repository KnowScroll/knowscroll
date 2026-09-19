/**
 * ADR-0021 phase-1 proof lane (#89): FEASIBILITY ONLY, not the joined proof. Composes upstream
 * Cutroom's own `startApi` and `startWorker` in this one process — the stand-in and ffmpeg adapters
 * wired by hand, the way `tests/engine/harness.ts` wires them, but without importing that or any
 * other test-support module (that import is reserved for the generator, never a host or this
 * feasibility check). It submits a generated request over real HTTP, polls the real API until the
 * run finishes, and confirms the result is a completed video whose path is genuinely contained in
 * the instance's own artifact root, with a record whose takes are non-empty and include at least
 * one `used: true`.
 *
 * Evidence level: real local service with upstream stand-in providers. Never real generation, and
 * never a substitute for the two-process joined proof phase 2 builds against the host.
 *
 * Plain Node (erasable TypeScript only), with `. ./scripts/env.sh` sourced first. Instance data is
 * written under `$KS_DEV_ROOT/cutroom/instances/`; nothing is written inside the Cutroom runtime.
 *
 * Usage:
 *   node scripts/cutroom-local/validate-standin-inprocess.ts --runtime <cutroom runtime dir> \
 *     --bundle docs/journeys/evidence/cutroom-local/joined-proof-complete-video.bundle.json \
 *     [--profile small|default|both]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkContained } from './containment.ts'
import type { Standin } from './make-standin-script.ts'

// ---------------------------------------------------------------- loose shapes of what is imported

interface Api {
  baseUrl: string
  stop(): Promise<void>
}
interface ApiModule {
  startApi(options: { dbPath: string; port?: number }): Promise<Api>
}
interface WorkerHandle {
  stop(): Promise<void>
}
interface WorkerModule {
  startWorker(options: Record<string, unknown>): Promise<WorkerHandle>
}
interface Tools {
  ready(): Promise<void>
}
interface ProvidersModule {
  fakeModel(script: unknown, options: { models: Record<string, string> }): unknown
  fakeImage(script: unknown, options?: { artifactRoot?: string }): unknown
  fakeSensors(script: unknown): unknown
  fakeVideo(tools: Tools, script: unknown, options?: { artifactRoot?: string }): unknown
  fakeNarration(script: unknown, options?: { artifactRoot?: string }): unknown
  ffmpegMedia(tools: Tools, options: { artifactRoot?: string; script?: unknown }): unknown
  ffmpegAssembler(tools: Tools, options?: { artifactRoot?: string }): unknown
  ffmpegTools(): Tools
}
interface PipelineModule {
  DEFAULT_PLAN_SETTINGS: { models: Record<string, string> } & Record<string, unknown>
  DEFAULT_RENDER_SETTINGS: Record<string, unknown>
  DEFAULT_STILLS_SETTINGS: Record<string, unknown>
}

async function importFromRuntime<T>(runtime: string, relPath: string): Promise<T> {
  return (await import(pathToFileURL(join(runtime, relPath)).href)) as T
}

// ---------------------------------------------------------------- the small render profile

/**
 * Replicated BY HAND from `tests/engine/harness.ts`'s `TEST_RENDER_SETTINGS` (read, never imported,
 * since only the generator may import test-support): a small output profile and a caption style
 * sized for it, plus the harness's fast transient backoff and its default still push. This file's
 * sha256 is recorded in every generated bundle, so drift between the two is detectable.
 */
function smallRenderSettings(defaults: Record<string, unknown>): Record<string, unknown> {
  return {
    ...defaults,
    profile: {
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 108,
      height: 192,
      fps: 24,
      sampleRate: 48000,
      channels: 2,
    },
    captionStyle: { id: 'word-captions-proof-small', fontName: 'Arial', fontSize: 12, marginV: 20 },
    transient: { maxAttempts: 3, backoffMs: 20 },
    stillPush: { endZoom: 1.1 },
  }
}

// ---------------------------------------------------------------- CLI

interface Args {
  runtime: string
  bundlePath: string
  profiles: readonly ('small' | 'default')[]
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
  if (runtime === undefined) throw new Error('--runtime <cutroom runtime dir> is required')
  const bundlePath = flags.bundle
  if (bundlePath === undefined) throw new Error('--bundle <joined-proof bundle.json> is required')
  const profile = flags.profile ?? 'both'
  const profiles: readonly ('small' | 'default')[] =
    profile === 'both' ? ['small', 'default'] : profile === 'small' ? ['small'] : ['default']
  if (profile !== 'both' && profile !== 'small' && profile !== 'default') {
    throw new Error(`--profile must be small, default or both, not '${profile}'`)
  }
  return { runtime: resolve(runtime), bundlePath: resolve(bundlePath), profiles }
}

// ---------------------------------------------------------------- provenance checks

function runtimeRevision(runtime: string): string {
  return execFileSync('git', ['-C', runtime, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  }).trim()
}

function runtimeIsClean(runtime: string): boolean {
  const status = execFileSync('git', ['-C', runtime, 'status', '--porcelain'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  })
  return status.trim() === ''
}

// ---------------------------------------------------------------- one profile's run

interface ProfileResult {
  profile: string
  instanceDir: string
  wallMs: number
  runId: string
  videoPath: string
  containment: { ok: boolean; reason?: string }
  takes: number
  usedTakes: number
}

async function runProfile(
  runtime: string,
  standin: Standin,
  request: unknown,
  profile: 'small' | 'default',
  ksDevRoot: string,
): Promise<ProfileResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const instanceDir = join(ksDevRoot, 'cutroom', 'instances', `proof-validate-${stamp}-${profile}`)
  const artifactRoot = join(instanceDir, 'artifacts')
  mkdirSync(artifactRoot, { recursive: true })
  const dbPath = join(instanceDir, 'cutroom.sqlite')
  const questionsPath = join(instanceDir, 'QUESTIONS.md')
  const budgetPath = join(instanceDir, 'BUDGET.md')
  const budgetSource = join(runtime, 'steering-ref', 'steering', 'BUDGET.md')
  writeFileSync(budgetPath, readFileSync(budgetSource))

  const [apiModule, workerModule, providers, pipeline] = await Promise.all([
    importFromRuntime<ApiModule>(runtime, 'apps/api/src/index.ts'),
    importFromRuntime<WorkerModule>(runtime, 'apps/worker/src/index.ts'),
    importFromRuntime<ProvidersModule>(runtime, 'packages/providers/src/index.ts'),
    importFromRuntime<PipelineModule>(runtime, 'packages/pipeline/src/index.ts'),
  ])

  const tools = providers.ffmpegTools()
  const renderSettings =
    profile === 'small' ? smallRenderSettings(pipeline.DEFAULT_RENDER_SETTINGS) : pipeline.DEFAULT_RENDER_SETTINGS

  const api = await apiModule.startApi({ dbPath })
  let worker: WorkerHandle | undefined
  try {
    worker = await workerModule.startWorker({
      dbPath,
      pollMs: 10,
      model: providers.fakeModel(standin.model, { models: pipeline.DEFAULT_PLAN_SETTINGS.models }),
      image: providers.fakeImage(standin.images, { artifactRoot }),
      sensors: providers.fakeSensors(standin.sensors),
      video: providers.fakeVideo(tools, standin.video, { artifactRoot }),
      narration: providers.fakeNarration(standin.narration, { artifactRoot }),
      media: providers.ffmpegMedia(tools, { artifactRoot, script: standin.media }),
      assembler: providers.ffmpegAssembler(tools, { artifactRoot }),
      settings: pipeline.DEFAULT_PLAN_SETTINGS,
      stillsSettings: pipeline.DEFAULT_STILLS_SETTINGS,
      renderSettings,
      questionsPath,
      budgetPath,
    })

    const startedAt = Date.now()
    const submitRes = await fetch(`${api.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const submitJson = (await submitRes.json()) as Record<string, unknown>
    if (submitRes.status !== 202 || submitJson.outcome !== 'accepted') {
      throw new Error(`submit did not accept the request: ${submitRes.status} ${JSON.stringify(submitJson)}`)
    }
    const runId = String(submitJson.runId)

    const deadline = Date.now() + 90_000 // upstream's VIDEO_FINISH_MS (tests/engine/video.ts), replicated
    let finished = false
    while (Date.now() < deadline) {
      const statusRes = await fetch(`${api.baseUrl}/v1/runs/${runId}`)
      const statusJson = (await statusRes.json()) as Record<string, unknown>
      if (statusJson.state === 'finished') {
        finished = true
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!finished) throw new Error(`run ${runId} did not finish within 90s`)
    const wallMs = Date.now() - startedAt

    const resultRes = await fetch(`${api.baseUrl}/v1/runs/${runId}/result`)
    const resultJson = (await resultRes.json()) as Record<string, unknown>
    if (resultRes.status !== 200 || resultJson.status !== 'completed' || resultJson.until !== 'video') {
      throw new Error(`the run did not complete a video: ${resultRes.status} ${JSON.stringify(resultJson)}`)
    }
    const video = resultJson.video as { path?: unknown } | undefined
    const videoPath = video?.path
    if (typeof videoPath !== 'string') {
      throw new Error(`the completed result names no video path: ${JSON.stringify(resultJson)}`)
    }
    const containment = checkContained(artifactRoot, videoPath)

    const recordRes = await fetch(`${api.baseUrl}/v1/runs/${runId}/record`)
    const recordJson = (await recordRes.json()) as Record<string, unknown>
    if (recordRes.status !== 200 || !Array.isArray(recordJson.takes)) {
      throw new Error(`the record has no takes array: ${recordRes.status} ${JSON.stringify(recordJson)}`)
    }
    const takes = recordJson.takes as Array<Record<string, unknown>>
    const usedTakes = takes.filter((t) => t.used === true).length

    const result: ProfileResult = {
      profile,
      instanceDir,
      wallMs,
      runId,
      videoPath,
      containment,
      takes: takes.length,
      usedTakes,
    }
    writeFileSync(join(instanceDir, 'receipt.json'), `${JSON.stringify(result, null, 2)}\n`)
    return result
  } finally {
    if (worker !== undefined) await worker.stop()
    await api.stop()
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const ksDevRoot = process.env.KS_DEV_ROOT
  if (ksDevRoot === undefined || ksDevRoot === '') {
    throw new Error('KS_DEV_ROOT is not set; source scripts/env.sh first')
  }

  const bundle = JSON.parse(readFileSync(args.bundlePath, 'utf8')) as {
    cutroomRevision: string
    request: unknown
    standin: Standin
  }
  const actualRevision = runtimeRevision(args.runtime)
  if (actualRevision !== bundle.cutroomRevision) {
    throw new Error(
      `the runtime at ${args.runtime} is at ${actualRevision}, not the bundle's pinned ${bundle.cutroomRevision}`,
    )
  }
  if (!runtimeIsClean(args.runtime)) {
    throw new Error(`the runtime at ${args.runtime} has tracked changes; refusing to run against it`)
  }

  const results: ProfileResult[] = []
  for (const profile of args.profiles) {
    const result = await runProfile(args.runtime, bundle.standin, bundle.request, profile, ksDevRoot)
    results.push(result)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }

  const failed = results.filter(
    (r) => !r.containment.ok || r.takes === 0 || r.usedTakes === 0,
  )
  if (failed.length > 0) {
    throw new Error(`feasibility failed for: ${failed.map((r) => r.profile).join(', ')}`)
  }
  process.stdout.write(
    `feasibility ok: ${results.map((r) => `${r.profile} in ${r.wallMs}ms`).join(', ')}\n`,
  )
}

await main()
