/**
 * ADR-0021 section 3 — the host's own proof, run with plain `node` against the pinned,
 * read-only Cutroom runtime and fresh instances under `$KS_DEV_ROOT/cutroom/instances/`.
 *
 * This proves "real local service with upstream stand-in providers": upstream's own API and
 * worker, its own stand-in providers plus real ffmpeg, started by this host. It never proves real
 * generation, and it never calls a provider or reads a provider key.
 *
 * `node ops/cutroom-host/self-check.ts`
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeVersionOk } from './host.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_TS = join(HERE, 'host.ts')
const REPO_ROOT = resolve(HERE, '..', '..')

const devRootEnv = process.env.KS_DEV_ROOT
if (devRootEnv === undefined || devRootEnv === '') {
  throw new Error('KS_DEV_ROOT must be set — source scripts/env.sh before running self-check.ts')
}
/** Explicitly typed `string` (not the union `process.env` gives) so closures below see it as such. */
const DEV_ROOT: string = devRootEnv

/** The pinned, read-only runtime this proof runs against (ADR-0021). Overridable for local reruns. */
const RUNTIME = process.env.CUTROOM_RUNTIME_DIR ?? '/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742'
const REVISION = process.env.CUTROOM_EXPECT_REVISION ?? '86d6e2c8b74228db4a5a953e53c53a7b77cef46e'

function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

const RUN_STAMP = utcStamp()
let instanceCounter = 0

/** A fresh instance directory under the required naming convention, tracked for the receipt. */
const instanceDirs: string[] = []
function newInstanceDir(label: string): string {
  instanceCounter += 1
  const dir = join(DEV_ROOT, 'cutroom', 'instances', `host-selfcheck-${RUN_STAMP}-${String(instanceCounter).padStart(2, '0')}-${label}`)
  instanceDirs.push(dir)
  return dir
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** PATH, HOME, TMPDIR, KS_DEV_ROOT, LANG only — no provider key or product secret ever reaches a child. */
function allowlistedEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'KS_DEV_ROOT', 'LANG']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...extra }
}

// -------------------------------------------------------------------------------------------
// Receipt.
// -------------------------------------------------------------------------------------------

interface InstanceRecordShape {
  createdAt: string
  cutroomRevision: string
  budgetSource: string
  budgetSha256: string
  hostSha256: string
}

interface CheckEntry {
  name: string
  ok: boolean
  detail: string
}
const checks: CheckEntry[] = []

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  process.stdout.write(`[self-check] ${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}\n`)
}

function must(name: string, condition: boolean, detail: string): void {
  record(name, condition, detail)
}

// -------------------------------------------------------------------------------------------
// Refusal proof helpers (part a).
// -------------------------------------------------------------------------------------------

interface SpawnResult {
  status: number | null
  stdout: string
  stderr: string
}

