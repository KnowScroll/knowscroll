/**
 * ADR-0021 (docs/decisions/0021-cutroom-successor-pin-and-local-host.md) section 4's joined proof,
 * phase 2 (issue #89, "proof" lane). Drives the real, repinned KnowScroll HTTP client
 * (`apps/worker/src/cutroom/http-client.ts`) against `ops/cutroom-host/host.ts`'s real Cutroom API
 * and worker processes, composed from a clean, detached, pinned Cutroom runtime checkout (read-only
 * to this lane) with upstream's own stand-in providers plus real local ffmpeg. This proves
 * KnowScroll's client and the operator host interoperate against upstream's actual HTTP surface,
 * SQLite storage and restart behavior.
 *
 * Evidence level throughout: REAL LOCAL SERVICE WITH UPSTREAM STAND-IN PROVIDERS. Never real
 * generation, never a product journey, never owner acceptance.
 *
 * Usage (source scripts/env.sh first so node/tsx and caches resolve from the SSD environment):
 *   pnpm exec tsx scripts/run-local-cutroom-journey.ts [receipt-path]
 * `receipt-path`, if given, overrides where the full receipt JSON is written (default:
 * `$KS_DEV_ROOT/cutroom/logs/joined-proof-<utc>.json`). A sanitized snapshot is always written to
 * `docs/journeys/evidence/cutroom-local/joined-proof.json`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import {
  type CutroomRunRef,
  createCutroomHttpClient,
  prepareCutroomRequest,
} from '../apps/worker/src/cutroom/http-client.ts'
import { checkContained } from './cutroom-local/containment.ts'
import {
  type Readiness,
  type SpawnedHost,
  forceKill,
  gracefulStop,
  hostChildEnv,
  spawnHost,
  spawnProcess,
  sleep,
  waitForHeld,
  waitForReadiness,
  withTimeout,
} from './cutroom-local/host-process.ts'
import { saveIntent } from './cutroom-local/intent-store.ts'
import { createLostResponseProxy } from './cutroom-local/lost-response-proxy.ts'

// =================================================================================================
// Pinned constants (ADR-0021).
// =================================================================================================

const CUTROOM_RUNTIME = '/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742'
const CUTROOM_CANONICAL_CLONE = '/Volumes/Mrigesh SSD/cutroom'
const CUTROOM_REVISION = '86d6e2c8b74228db4a5a953e53c53a7b77cef46e'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const HOST_SCRIPT = join(REPO_ROOT, 'ops/cutroom-host/host.ts')
const PREPARE_RUNTIME_SCRIPT = join(REPO_ROOT, 'ops/cutroom-host/prepare-runtime.sh')
const RECONSTRUCTED_CALLER_SCRIPT = join(REPO_ROOT, 'scripts/cutroom-local/reconstructed-caller.ts')
const EVIDENCE_DIR = join(REPO_ROOT, 'docs/journeys/evidence/cutroom-local')

const KS_DEV_ROOT = process.env.KS_DEV_ROOT
if (KS_DEV_ROOT === undefined || KS_DEV_ROOT === '') {
  throw new Error('KS_DEV_ROOT is not set; source scripts/env.sh before running this script')
}
const DEV_ROOT: string = KS_DEV_ROOT

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const INSTANCES_ROOT = join(DEV_ROOT, 'cutroom', 'instances')
const LOGS_ROOT = join(DEV_ROOT, 'cutroom', 'logs')

function instancePath(scenario: string): string {
  return join(INSTANCES_ROOT, `proof-${RUN_STAMP}-${scenario}`)
}

// =================================================================================================
// Small local shapes of what the client and the database hand back (never a Cutroom import).
// =================================================================================================

interface RunEventLike {
  type: string
  seq: number
  stage?: string
  [key: string]: unknown
}
interface StillRefLike {
  pictureId: string
  shotId: string
  path: string
}
interface RunResultLike {
  status: string
  until?: string
  runId: string
  requestId: string
  costCents: number
  video?: { path: string }
  stills?: StillRefLike[]
  reason?: string
  detail?: string
  [key: string]: unknown
}
interface TakeLike {
  takeId: string
  shotId: string
  number: number
  used: boolean
  checks: unknown[]
  [key: string]: unknown
}
interface RunRecordLike {
  runId: string
  pictures: unknown[]
  takes: TakeLike[]
  degradations: unknown[]
}
interface JobRow {
  id: number
  kind: string
  state: string
  attempts: number
  locked_at: string | null
  lease_until: string | null
  cost_cents: number
}
interface RunRow {
  run_id: string
  request_id: string
  state: string
}

interface RequestLike {
  contractVersion: 1
  requestId: string
  worldId: string
  options: { until: 'plan' | 'stills' | 'video'; budgetCents: number; planVaryOn?: string }
  [key: string]: unknown
}

interface Bundle {
  label: string
  cutroomRevision: string
  request: RequestLike
  standin: unknown
  recommendedLeaseMs?: number
  notes?: string
}

// =================================================================================================
// Small helpers.
// =================================================================================================

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function loadBundle(name: string): { bundle: Bundle; standinPath: string; bundlePath: string } {
  const bundlePath = join(EVIDENCE_DIR, `joined-proof-${name}.bundle.json`)
  const standinPath = join(EVIDENCE_DIR, `joined-proof-${name}.standin.json`)
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as Bundle
  if (bundle.cutroomRevision.toLowerCase() !== CUTROOM_REVISION.toLowerCase()) {
    throw new Error(
      `bundle '${name}' is pinned to revision ${bundle.cutroomRevision}, expected ${CUTROOM_REVISION}; regenerate it first`,
    )
  }
  return { bundle, standinPath, bundlePath }
}

function cloneRequest(request: RequestLike): RequestLike {
  return structuredClone(request)
}

function ffprobeJson(path: string): unknown {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { encoding: 'utf8' },
  )
  return JSON.parse(out)
}

function ffmpegVersion(): string {
  return execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0] ?? 'unknown'
}

function gitOf(dir: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

function runtimeSnapshot(): { head: string; ignoredStatus: string; lsA: string[] } {
  const head = gitOf(CUTROOM_RUNTIME, ['rev-parse', 'HEAD'])
  const ignoredStatus = execFileSync(
    'sh',
    ['-c', `git -C "${CUTROOM_RUNTIME}" status --porcelain --ignored | grep -v node_modules || true`],
    { encoding: 'utf8' },
  ).trim()
  const lsA = readdirSync(CUTROOM_RUNTIME).sort()
  return { head, ignoredStatus, lsA }
}

function queryJobRows(dbPath: string, correlationId: string): JobRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const stmt = db.prepare(
      'SELECT id, kind, state, attempts, locked_at, lease_until, cost_cents FROM job WHERE correlation_id = ? ORDER BY id',
    )
    return stmt.all(correlationId) as unknown as JobRow[]
  } finally {
    db.close()
  }
}

function queryRunRows(dbPath: string, requestId: string): RunRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const stmt = db.prepare('SELECT run_id, request_id, state FROM run WHERE request_id = ?')
    return stmt.all(requestId) as unknown as RunRow[]
  } finally {
    db.close()
  }
}

function dirSizeBytes(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSizeBytes(full)
    else total += statSync(full).size
  }
  return total
}

function assertSeqContinuity(events: readonly RunEventLike[], label: string): void {
  const seqs = events.map((e) => e.seq).sort((a, b) => a - b)
  for (let i = 0; i < seqs.length; i += 1) {
    const expected = i + 1
    if (seqs[i] !== expected) {
      throw new Error(`${label}: expected seq ${expected} at position ${i}, combined seqs were ${JSON.stringify(seqs)}`)
    }
  }
}

// =================================================================================================
// Scenario bookkeeping.
// =================================================================================================

interface Assertion {
  description: string
  pass: boolean
  detail?: string
}
interface ScenarioRecord {
  name: string
  status: 'pass' | 'fail'
  assertions: Assertion[]
  observations: string[]
  data: Record<string, unknown>
  firstFailure?: string
}

const scenarios: ScenarioRecord[] = []
const allSpawned: SpawnedHost[] = []

class ScenarioFailure extends Error {}

interface ScenarioTools {
  assert(condition: boolean, description: string, detail?: string): void
  observe(text: string): void
  record(key: string, value: unknown): void
}

async function runScenario(name: string, fn: (tools: ScenarioTools) => Promise<void>): Promise<ScenarioRecord> {
  const assertions: Assertion[] = []
  const observations: string[] = []
  const data: Record<string, unknown> = {}
  const tools: ScenarioTools = {
    assert(condition, description, detail) {
      assertions.push({ description, pass: condition, detail })
      if (!condition) throw new ScenarioFailure(`${description}${detail === undefined ? '' : `: ${detail}`}`)
    },
    observe(text) {
      observations.push(text)
    },
    record(key, value) {
      data[key] = value
    },
  }
  process.stdout.write(`\n=== ${name} ===\n`)
  let record: ScenarioRecord
  try {
    await fn(tools)
    record = { name, status: 'pass', assertions, observations, data }
    process.stdout.write(`--- ${name}: PASS (${assertions.length} assertions)\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record = { name, status: 'fail', assertions, observations, data, firstFailure: message }
    process.stdout.write(`--- ${name}: FAIL — ${message}\n`)
  }
  scenarios.push(record)
  return record
}

// =================================================================================================
// Host process lifecycle helpers.
// =================================================================================================

function initInstance(instance: string): unknown {
  const out = execFileSync(
    'node',
    [HOST_SCRIPT, 'init-instance', '--cutroom', CUTROOM_RUNTIME, '--expect-revision', CUTROOM_REVISION, '--instance', instance],
    { env: hostChildEnv(), encoding: 'utf8' },
  )
  return JSON.parse(out.trim())
}

async function startApiRole(instance: string, port = 0): Promise<{ host: SpawnedHost; readiness: Readiness }> {
  const args = [
    'api',
    '--cutroom',
    CUTROOM_RUNTIME,
    '--expect-revision',
    CUTROOM_REVISION,
    '--instance',
    instance,
    '--port',
    String(port),
  ]
  const host = spawnHost('api', HOST_SCRIPT, args)
  allSpawned.push(host)
  const readiness = await waitForReadiness(host)
  return { host, readiness }
}

async function startWorkerRole(
  instance: string,
  opts: { standinScript?: string; renderProfile?: 'default' | 'small'; leaseMs?: number; pollMs?: number } = {},
): Promise<{ host: SpawnedHost; readiness: Readiness }> {
  const args = ['worker', '--cutroom', CUTROOM_RUNTIME, '--expect-revision', CUTROOM_REVISION, '--instance', instance]
  if (opts.standinScript !== undefined) args.push('--standin-script', opts.standinScript)
  if (opts.renderProfile !== undefined) args.push('--render-profile', opts.renderProfile)
  if (opts.leaseMs !== undefined) args.push('--lease-ms', String(opts.leaseMs))
  if (opts.pollMs !== undefined) args.push('--poll-ms', String(opts.pollMs))
  const host = spawnHost('worker', HOST_SCRIPT, args)
  allSpawned.push(host)
  const readiness = await waitForReadiness(host, 30_000)
  return { host, readiness }
}

// =================================================================================================
// Shared verification: a finished, completed video run.
// =================================================================================================

interface VideoVerification {
  result: RunResultLike
  record: RunRecordLike
  videoSha256: string
  videoFfprobe: unknown
  stillsCount: number
}

async function verifyCompletedVideo(
  client: ReturnType<typeof createCutroomHttpClient>,
  ref: CutroomRunRef,
  artifactRoot: string,
): Promise<VideoVerification> {
  const resultResp = await client.result(ref)
  if (!('kind' in resultResp) || resultResp.kind !== 'ok') {
    throw new Error(`result() did not return ok: ${JSON.stringify(resultResp)}`)
  }
  const result = resultResp.value as unknown as RunResultLike
  if (result.status !== 'completed' || result.until !== 'video') {
    throw new Error(`expected a completed video result, observed: ${JSON.stringify(result)}`)
  }
  if (result.video === undefined) throw new Error('completed video result names no video')

  const recordResp = await client.record(ref)
  if (!('kind' in recordResp) || recordResp.kind !== 'ok') {
    throw new Error(`record() did not return ok: ${JSON.stringify(recordResp)}`)
  }
  const record = recordResp.value as unknown as RunRecordLike
  if (record.takes.length === 0) throw new Error('record.takes is empty for a completed video run')
  if (!record.takes.some((t) => t.used === true)) throw new Error('no take in the record has used:true')

  const videoPath = result.video.path
  const videoContainment = checkContained(artifactRoot, videoPath)
  if (!videoContainment.ok) throw new Error(`video path is not contained in the artifact root: ${videoContainment.reason}`)
  const videoFfprobe = ffprobeJson(videoPath)
  const videoSha256 = sha256File(videoPath)

  const stills = result.stills ?? []
  for (const still of stills) {
    const containment = checkContained(artifactRoot, still.path)
    if (!containment.ok) throw new Error(`still path '${still.path}' is not contained: ${containment.reason}`)
  }

  return { result, record, videoSha256, videoFfprobe, stillsCount: stills.length }
}

// =================================================================================================
// main
// =================================================================================================

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const receiptOverride = argv[0] !== undefined && !argv[0].startsWith('--') ? resolve(argv[0]) : undefined

  process.stdout.write(`Joined proof run stamp: ${RUN_STAMP}\n`)
  process.stdout.write(`node ${process.version} (${process.execPath})\n`)

  const nodeVersionOk = (() => {
    const parts = process.version.replace(/^v/, '').split('.').map(Number)
    const major = parts[0]
    const minor = parts[1]
    return major !== undefined && minor !== undefined && (major > 22 || (major === 22 && minor >= 18))
  })()
  if (!nodeVersionOk) {
    throw new Error(`node ${process.version} does not default to type stripping; this journey requires 22.18+`)
  }

  const knowscrollHead = gitOf(REPO_ROOT, ['rev-parse', 'HEAD'])
  const runtimeBefore = runtimeSnapshot()
  if (runtimeBefore.head.toLowerCase() !== CUTROOM_REVISION.toLowerCase()) {
    throw new Error(`the pinned runtime is at ${runtimeBefore.head}, expected ${CUTROOM_REVISION}`)
  }
  const hostSha256 = sha256File(HOST_SCRIPT)
  const ffmpegVer = ffmpegVersion()

  // -----------------------------------------------------------------------------------------
  // S0 — prepare-runtime.sh verify mode, then init-instance.
  // -----------------------------------------------------------------------------------------
  const s0Instance = instancePath('s0')
  await runScenario('S0 prepare-runtime verify + init-instance', async (t) => {
    const out = execFileSync(PREPARE_RUNTIME_SCRIPT, [CUTROOM_CANONICAL_CLONE, CUTROOM_REVISION, CUTROOM_RUNTIME], {
      env: hostChildEnv(),
      encoding: 'utf8',
    })
    const verify = JSON.parse(out.trim()) as { verified: boolean }
    t.record('prepareRuntimeVerify', verify)
    t.assert(verify.verified === true, 'prepare-runtime.sh verify mode reports verified:true', out.trim())

    const init = initInstance(s0Instance) as { initialized: boolean; idempotent: boolean }
    t.record('initInstance', init)
    t.assert(init.initialized === true && init.idempotent === false, 'init-instance created a fresh instance')
    t.assert(existsSync(join(s0Instance, 'instance.json')), 'instance.json exists after init-instance')
    t.assert(existsSync(join(s0Instance, 'BUDGET.md')), 'BUDGET.md exists after init-instance')

    const initAgain = initInstance(s0Instance) as { initialized: boolean; idempotent: boolean }
    t.assert(initAgain.initialized === true && initAgain.idempotent === true, 'init-instance is idempotent on rerun')
  })

  // -----------------------------------------------------------------------------------------
  // Group A — protocol scenarios (S1-S6) against one api-only instance.
  // -----------------------------------------------------------------------------------------
  const groupAInstance = instancePath('protocol')
  let groupAApi: { host: SpawnedHost; readiness: Readiness } | undefined
  try {
    initInstance(groupAInstance)
    groupAApi = await startApiRole(groupAInstance)
    const apiOrigin = groupAApi.readiness.baseUrl
    if (apiOrigin === undefined) throw new Error('api readiness carried no baseUrl')
    const client = createCutroomHttpClient({ origin: apiOrigin })
    const { bundle: completeVideoBundle } = loadBundle('complete-video')
    const protocolRequest = cloneRequest(completeVideoBundle.request)
    protocolRequest.requestId = `${protocolRequest.requestId}-protocol-${RUN_STAMP}`
    const preparedOriginal = prepareCutroomRequest(protocolRequest)

    let sharedRunId: string | undefined

    await runScenario('S1 prepare + submit -> accepted, replayed=false', async (t) => {
      const submitted = await client.submit(preparedOriginal)
      t.record('submit', submitted)
      if (!('kind' in submitted) || submitted.kind !== 'accepted') {
        throw new Error(`submit did not accept: ${JSON.stringify(submitted)}`)
      }
      t.assert(submitted.value.outcome === 'accepted', 'submit outcome is accepted')
      t.assert(submitted.value.replayed === false, 'a brand-new submit is not replayed')
      sharedRunId = submitted.value.runId
      t.observe(`runId ${sharedRunId} accepted for requestId ${protocolRequest.requestId}`)
    })

    await runScenario('S2 exact replay of the same prepared bytes -> replayed=true, same runId', async (t) => {
      if (sharedRunId === undefined) throw new Error('S1 did not produce a runId')
      const submitted = await client.submit(preparedOriginal)
      t.record('submit', submitted)
      if (!('kind' in submitted) || submitted.kind !== 'accepted') {
        throw new Error(`replay submit did not accept: ${JSON.stringify(submitted)}`)
      }
      t.assert(submitted.value.replayed === true, 'an exact replay reports replayed:true')
      t.assert(submitted.value.runId === sharedRunId, 'an exact replay reports the same runId', `${submitted.value.runId} vs ${sharedRunId}`)
    })

    await runScenario('S3 same requestId, different body -> 409 conflict', async (t) => {
      const conflicting = cloneRequest(protocolRequest)
      conflicting.options = { ...conflicting.options, budgetCents: conflicting.options.budgetCents + 1 }
      const preparedConflict = prepareCutroomRequest(conflicting)
      const submitted = await client.submit(preparedConflict)
      t.record('submit', submitted)
      if (!('kind' in submitted) || submitted.kind !== 'refused') {
        throw new Error(`expected a refused conflict, got: ${JSON.stringify(submitted)}`)
      }
      t.assert(submitted.value.reason === 'conflict', 'the server refuses a same-id different-body submit as conflict (409)')
    })

    await runScenario('S4 server-side invalid body (422) + client-local unsupported planVaryOn refusal', async (t) => {
      const invalidRequestId = `${protocolRequest.requestId}-invalid`
      const malformed = {
        contractVersion: 1,
        requestId: invalidRequestId,
        worldId: 'world-1',
        narration: [{ text: 'too short', claimIds: [] }],
        claims: [],
        criteria: { mustShow: [], mustNotShow: [], depictionPolicyVersion: 'v1' },
        style: { id: 'style-1', version: 1, text: 'style' },
        options: { until: 'plan', budgetCents: 100 },
      }
      const raw = await fetch(`${apiOrigin}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(malformed),
      })
      const body = (await raw.json()) as { outcome?: string; reason?: string }
      t.record('rawInvalidSubmit', { status: raw.status, body })
      t.assert(raw.status === 422, 'a schema-invalid body (narration < 4 sentences) is rejected 422', String(raw.status))
      t.assert(body.outcome === 'refused' && body.reason === 'invalid', 'the 422 refusal reason is invalid', JSON.stringify(body))

      const unsupported = cloneRequest(protocolRequest)
      unsupported.requestId = `${protocolRequest.requestId}-unsupported-varyon`
      unsupported.options = { ...unsupported.options, planVaryOn: 'angle' }
      let threw = false
      try {
        prepareCutroomRequest(unsupported)
      } catch {
        threw = true
      }
      t.assert(threw, "prepareCutroomRequest rejects planVaryOn:'angle' locally, before any HTTP call")
    })

    await runScenario('S5 lost response, reconciled by requestId, then a genuine replay', async (t) => {
      const port = groupAApi?.readiness.port
      if (port === undefined) throw new Error('api readiness carried no port')
      const proxy = await createLostResponseProxy({ host: '127.0.0.1', port })
      try {
        const proxyClient = createCutroomHttpClient({ origin: proxy.origin })
        const lostRequest = cloneRequest(protocolRequest)
        lostRequest.requestId = `${protocolRequest.requestId}-lost-response`
        const preparedLost = prepareCutroomRequest(lostRequest)

        proxy.arm()
        const lostSubmit = await proxyClient.submit(preparedLost)
        t.record('lostSubmit', lostSubmit)
        t.assert(
          'kind' in lostSubmit && lostSubmit.kind === 'transport_error',
          'a genuinely lost response surfaces as a transport_error',
          JSON.stringify(lostSubmit),
        )
        if ('kind' in lostSubmit && lostSubmit.kind === 'transport_error') {
          t.assert(lostSubmit.writeUncertain === true, 'the lost POST is reported write-uncertain')
        }
        t.assert(proxy.dropped.length === 1, 'the proxy dropped exactly the one armed connection', String(proxy.dropped.length))

        const lookup = await client.lookup(lostRequest.requestId)
        t.record('lookupAfterLoss', lookup)
        if (!('kind' in lookup) || lookup.kind !== 'ok') {
          throw new Error(`lookup by the original requestId did not find the run: ${JSON.stringify(lookup)}`)
        }
        const runId = lookup.value.runId
        t.observe(`the server genuinely processed the lost submit: runId ${runId} exists for requestId ${lostRequest.requestId}`)

        const replay = await client.submit(preparedLost)
        t.record('replayAfterLoss', replay)
        if (!('kind' in replay) || replay.kind !== 'accepted') {
          throw new Error(`the later exact replay did not accept: ${JSON.stringify(replay)}`)
        }
        t.assert(replay.value.replayed === true, 'the later exact replay reports replayed:true')
        t.assert(replay.value.runId === runId, 'the replay names the same runId the lookup found')

        const rows = queryRunRows(groupAApi?.readiness.dbPath ?? '', lostRequest.requestId)
        t.record('runRowsForRequestId', rows)
        t.assert(rows.length === 1 && rows[0]?.run_id === runId, 'exactly one run row exists for this requestId', JSON.stringify(rows))
      } finally {
        await proxy.close()
      }
    })

    await runScenario('S6 lookup of an absent requestId -> 404', async (t) => {
      const missingId = `does-not-exist-${RUN_STAMP}`
      const lookup = await client.lookup(missingId)
      t.record('lookup', lookup)
      t.assert('kind' in lookup && lookup.kind === 'not_found', 'a lookup for an unused requestId is not_found', JSON.stringify(lookup))
      t.observe('this is a current observation only: absence now does not certify absence later')
    })
  } finally {
    if (groupAApi !== undefined) {
      try {
        await gracefulStop(groupAApi.host)
      } catch (error) {
        process.stderr.write(`warning: group A api did not stop gracefully: ${String(error)}\n`)
      }
    }
  }

  // -----------------------------------------------------------------------------------------
  // S7 — a complete video run.
  // -----------------------------------------------------------------------------------------
  const s7Instance = instancePath('complete-video')
  await runScenario('S7 complete video run', async (t) => {
    const { bundle, standinPath } = loadBundle('complete-video')
    initInstance(s7Instance)
    const api = await startApiRole(s7Instance)
    allSpawned.push(api.host)
    const worker = await startWorkerRole(s7Instance, { standinScript: standinPath, renderProfile: 'small' })
    try {
      const origin = api.readiness.baseUrl
      if (origin === undefined) throw new Error('api readiness carried no baseUrl')
      const client = createCutroomHttpClient({ origin })
      const request = cloneRequest(bundle.request)
      request.requestId = `${request.requestId}-${RUN_STAMP}`
      const prepared = prepareCutroomRequest(request)
      const startedAt = Date.now()
      const submitted = await client.submit(prepared)
      t.record('submit', submitted)
      if (!('kind' in submitted) || submitted.kind !== 'accepted') throw new Error(`submit failed: ${JSON.stringify(submitted)}`)
      const ref: CutroomRunRef = { requestId: request.requestId, runId: submitted.value.runId, until: 'video' }
      t.observe(`runId ${ref.runId}`)

      let cursor = 0
      let finished = false
      const events: RunEventLike[] = []
      const deadline = Date.now() + 60_000
      while (!finished) {
        if (Date.now() > deadline) throw new Error(`run ${ref.runId} did not finish within 60s (cursor ${cursor})`)
        const page = await client.events(ref, cursor)
        if (!('kind' in page) || page.kind !== 'ok') throw new Error(`events(${cursor}) failed: ${JSON.stringify(page)}`)
        for (const event of page.value.events as unknown as RunEventLike[]) {
          events.push(event)
          if (event.type === 'run.finished') finished = true
        }
        cursor = page.value.nextSince
        if (!finished) await sleep(100)
      }
      const wallMs = Date.now() - startedAt
      t.record('wallMs', wallMs)
      t.observe(`wall time submit-to-finished: ${wallMs}ms (small render profile)`)
      assertSeqContinuity(events, 'S7 strict cursor paging')
      t.assert(true, 'strict cursor paging reached run.finished with continuous seqs', `${events.length} events`)

      const verification = await verifyCompletedVideo(client, ref, api.readiness.artifactRoot)
      t.record('result', verification.result)
      t.record('record', { takes: verification.record.takes.length, used: verification.record.takes.filter((x) => x.used).length })
      t.assert(true, 'result is completed/video with a contained, ffprobe-readable video', verification.result.video?.path)
      t.record('videoSha256', verification.videoSha256)
      t.record('videoFfprobe', verification.videoFfprobe)
      t.observe(`${verification.record.takes.length} takes, ${verification.record.takes.filter((x) => x.used).length} used:true`)
      t.observe(`${verification.stillsCount} stills all contained in the instance artifact root`)
    } finally {
      try {
        await gracefulStop(worker.host)
      } catch (error) {
        process.stderr.write(`warning: S7 worker did not stop gracefully: ${String(error)}\n`)
      }
      try {
        await gracefulStop(api.host)
      } catch (error) {
        process.stderr.write(`warning: S7 api did not stop gracefully: ${String(error)}\n`)
      }
    }
  })

  // -----------------------------------------------------------------------------------------
  // S8 — graceful restart mid-run, resumed by a separate reconstructed-caller process.
  // -----------------------------------------------------------------------------------------
  const s8Instance = instancePath('graceful-restart')
  await runScenario('S8 graceful restart mid-run, resumed by a reconstructed caller', async (t) => {
    const { bundle, standinPath } = loadBundle('complete-video')
    initInstance(s8Instance)
    const api1 = await startApiRole(s8Instance)
    allSpawned.push(api1.host)
    const worker1 = await startWorkerRole(s8Instance, { standinScript: standinPath, renderProfile: 'small' })
    const origin1 = api1.readiness.baseUrl
    const port1 = api1.readiness.port
    if (origin1 === undefined || port1 === undefined) throw new Error('api1 readiness carried no baseUrl/port')

    const client1 = createCutroomHttpClient({ origin: origin1 })
    const request = cloneRequest(bundle.request)
    request.requestId = `${request.requestId}-s8-${RUN_STAMP}`
    const prepared = prepareCutroomRequest(request)
    const submitted = await client1.submit(prepared)
    t.record('submit', submitted)
    if (!('kind' in submitted) || submitted.kind !== 'accepted') throw new Error(`submit failed: ${JSON.stringify(submitted)}`)
    const runId = submitted.value.runId
    const ref: CutroomRunRef = { requestId: request.requestId, runId, until: 'video' }

    const intentPath = join(s8Instance, 'intent.json')
    saveIntent(intentPath, { requestId: request.requestId, runId, preparedBody: prepared.body, bodySha256: prepared.bodySha256, nextSince: 0 })
    t.observe(`intent persisted after acceptance at ${intentPath}`)

    // No holdAtCall is used anywhere in this scenario (that would make a *graceful* stop hang
    // forever: worker.stop() awaits the job currently in hand, and a held model call never
    // resolves). Instead this deliberately keeps polling/persisting past the first observed event,
    // for a bounded window chosen from phase 1's own timings (reel.clips is the run's real-ffmpeg,
    // multi-second stage; see S9's job-timing evidence in the receipt), so the graceful stop is
    // very likely to land while a genuinely time-consuming job is actually in flight — a stronger
    // "mid-run" demonstration than stopping the instant the first event appears, while still never
    // risking a hang, since every job this worker starts is guaranteed to finish before the stop is
    // honored (no truncated or held script is used).
    const INTERRUPT_BUDGET_MS = 900
    const preRestartEvents: RunEventLike[] = []
    let cursor = 0
    let alreadyFinished = false
    const observeDeadline = Date.now() + 20_000
    const interruptAt = Date.now() + INTERRUPT_BUDGET_MS
    for (;;) {
      if (Date.now() > observeDeadline) throw new Error(`no event was observed for run ${runId} within 20s`)
      const page = await client1.events(ref, cursor)
      if (!('kind' in page) || page.kind !== 'ok') throw new Error(`events(${cursor}) failed: ${JSON.stringify(page)}`)
      const pageEvents = page.value.events as unknown as RunEventLike[]
      for (const event of pageEvents) {
        preRestartEvents.push(event)
        if (event.type === 'run.finished') alreadyFinished = true
      }
      cursor = page.value.nextSince
      saveIntent(intentPath, { requestId: request.requestId, runId, preparedBody: prepared.body, bodySha256: prepared.bodySha256, nextSince: cursor })
      if (alreadyFinished) break
      if (preRestartEvents.length > 0 && Date.now() >= interruptAt) break
      await sleep(20)
    }
    t.assert(preRestartEvents.length > 0, 'at least one event was observed before restarting')
    if (alreadyFinished) {
      throw new Error(
        `the run reached run.finished before a graceful mid-run stop could be attempted (observed ${preRestartEvents.length} events); ` +
          'this scenario needs a run that has not finished when the workers are stopped',
      )
    }
    t.observe(`${preRestartEvents.length} pre-restart events observed before stopping (cursor ${cursor}), after a ${INTERRUPT_BUDGET_MS}ms interrupt budget`)

    const jobsBeforeStop = queryJobRows(api1.readiness.dbPath, runId)
    t.record('jobsBeforeStop', jobsBeforeStop)

    // Graceful: worker.stop() finishes whichever job is currently in hand before it honors the
    // signal, so this can never hang (no holdAtCall is used anywhere in this scenario).
    const workerStopped = await withTimeout(gracefulStop(worker1.host), 30_000, 'S8 worker1 graceful stop')
    t.assert(workerStopped.stopped === true, 'worker1 reports {"stopped":true} on SIGTERM')
    const apiStopped = await withTimeout(gracefulStop(api1.host), 30_000, 'S8 api1 graceful stop')
    t.assert(apiStopped.stopped === true, 'api1 reports {"stopped":true} on SIGTERM')

    const runRowAfterStop = queryRunRows(s8Instance + '/cutroom.sqlite', request.requestId)
    void runRowAfterStop // path built below instead; kept for clarity that we read straight after stopping
    const dbPath = api1.readiness.dbPath
    const runRows = queryRunRows(dbPath, request.requestId)
    t.record('runRowAfterStop', runRows)
    t.assert(runRows.length === 1 && runRows[0]?.state === 'running', 'the run is genuinely still running when both processes stopped', JSON.stringify(runRows))

    const jobsAfterStop = queryJobRows(dbPath, runId)
    t.record('jobsAfterStop', jobsAfterStop)
    t.observe(`jobs after graceful stop: ${jobsAfterStop.map((j) => `${j.kind}=${j.state}`).join(', ')}`)

    const api2 = await startApiRole(s8Instance, port1)
    allSpawned.push(api2.host)
    t.assert(api2.readiness.port === port1, 'api2 restarted on the exact same port', `${api2.readiness.port} vs ${port1}`)
    const worker2 = await startWorkerRole(s8Instance, { standinScript: standinPath, renderProfile: 'small' })
    const origin2 = api2.readiness.baseUrl
    if (origin2 === undefined) throw new Error('api2 readiness carried no baseUrl')

    try {
      const callerArgs = ['exec', 'tsx', RECONSTRUCTED_CALLER_SCRIPT, '--intent', intentPath, '--origin', origin2, '--timeout-ms', '45000']
      const caller = spawnProcess('reconstructed-caller', 'pnpm', callerArgs, { env: process.env as NodeJS.ProcessEnv, cwd: REPO_ROOT })
      allSpawned.push(caller)
      const callerExit = await withTimeout(caller.exited, 60_000, 'reconstructed caller exit')
      t.record('reconstructedCallerStdout', caller.stdoutLines)
      t.record('reconstructedCallerStderr', caller.stderrLines)
      t.assert(callerExit.code === 0, 'the reconstructed caller process exits 0', JSON.stringify(callerExit) + ' ' + caller.stderrLines.join(' | '))

      const postRestartEvents: RunEventLike[] = []
      for (const line of caller.stdoutLines) {
        try {
          const parsed = JSON.parse(line) as { resumedEvent?: RunEventLike }
          if (parsed.resumedEvent !== undefined) postRestartEvents.push(parsed.resumedEvent)
        } catch {
          // non-JSON progress line; ignore
        }
      }
      t.assert(postRestartEvents.length > 0, 'the reconstructed caller resumed at least one event')
      assertSeqContinuity([...preRestartEvents, ...postRestartEvents], 'S8 cross-process seq continuity')
      t.observe(
        `${preRestartEvents.length} pre-restart + ${postRestartEvents.length} post-restart events, seq-continuous with no regression or duplication`,
      )

      const client2 = createCutroomHttpClient({ origin: origin2 })
      const verification = await verifyCompletedVideo(client2, ref, api2.readiness.artifactRoot)
      t.record('result', verification.result)
      t.record('record', { takes: verification.record.takes.length, used: verification.record.takes.filter((x) => x.used).length })
      t.assert(true, 'after restart the run reaches completed/video with a contained, ffprobe-readable video')
      t.record('videoSha256', verification.videoSha256)
    } finally {
      try {
        await gracefulStop(worker2.host)
      } catch (error) {
        process.stderr.write(`warning: S8 worker2 did not stop gracefully: ${String(error)}\n`)
      }
      try {
        await gracefulStop(api2.host)
      } catch (error) {
        process.stderr.write(`warning: S8 api2 did not stop gracefully: ${String(error)}\n`)
      }
    }
  })

  // -----------------------------------------------------------------------------------------
  // S9 — crash recovery via SIGKILL, upstream-validated holdAtCall + clipsScript(takes) pattern.
  // -----------------------------------------------------------------------------------------
  const s9Instance = instancePath('crash-restart')
  await runScenario('S9 crash: SIGKILL worker and api, restart, and reclaim the abandoned job', async (t) => {
    const { bundle: firstBundle, standinPath: firstStandin } = loadBundle('restart-first')
    const { standinPath: secondStandin } = loadBundle('restart-second')
    const leaseMs = firstBundle.recommendedLeaseMs ?? 1000
    t.observe(`using recommendedLeaseMs=${leaseMs} from phase 1's upstream-validated restart fixture`)

    initInstance(s9Instance)
    const api1 = await startApiRole(s9Instance)
    allSpawned.push(api1.host)
    const worker1 = await startWorkerRole(s9Instance, { standinScript: firstStandin, renderProfile: 'small', leaseMs })

    const origin1 = api1.readiness.baseUrl
    const port1 = api1.readiness.port
    if (origin1 === undefined || port1 === undefined) throw new Error('api1 readiness carried no baseUrl/port')
    const client1 = createCutroomHttpClient({ origin: origin1 })
    const request = cloneRequest(firstBundle.request)
    request.requestId = `${request.requestId}-s9-${RUN_STAMP}`
    const prepared = prepareCutroomRequest(request)
    const submitted = await client1.submit(prepared)
    t.record('submit', submitted)
    if (!('kind' in submitted) || submitted.kind !== 'accepted') throw new Error(`submit failed: ${JSON.stringify(submitted)}`)
    const runId = submitted.value.runId
    const ref: CutroomRunRef = { requestId: request.requestId, runId, until: 'video' }

    const held = await waitForHeld(worker1.host, 0, 30_000)
    t.assert(held.value.call === 12, "worker1 holds at model call 12 (shot 0's reconcile call)", String(held.value.call))

    const killedWorker = await withTimeout(forceKill(worker1.host), 10_000, 'S9 worker1 SIGKILL')
    t.assert(killedWorker.signal === 'SIGKILL', 'worker1 was actually killed by SIGKILL', JSON.stringify(killedWorker))
    const killedApi = await withTimeout(forceKill(api1.host), 10_000, 'S9 api1 SIGKILL')
    t.assert(killedApi.signal === 'SIGKILL', 'api1 was actually killed by SIGKILL', JSON.stringify(killedApi))

    await sleep(leaseMs + 500)

    const api2 = await startApiRole(s9Instance, port1)
    allSpawned.push(api2.host)
    t.assert(api2.readiness.port === port1, 'api2 restarted on the exact same port')
    const worker2 = await startWorkerRole(s9Instance, { standinScript: secondStandin, renderProfile: 'small', leaseMs })
    const origin2 = api2.readiness.baseUrl
    if (origin2 === undefined) throw new Error('api2 readiness carried no baseUrl')
    const client2 = createCutroomHttpClient({ origin: origin2 })

    let finished = false
    const deadline = Date.now() + 60_000
    while (!finished) {
      if (Date.now() > deadline) throw new Error(`run ${runId} did not reach a terminal state within 60s of restart`)
      const status = await client2.status(ref)
      if ('kind' in status && status.kind === 'ok' && status.value.state === 'finished') finished = true
      else await sleep(200)
    }

    const verification = await verifyCompletedVideo(client2, ref, api2.readiness.artifactRoot)
    t.record('result', verification.result)
    t.record('record', { takes: verification.record.takes.length, used: verification.record.takes.filter((x) => x.used).length })
    t.assert(true, 'after the crash+restart the run completed a video with a contained, ffprobe-readable file')
    t.observe(`${verification.record.takes.length} takes recorded, ${verification.record.takes.filter((x) => x.used).length} used:true`)

    const fullEvents = await client2.events(ref, 0)
    if (!('kind' in fullEvents) || fullEvents.kind !== 'ok') throw new Error(`events(0) failed: ${JSON.stringify(fullEvents)}`)
    assertSeqContinuity(fullEvents.value.events as unknown as RunEventLike[], 'S9 full event history after crash recovery')
    t.assert(true, 'the full event history (across the api restart) is seq-continuous with no gaps or duplicates')

    const jobs = queryJobRows(api2.readiness.dbPath, runId)
    t.record('jobsAfterRecovery', jobs)
    const clipsJob = jobs.find((j) => j.kind === 'reel.clips')
    t.assert(clipsJob !== undefined && clipsJob.attempts === 2, 'reel.clips was reclaimed and run a second time', JSON.stringify(clipsJob))

    try {
      await gracefulStop(worker2.host)
    } catch (error) {
      process.stderr.write(`warning: S9 worker2 did not stop gracefully: ${String(error)}\n`)
    }
    try {
      await gracefulStop(api2.host)
    } catch (error) {
      process.stderr.write(`warning: S9 api2 did not stop gracefully: ${String(error)}\n`)
    }
  })

  // -----------------------------------------------------------------------------------------
  // S10 — cancel.
  // -----------------------------------------------------------------------------------------
  const s10Instance = instancePath('cancel')
  await runScenario('S10 cancel with no worker, then observe what starting one produces', async (t) => {
    const { bundle } = loadBundle('cancel')
    initInstance(s10Instance)
    const api = await startApiRole(s10Instance)
    allSpawned.push(api.host)
    const origin = api.readiness.baseUrl
    if (origin === undefined) throw new Error('api readiness carried no baseUrl')
    const client = createCutroomHttpClient({ origin })

    const request = cloneRequest(bundle.request)
    request.requestId = `${request.requestId}-${RUN_STAMP}`
    const prepared = prepareCutroomRequest(request)
    const submitted = await client.submit(prepared)
    t.record('submit', submitted)
    if (!('kind' in submitted) || submitted.kind !== 'accepted') throw new Error(`submit failed: ${JSON.stringify(submitted)}`)
    const ref: CutroomRunRef = { requestId: request.requestId, runId: submitted.value.runId, until: 'video' }

    const statusBefore = await client.status(ref)
    t.record('statusBeforeCancel', statusBefore)
    t.assert('kind' in statusBefore && statusBefore.kind === 'ok' && statusBefore.value.state === 'running', 'with no worker started, the run is running before cancel')

    const cancelled = await client.cancel(ref)
    t.record('cancelResponse', cancelled)
    if (!('kind' in cancelled) || cancelled.kind !== 'ok') throw new Error(`cancel() did not return a valid RunStatus: ${JSON.stringify(cancelled)}`)
    t.assert(true, 'cancel() returns a schema-valid RunStatus (per the contract)', JSON.stringify(cancelled.value))
    t.observe(`cancel response state: ${cancelled.value.state}`)

    const worker = await startWorkerRole(s10Instance, { renderProfile: 'small' })
    let finalState: string | undefined
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const status = await client.status(ref)
      if ('kind' in status && status.kind === 'ok') {
        finalState = status.value.state
        if (finalState === 'finished') break
      }
      await sleep(200)
    }
    t.record('finalState', finalState)
    t.observe(`state after starting a worker post-cancel (15s window): ${finalState ?? 'unknown'}`)

    if (finalState === 'finished') {
      const resultResp = await client.result(ref)
      const recordResp = await client.record(ref)
      t.record('result', 'kind' in resultResp && resultResp.kind === 'ok' ? resultResp.value : resultResp)
      t.record('record', 'kind' in recordResp && recordResp.kind === 'ok' ? recordResp.value : recordResp)
      t.observe(
        `actual terminal result upstream produced after a cancel with no worker, then a worker started: ${JSON.stringify(
          'kind' in resultResp && resultResp.kind === 'ok' ? resultResp.value : resultResp,
        )}`,
      )
    } else {
      t.observe('the run had not reached a terminal state within the 15s observation window; this is reported as-is, not forced')
    }

    try {
      await gracefulStop(worker.host)
    } catch (error) {
      process.stderr.write(`warning: S10 worker did not stop gracefully: ${String(error)}\n`)
    }
    try {
      await gracefulStop(api.host)
    } catch (error) {
      process.stderr.write(`warning: S10 api did not stop gracefully: ${String(error)}\n`)
    }
  })

  // -----------------------------------------------------------------------------------------
  // S11 — cleanup verification.
  // -----------------------------------------------------------------------------------------
  const runtimeAfter = runtimeSnapshot()
  const instanceDirs = readdirSync(INSTANCES_ROOT)
    .filter((name) => name.startsWith(`proof-${RUN_STAMP}-`))
    .map((name) => {
      const full = join(INSTANCES_ROOT, name)
      return { name, path: full, bytes: dirSizeBytes(full) }
    })

  await runScenario('S11 cleanup: processes gone, runtime unchanged, instances listed', async (t) => {
    for (const host of allSpawned) {
      const exit = await withTimeout(host.exited, 5_000, `${host.role} final exit check`).catch(async () => {
        process.stderr.write(`warning: forcing kill of a lingering ${host.role} process at cleanup\n`)
        return forceKill(host, 5_000)
      })
      t.assert(exit.code !== undefined, `${host.role} process has exited by cleanup time`, JSON.stringify(exit))
    }
    const psOut = execFileSync('sh', ['-c', "ps aux | grep -i 'cutroom-host/host.ts\\|reconstructed-caller' | grep -v grep || true"], {
      encoding: 'utf8',
    }).trim()
    t.record('psAfterCleanup', psOut)
    t.assert(psOut === '', 'no host.ts or reconstructed-caller process remains in ps', psOut)

    t.record('runtimeBefore', runtimeBefore)
    t.record('runtimeAfter', runtimeAfter)
    t.assert(runtimeAfter.head === runtimeBefore.head, 'the pinned runtime HEAD is unchanged')
    t.assert(runtimeAfter.ignoredStatus === runtimeBefore.ignoredStatus, 'the pinned runtime ignored/tracked git status is unchanged', `before=${runtimeBefore.ignoredStatus} after=${runtimeAfter.ignoredStatus}`)
    t.assert(JSON.stringify(runtimeAfter.lsA) === JSON.stringify(runtimeBefore.lsA), 'the pinned runtime top-level listing is unchanged')

    t.record('instanceDirs', instanceDirs)
    for (const dir of instanceDirs) t.observe(`kept: ${dir.path} (${dir.bytes} bytes)`)
  })

  // -----------------------------------------------------------------------------------------
  // Receipts.
  // -----------------------------------------------------------------------------------------
  const overallStatus = scenarios.every((s) => s.status === 'pass') ? 'pass' : 'fail'
  const fullReceipt = {
    label: 'real local service with upstream stand-in providers — never real generation, never product acceptance',
    runStamp: RUN_STAMP,
    knowscrollHead,
    cutroomRevision: CUTROOM_REVISION,
    cutroomRuntime: CUTROOM_RUNTIME,
    hostSha256,
    node: process.version,
    execPath: process.execPath,
    ffmpegVersion: ffmpegVer,
    overallStatus,
    scenarios,
    runtimeBefore,
    runtimeAfter,
    instanceDirs,
  }

  mkdirSync(LOGS_ROOT, { recursive: true })
  const receiptPath = receiptOverride ?? join(LOGS_ROOT, `joined-proof-${RUN_STAMP}.json`)
  writeFileSync(receiptPath, `${JSON.stringify(fullReceipt, null, 2)}\n`)
  process.stdout.write(`\nFull receipt: ${receiptPath}\n`)

  const sanitized = JSON.parse(JSON.stringify(fullReceipt)) as Record<string, unknown>
  delete sanitized.env
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const snapshotPath = join(EVIDENCE_DIR, 'joined-proof.json')
  writeFileSync(snapshotPath, `${JSON.stringify(sanitized, null, 2)}\n`)
  process.stdout.write(`Sanitized snapshot: ${snapshotPath}\n`)

  process.stdout.write(`\nOverall: ${overallStatus.toUpperCase()}\n`)
  for (const s of scenarios) {
    process.stdout.write(`  ${s.status === 'pass' ? 'PASS' : 'FAIL'}  ${s.name}${s.firstFailure === undefined ? '' : ` — ${s.firstFailure}`}\n`)
  }

  if (overallStatus !== 'pass') process.exitCode = 1
}

await main()