function runHostSync(args: readonly string[], env: NodeJS.ProcessEnv): SpawnResult {
  try {
    const stdout = execFileSync('node', [HOST_TS, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string; stderr?: string }
    return { status: e.status ?? null, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

function expectRefusal(
  name: string,
  args: readonly string[],
  expectedReason: string,
  options: { env?: NodeJS.ProcessEnv; forbidden?: readonly string[] } = {},
): void {
  const env = options.env ?? allowlistedEnv()
  const result = runHostSync(args, env)
  if (result.status !== 2) {
    record(name, false, `expected exit 2, got ${String(result.status)}; stderr='${result.stderr.trim()}'`)
    return
  }
  const lines = result.stderr.trim().split('\n').filter((line) => line.length > 0)
  if (lines.length !== 1) {
    record(name, false, `expected exactly one stderr line, got ${lines.length}`)
    return
  }
  const line = lines[0] ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    record(name, false, `stderr line is not JSON: ${message(error)}`)
    return
  }
  const obj = parsed as { refused?: unknown; reason?: unknown; detail?: unknown }
  if (obj.refused !== true || obj.reason !== expectedReason || typeof obj.detail !== 'string') {
    record(name, false, `expected {refused:true,reason:'${expectedReason}',detail:string}, got ${line}`)
    return
  }
  for (const forbidden of options.forbidden ?? []) {
    if (result.stderr.includes(forbidden)) {
      record(name, false, `stderr leaked forbidden value '${forbidden}'`)
      return
    }
  }
  record(name, true, `exit 2, reason=${expectedReason}, detail='${obj.detail}'`)
}

const baseArgs = (instance: string, extra: readonly string[] = []): string[] => [
  'api',
  '--cutroom',
  RUNTIME,
  '--expect-revision',
  REVISION,
  '--instance',
  instance,
  ...extra,
]

// -------------------------------------------------------------------------------------------
// Long-running child (api/worker) helper.
// -------------------------------------------------------------------------------------------

interface RunningChild {
  child: ChildProcess
  readiness: Record<string, unknown>
  stdoutLines: string[]
  stderrLines: string[]
}
const runningChildren: RunningChild[] = []

function spawnHost(role: 'api' | 'worker', args: readonly string[], env: NodeJS.ProcessEnv): Promise<RunningChild> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [HOST_TS, role, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutLines: string[] = []
    const stderrLines: string[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error(`${role} did not become ready within 20s; stderr=${stderrLines.join(' | ')}`))
      }
    }, 20_000)
    let buffered = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      for (const line of parts) {
        if (line.length === 0) continue
        stdoutLines.push(line)
        if (!settled) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>
            if (parsed.ready === true) {
              settled = true
              clearTimeout(timer)
              resolvePromise({ child, readiness: parsed, stdoutLines, stderrLines })
            }
          } catch {
            // not the readiness line yet
          }
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrLines.push(...chunk.toString('utf8').split('\n').filter((l) => l.length > 0))
    })
    child.once('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`${role} exited early with code ${String(code)}; stderr=${stderrLines.join(' | ')}`))
      }
    })
    runningChildren.push({ child, readiness: {}, stdoutLines, stderrLines })
  })
}

/** Sends one signal, waits for `{"stopped":true}` on stdout and process exit, within `timeoutMs`. */
function stopGracefully(running: RunningChild, signal: NodeJS.Signals, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const seenStopLine = () => running.stdoutLines.some((line) => line.includes('"stopped":true'))
    if (seenStopLine() && running.child.exitCode !== null) {
      resolvePromise()
      return
    }
    const timer = setTimeout(() => reject(new Error(`process did not stop within ${timeoutMs}ms`)), timeoutMs)
    running.child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 && seenStopLine()) resolvePromise()
      else reject(new Error(`expected graceful exit 0 with a stopped line, got code ${String(code)}`))
    })
    running.child.kill(signal)
  })
}

function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  return fetch(url, init).then(async (response) => ({ status: response.status, body: await response.json() }))
}

function planRequestJson(requestId: string): unknown {
  // Shaped literally like upstream tests/engine/plans.ts `planRequest` at the pinned revision.
  return {
    contractVersion: 1,
    requestId,
    worldId: 'world-1',
    narration: [
      { text: 'In 1215 a charter was sealed at Runnymede.', claimIds: ['c1'] },
      { text: 'It bound a king to the law of the land.', claimIds: ['c1'] },
      { text: 'The barons who forced it were not democrats.', claimIds: ['c2'] },
      { text: 'They wanted their own privileges back.', claimIds: [] },
      { text: 'Within weeks the pope annulled it.', claimIds: ['c3'] },
      { text: 'Yet it was reissued three times.', claimIds: ['c2'] },
      { text: 'Each reissue shortened it.', claimIds: [] },
      { text: 'Three of its clauses are still law in England today.', claimIds: ['c4'] },
    ],
    claims: [
      { id: 'c1', role: 'main' },
      { id: 'c2', role: 'supporting' },
      { id: 'c3', role: 'supporting' },
      { id: 'c4', role: 'main' },
    ],
    criteria: {
      mustShow: [
        { id: 'm1', text: 'a wax seal on parchment', type: 'presence', claimId: 'c1' },
        { id: 'm2', text: 'a meadow beside a river', type: 'presence' },
      ],
      mustNotShow: [
        { id: 'n1', text: 'any real living person', type: 'presence' },
        { id: 'n2', text: 'a modern flag', type: 'presence', claimId: 'c4' },
      ],
      depictionPolicyVersion: 'policy-3',
    },
    style: { id: 'style-1', version: 2, text: 'quiet, precise, natural light' },
    options: { until: 'plan', budgetCents: 300 },
  }
}

// -------------------------------------------------------------------------------------------
// Scratch git repos for revision-mismatch / runtime-dirty (never the real runtime).
// -------------------------------------------------------------------------------------------

const scratchGitRepoDirs: string[] = []

function makeScratchGitRepo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(DEV_ROOT, 'tmp', 'host-selfcheck-scratch-'))
  scratchGitRepoDirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'selfcheck@example.invalid'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'self-check'], { cwd: dir })
  writeFileSync(join(dir, 'tracked.txt'), 'original\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  return { dir, head }
}

// -------------------------------------------------------------------------------------------
// Main.
// -------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write(
    `[self-check] runtime=${RUNTIME} revision=${REVISION} node=${process.version} devRoot=${DEV_ROOT}\n`,
  )

  // --- part a: every refusal code ---------------------------------------------------------

  must('node-version predicate: 22.17 rejected', !nodeVersionOk('22.17.0'), 'nodeVersionOk(22.17.0) === false')
  must('node-version predicate: 22.18 accepted', nodeVersionOk('22.18.0'), 'nodeVersionOk(22.18.0) === true')
  must('node-version predicate: current node accepted', nodeVersionOk(process.version), `nodeVersionOk(${process.version}) === true`)
  record(
    'node-version refusal (documented limitation)',
    true,
    'not exercised as a live spawn: the environment rules forbid invoking any Node other than the pinned one, so the refusal is proved as the pure predicate above plus its call site in checkNodeVersion(), not a live process on an unsupported binary.',
  )

  expectRefusal('usage: unknown role', ['bogus'], 'usage')
  expectRefusal('usage: missing --cutroom', ['api', '--expect-revision', REVISION, '--instance', newInstanceDir('unused-a')], 'usage')
  expectRefusal(
    'usage: flag not valid for role',
    ['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', newInstanceDir('unused-b'), '--port', '0'],
    'usage',
  )
  expectRefusal(
    'usage: malformed --expect-revision',
    ['api', '--cutroom', RUNTIME, '--expect-revision', 'not-hex', '--instance', newInstanceDir('unused-c')],
    'usage',
  )

  const scratchMismatch = makeScratchGitRepo()
  expectRefusal(
    'revision-mismatch: scratch repo HEAD differs',
    ['api', '--cutroom', scratchMismatch.dir, '--expect-revision', '1111111111111111111111111111111111111111', '--instance', newInstanceDir('unused-d')],
    'revision-mismatch',
  )

  const scratchDirty = makeScratchGitRepo()
  writeFileSync(join(scratchDirty.dir, 'tracked.txt'), 'modified\n')
  expectRefusal(
    'runtime-dirty: scratch repo has tracked changes',
    ['api', '--cutroom', scratchDirty.dir, '--expect-revision', scratchDirty.head, '--instance', newInstanceDir('unused-e')],
    'runtime-dirty',
  )

  expectRefusal(
    'instance-not-absolute',
    ['api', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', 'relative/instance'],
    'instance-not-absolute',
  )
  expectRefusal(
    'instance-outside-dev-root',
    ['api', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', '/tmp/outside-dev-root-instance'],
    'instance-outside-dev-root',
  )
  // The real runtime is outside KS_DEV_ROOT, so an instance inside it would already be refused as
  // instance-outside-dev-root first. A scratch git repo placed under $KS_DEV_ROOT/tmp lets this
  // case reach instance-inside-cutroom specifically, without touching the real runtime.
  const scratchContainment = makeScratchGitRepo()
  expectRefusal(
    'instance-inside-cutroom',
    [
      'api',
      '--cutroom',
      scratchContainment.dir,
      '--expect-revision',
      scratchContainment.head,
      '--instance',
      join(scratchContainment.dir, 'nested-instance'),
    ],
    'instance-inside-cutroom',
  )
  expectRefusal(
    'instance-not-initialized: never initialized',
    baseArgs(newInstanceDir('never-initialized')),
    'instance-not-initialized',
  )

  const conflictInstance = newInstanceDir('conflict')
  mkdirSync(conflictInstance, { recursive: true })
  writeFileSync(
    join(conflictInstance, 'instance.json'),
    JSON.stringify({
      createdAt: new Date(0).toISOString(),
      cutroomRevision: '2222222222222222222222222222222222222222',
      budgetSource: 'steering-ref/steering/BUDGET.md',
      budgetSha256: 'deadbeef',
      hostSha256: 'deadbeef',
    }),
  )
  expectRefusal(
    'instance-not-initialized: init-instance on a differently-initialized instance',
    ['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', conflictInstance],
    'instance-not-initialized',
  )

  const badPortInstance = newInstanceDir('bad-port')
  runHostSync(['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', badPortInstance], allowlistedEnv())
  expectRefusal('bad-port', [...baseArgs(badPortInstance), '--port', '99999'], 'bad-port')

  const badNumberInstance = newInstanceDir('bad-number')
  runHostSync(['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', badNumberInstance], allowlistedEnv())
  expectRefusal(
    'bad-number',
    ['worker', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', badNumberInstance, '--lease-ms', '0'],
    'bad-number',
  )

  const providersInstance = newInstanceDir('providers')
  runHostSync(['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', providersInstance], allowlistedEnv())
  expectRefusal('providers-not-allowed', [...baseArgs(providersInstance), '--providers', 'real'], 'providers-not-allowed')

  const secretInstance = newInstanceDir('secret')
  runHostSync(['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', secretInstance], allowlistedEnv())
  expectRefusal('secret-in-environment', baseArgs(secretInstance), 'secret-in-environment', {
    env: allowlistedEnv({ MINIMAX_API_KEY: 'dummy' }),
    forbidden: ['dummy'],
  })

  const standinInstance = newInstanceDir('standin')
  runHostSync(['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', standinInstance], allowlistedEnv())
  const badScriptPath = join(DEV_ROOT, 'tmp', `host-selfcheck-bad-script-${RUN_STAMP}.json`)
  writeFileSync(badScriptPath, JSON.stringify({ notAllowed: true }))
  expectRefusal(
    'bad-standin-script: unknown top-level key',
    ['worker', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', standinInstance, '--standin-script', badScriptPath],
    'bad-standin-script',
  )
  rmSync(badScriptPath, { force: true })

  // --- part b: init-instance layout, idempotent rerun, budget hash --------------------------

  const layoutInstance = newInstanceDir('layout')
  const firstInit = runHostSync(
    ['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', layoutInstance],
    allowlistedEnv(),
  )
  const firstRecord = JSON.parse(firstInit.stdout.trim()) as { budgetSha256: string; hostSha256: string; createdAt: string }
  must(
    'init-instance: layout created',
    existsSync(join(layoutInstance, 'artifacts')) &&
      existsSync(join(layoutInstance, 'logs')) &&
      existsSync(join(layoutInstance, 'BUDGET.md')) &&
      existsSync(join(layoutInstance, 'instance.json')),
    `artifacts/, logs/, BUDGET.md and instance.json all present under ${layoutInstance}`,
  )
  const expectedBudgetSha = createHash('sha256').update(readFileSync(join(RUNTIME, 'steering-ref', 'steering', 'BUDGET.md'))).digest('hex')
  must('init-instance: BUDGET.md hash recorded correctly', firstRecord.budgetSha256 === expectedBudgetSha, firstRecord.budgetSha256)

  const secondInit = runHostSync(
    ['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', layoutInstance],
    allowlistedEnv(),
  )
  const secondRecord = JSON.parse(secondInit.stdout.trim()) as { createdAt: string; idempotent: boolean }
  must(
    'init-instance: idempotent rerun keeps createdAt and exits 0',
    secondInit.status === 0 && secondRecord.idempotent === true && secondRecord.createdAt === firstRecord.createdAt,
    `createdAt unchanged (${secondRecord.createdAt}), idempotent=${secondRecord.idempotent}`,
  )

  // A real layout, later found to name a different revision than the runtime's actual (matching)
  // HEAD — so this reaches instance-not-initialized rather than revision-mismatch, which is
  // checked first and would otherwise mask it.
  const realRecord = JSON.parse(readFileSync(join(layoutInstance, 'instance.json'), 'utf8')) as InstanceRecordShape
  writeFileSync(
    join(layoutInstance, 'instance.json'),
    JSON.stringify({ ...realRecord, cutroomRevision: '4444444444444444444444444444444444444444' }),
  )
  expectRefusal(
    'init-instance: different-revision refusal on a real layout',
    ['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', layoutInstance],
    'instance-not-initialized',
  )

  // --- part c/d/e/f/g/h: live api + worker -----------------------------------------------

  const liveInstance = newInstanceDir('live')
  runHostSync(['init-instance', '--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', liveInstance], allowlistedEnv())

  const api1 = await spawnHost('api', ['--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', liveInstance, '--port', '0'], allowlistedEnv())
  must('api: readiness line observed', api1.readiness.ready === true && api1.readiness.role === 'api', JSON.stringify(api1.readiness))
  const baseUrl = api1.readiness.baseUrl as string
  const observedPort = api1.readiness.port as number
  must('api: observed port is nonzero on 127.0.0.1', typeof observedPort === 'number' && observedPort > 0 && baseUrl.startsWith('http://127.0.0.1:'), baseUrl)

  const notFound = await fetchJson(`${baseUrl}/v1/runs?requestId=absent`)
  must(
    'api: GET /v1/runs?requestId=absent -> 404 not-found',
    notFound.status === 404 && (notFound.body as { error?: string }).error === 'not-found',
    JSON.stringify(notFound),
  )
  const unknownRoute = await fetchJson(`${baseUrl}/nope`)
  must('api: unknown route -> 404', unknownRoute.status === 404, JSON.stringify(unknownRoute))

  const worker1 = await spawnHost(
    'worker',
    ['--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', liveInstance, '--render-profile', 'small'],
    allowlistedEnv(),
  )
  must(
    'worker: readiness observed with no stand-in script (ffmpeg ready)',
    worker1.readiness.ready === true && worker1.readiness.role === 'worker' && worker1.readiness.standinScriptSha256 === null,
    JSON.stringify(worker1.readiness),
  )

  const requestId = `req-selfcheck-${RUN_STAMP}`
  const submit = await fetchJson(`${baseUrl}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(planRequestJson(requestId)),
  })
  const submitBody = submit.body as { outcome?: string; runId?: string; requestId?: string }
  must('submit: 202 accepted', submit.status === 202 && submitBody.outcome === 'accepted', JSON.stringify(submit))
  const runId = submitBody.runId ?? ''

  let terminalState: unknown = undefined
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const status = await fetchJson(`${baseUrl}/v1/runs/${runId}`)
    const state = (status.body as { state?: string }).state
    if (state !== 'running') {
      terminalState = status.body
      break
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  must('poll: run reached a terminal state', terminalState !== undefined, JSON.stringify(terminalState))

  const resultResponse = await fetchJson(`${baseUrl}/v1/runs/${runId}/result`)
  const recordResponse = await fetchJson(`${baseUrl}/v1/runs/${runId}/record`)
  record(
    'result: observed shape with an empty model script (reported, not assumed)',
    resultResponse.status === 200,
    JSON.stringify(resultResponse.body),
  )
  const recordBody = recordResponse.body as { takes?: unknown }
  must(
    'record: response includes a takes array',
    resultResponse.status === 200 && Array.isArray(recordBody.takes),
    JSON.stringify(recordResponse.body),
  )

  // --- part f: graceful stop ----------------------------------------------------------------

  const runningApi1 = runningChildren.find((c) => c.child === api1.child)
  const runningWorker1 = runningChildren.find((c) => c.child === worker1.child)
  if (runningApi1 === undefined || runningWorker1 === undefined) throw new Error('lost track of a spawned child')
  await stopGracefully(runningApi1, 'SIGTERM')
  await stopGracefully(runningWorker1, 'SIGTERM')
  must('stop: api stopped gracefully within 30s', runningApi1.child.exitCode === 0, 'exit 0')
  must('stop: worker stopped gracefully within 30s', runningWorker1.child.exitCode === 0, 'exit 0')

  // --- part g: restart api on the same port and instance -------------------------------------

  const api2 = await spawnHost(
    'api',
    ['--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', liveInstance, '--port', String(observedPort)],
    allowlistedEnv(),
  )
  const lookup2 = await fetchJson(`${baseUrl}/v1/runs?requestId=${requestId}`)
  const lookupBody = lookup2.body as { runId?: string; requestId?: string }
  must(
    'restart: same runId/requestId observed after restart on the same port',
    lookup2.status === 200 && lookupBody.runId === runId && lookupBody.requestId === requestId,
    JSON.stringify(lookup2.body),
  )

  // --- part h: SIGKILL worker, start a new one on the same db ---------------------------------

  const worker2 = await spawnHost(
    'worker',
    ['--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', liveInstance, '--render-profile', 'small'],
    allowlistedEnv(),
  )
  const runningWorker2 = runningChildren.find((c) => c.child === worker2.child)
  if (runningWorker2 === undefined) throw new Error('lost track of worker2')
  runningWorker2.child.kill('SIGKILL')
  await new Promise((resolvePromise) => runningWorker2.child.once('exit', resolvePromise))
  must('sigkill: worker killed', runningWorker2.child.exitCode === null, `signal=${String(runningWorker2.child.signalCode)}`)

  const worker3 = await spawnHost(
    'worker',
    ['--cutroom', RUNTIME, '--expect-revision', REVISION, '--instance', liveInstance, '--render-profile', 'small'],
    allowlistedEnv(),
  )
  must('sigkill: a fresh worker starts cleanly on the same db', worker3.readiness.ready === true, JSON.stringify(worker3.readiness))
  const runningWorker3 = runningChildren.find((c) => c.child === worker3.child)
  const runningApi2 = runningChildren.find((c) => c.child === api2.child)
  if (runningWorker3 !== undefined) await stopGracefully(runningWorker3, 'SIGTERM')
  if (runningApi2 !== undefined) await stopGracefully(runningApi2, 'SIGTERM')
}

// -------------------------------------------------------------------------------------------
// Cleanup + receipt writing (always runs).
// -------------------------------------------------------------------------------------------

async function killAllRemaining(): Promise<void> {
  for (const running of runningChildren) {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill('SIGKILL')
    }
  }
}

function ps(): string {
  try {
    return execFileSync('ps', ['-ax', '-o', 'pid,command'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes('cutroom-host/host.ts'))
      .join('\n')
  } catch (error) {
    return `could not run ps: ${message(error)}`
  }
}

async function run(): Promise<boolean> {
  let ok = true
  try {
    await main()
  } catch (error) {
    ok = false
    record('self-check: unhandled failure', false, message(error))
  } finally {
    await killAllRemaining()
    for (const dir of scratchGitRepoDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const remaining = ps()
  must('cleanup: no host.ts process left running', remaining.trim() === '', remaining.trim() === '' ? 'none' : remaining)
  return ok && checks.every((c) => c.ok)
}

const overallOk = await run()

const receipt = {
  utc: RUN_STAMP,
  node: process.version,
  cutroomRuntime: RUNTIME,
  cutroomRevision: REVISION,
  devRoot: DEV_ROOT,
  instances: instanceDirs,
  checks,
  ok: overallOk,
}

const logsDir = join(DEV_ROOT, 'cutroom', 'logs')
mkdirSync(logsDir, { recursive: true })
const receiptPath = join(logsDir, `host-selfcheck-${RUN_STAMP}.json`)
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)

const evidencePath = join(REPO_ROOT, 'docs', 'journeys', 'evidence', 'cutroom-local', 'host-self-check.json')
mkdirSync(dirname(evidencePath), { recursive: true })
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      utc: RUN_STAMP,
      node: process.version,
      cutroomRuntime: RUNTIME,
      cutroomRevision: REVISION,
      checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
      ok: overallOk,
      note: 'Real local service with upstream stand-in providers. Never real generation, never a live provider call.',
    },
    null,
    2,
  )}\n`,
)

process.stdout.write(`[self-check] receipt: ${receiptPath}\n`)
process.stdout.write(`[self-check] evidence: ${evidencePath}\n`)
process.stdout.write(`[self-check] overall: ${overallOk ? 'PASS' : 'FAIL'}\n`)
process.exitCode = overallOk ? 0 : 1
