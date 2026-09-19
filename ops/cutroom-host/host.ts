/**
 * ADR-0021 section 3 — the KnowScroll-owned operator host.
 *
 * `node ops/cutroom-host/host.ts <api|worker|init-instance> [flags]`
 *
 * This file is executed directly by plain `node` (never `tsx`), because it dynamically imports
 * upstream Cutroom `.ts` files that only Node's own native type stripping ever parses. It is
 * therefore written in erasable syntax only: no `enum`, no `namespace`, no parameter properties,
 * and every relative import (there are none here — everything Cutroom is loaded dynamically by an
 * absolute `file://` URL) would need an explicit `.ts` extension.
 *
 * It composes upstream's own exported `startApi`/`startWorker` against upstream's own stand-in
 * providers plus its real ffmpeg adapters. It copies or reimplements no Cutroom engine code, and it
 * is never imported by KnowScroll's API/worker/mobile. See docs/decisions/0021-cutroom-successor-pin-and-local-host.md.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------------------------
// Refusal contract (ADR-0021 §3). Every refusal happens before any Cutroom module is imported and
// before any database is opened: exit code 2, exactly one JSON line on stderr.
// ---------------------------------------------------------------------------------------------

type RefusalReason =
  | 'usage'
  | 'node-version'
  | 'revision-mismatch'
  | 'runtime-dirty'
  | 'instance-not-absolute'
  | 'instance-outside-dev-root'
  | 'instance-inside-cutroom'
  | 'instance-not-initialized'
  | 'bad-port'
  | 'bad-number'
  | 'providers-not-allowed'
  | 'secret-in-environment'
  | 'bad-standin-script'

/** Prints the one refusal line and exits 2. Typed `never` so callers can `return refuse(...)`. */
function refuse(reason: RefusalReason, detail: string): never {
  process.stderr.write(`${JSON.stringify({ refused: true, reason, detail })}\n`)
  process.exit(2)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------------------------
// Argument parsing. Everything here is a `usage` refusal: this file never guesses a flag's intent.
// ---------------------------------------------------------------------------------------------

type Role = 'api' | 'worker' | 'init-instance'

interface Flags {
  cutroom?: string
  expectRevision?: string
  instance?: string
  port?: string
  standinScript?: string
  renderProfile?: string
  leaseMs?: string
  pollMs?: string
  providers?: string
}

const FLAG_NAMES: Readonly<Record<string, keyof Flags>> = {
  '--cutroom': 'cutroom',
  '--expect-revision': 'expectRevision',
  '--instance': 'instance',
  '--port': 'port',
  '--standin-script': 'standinScript',
  '--render-profile': 'renderProfile',
  '--lease-ms': 'leaseMs',
  '--poll-ms': 'pollMs',
  '--providers': 'providers',
}

/** Flags every role accepts. */
const COMMON_FLAGS: ReadonlySet<keyof Flags> = new Set(['cutroom', 'expectRevision', 'instance', 'providers'])

/** Flags a given role accepts beyond the common set. */
const ROLE_FLAGS: Readonly<Record<Role, ReadonlySet<keyof Flags>>> = {
  api: new Set(['port']),
  worker: new Set(['standinScript', 'renderProfile', 'leaseMs', 'pollMs']),
  'init-instance': new Set(),
}

function parseFlags(rest: readonly string[]): Flags {
  const flags: Flags = {}
  let i = 0
  while (i < rest.length) {
    const token = rest[i]
    if (token === undefined) break
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    const key = FLAG_NAMES[name]
    if (key === undefined) refuse('usage', `unrecognized argument '${token}'`)
    let value: string
    if (eq !== -1) {
      value = token.slice(eq + 1)
      i += 1
    } else {
      const next = rest[i + 1]
      if (next === undefined) refuse('usage', `flag '${name}' requires a value`)
      value = next
      i += 2
    }
    if (flags[key] !== undefined) refuse('usage', `flag '${name}' was given more than once`)
    flags[key] = value
  }
  return flags
}

function requireFlag(flags: Flags, key: keyof Flags, name: string): string {
  const value = flags[key]
  if (value === undefined) refuse('usage', `${name} is required`)
  return value
}

// ---------------------------------------------------------------------------------------------
// node-version
// ---------------------------------------------------------------------------------------------

/**
 * Whether a Node version string (with or without a leading `v`) defaults to type stripping.
 * Exported as a pure predicate so `self-check.ts` can prove both branches without spawning a
 * different Node binary — the environment rules forbid ever invoking one.
 */
export function nodeVersionOk(version: string): boolean {
  const parts = version.replace(/^v/, '').split('.').map(Number)
  const major = parts[0]
  const minor = parts[1]
  return major !== undefined && minor !== undefined && (major > 22 || (major === 22 && minor >= 18))
}

function checkNodeVersion(): void {
  if (!nodeVersionOk(process.version)) {
    refuse(
      'node-version',
      `node ${process.version} does not default to type stripping; 22.18 or newer is required (process.version=${process.version})`,
    )
  }
}

// ---------------------------------------------------------------------------------------------
// revision-mismatch / runtime-dirty — checked against the Cutroom checkout's own git state.
// ---------------------------------------------------------------------------------------------

function git(cutroom: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cutroom, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function checkRevision(cutroom: string, expectRevision: string): void {
  let head: string
  try {
    head = git(cutroom, ['rev-parse', 'HEAD']).trim()
  } catch (error) {
    refuse('revision-mismatch', `could not read HEAD of '${cutroom}': ${message(error)}`)
  }
  if (head.toLowerCase() !== expectRevision.toLowerCase()) {
    refuse('revision-mismatch', `runtime HEAD is ${head}, expected ${expectRevision}`)
  }
}

function checkClean(cutroom: string): void {
  let status: string
  try {
    status = git(cutroom, ['status', '--porcelain', '--untracked-files=no'])
  } catch (error) {
    refuse('runtime-dirty', `could not read git status of '${cutroom}': ${message(error)}`)
  }
  if (status.trim() !== '') {
    refuse('runtime-dirty', `runtime has tracked changes: ${status.trim().split(/\r?\n/).join('; ')}`)
  }
}

// ---------------------------------------------------------------------------------------------
// instance-not-absolute / instance-outside-dev-root / instance-inside-cutroom
// ---------------------------------------------------------------------------------------------

/** The nearest ancestor of `path` that actually exists — `path` itself, for `init-instance`, may not. */
function nearestExistingAncestor(path: string): string {
  let current = path
  for (;;) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

/** `path`, with every existing prefix resolved through symlinks and the non-existent tail kept literal. */
function resolveEventualPath(path: string): string {
  const ancestor = nearestExistingAncestor(path)
  const real = realpathSync(ancestor)
  const tail = relative(ancestor, path)
  return tail === '' ? real : join(real, tail)
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function checkInstancePath(instance: string, cutroom: string): string {
  if (!isAbsolute(instance)) refuse('instance-not-absolute', `--instance must be an absolute path, got '${instance}'`)
  const devRoot = process.env.KS_DEV_ROOT
  if (devRoot === undefined || devRoot === '' || !isAbsolute(devRoot) || !existsSync(devRoot)) {
    refuse(
      'instance-outside-dev-root',
      `KS_DEV_ROOT must be set to an existing absolute path; got ${JSON.stringify(devRoot ?? null)}`,
    )
  }
  const devRootReal = realpathSync(devRoot)
  const resolvedInstance = resolveEventualPath(instance)
  if (!within(resolvedInstance, devRootReal)) {
    refuse(
      'instance-outside-dev-root',
      `instance '${instance}' resolves to '${resolvedInstance}', outside KS_DEV_ROOT '${devRootReal}'`,
    )
  }
  let cutroomReal: string
  try {
    cutroomReal = realpathSync(cutroom)
  } catch {
    cutroomReal = resolve(cutroom)
  }
  if (within(resolvedInstance, cutroomReal)) {
    refuse(
      'instance-inside-cutroom',
      `instance '${instance}' resolves to '${resolvedInstance}', inside the Cutroom checkout '${cutroomReal}'`,
    )
  }
  return resolvedInstance
}

// ---------------------------------------------------------------------------------------------
// instance.json / BUDGET.md — the instance layout and its idempotent init-instance role.
// ---------------------------------------------------------------------------------------------

interface InstanceRecord {
  createdAt: string
  cutroomRevision: string
  /** Path to the BUDGET.md source, relative to the Cutroom runtime root. */
  budgetSource: string
  budgetSha256: string
  hostSha256: string
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function instanceJsonPath(instance: string): string {
  return join(instance, 'instance.json')
}

function readInstanceRecord(instance: string): InstanceRecord | undefined {
  const path = instanceJsonPath(instance)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InstanceRecord
  } catch (error) {
    return refuse('instance-not-initialized', `instance.json at '${path}' is not valid JSON: ${message(error)}`)
  }
}

/** `instance-not-initialized` whenever an existing instance.json names a different revision. */
function checkInstanceRevisionConflict(instance: string, expectRevision: string): InstanceRecord | undefined {
  const record = readInstanceRecord(instance)
  if (record !== undefined && record.cutroomRevision.toLowerCase() !== expectRevision.toLowerCase()) {
    refuse(
      'instance-not-initialized',
      `instance '${instance}' was initialized for revision ${record.cutroomRevision}, not ${expectRevision}`,
    )
  }
  return record
}

/** The full check api/worker require: initialized, for this revision, with an unmodified BUDGET.md. */
function requireInitializedInstance(instance: string, expectRevision: string): InstanceRecord {
  const record = checkInstanceRevisionConflict(instance, expectRevision)
  if (record === undefined) {
    return refuse('instance-not-initialized', `instance '${instance}' has no instance.json; run init-instance first`)
  }
  const budgetPath = join(instance, 'BUDGET.md')
  if (!existsSync(budgetPath)) {
    return refuse('instance-not-initialized', `instance '${instance}' is missing BUDGET.md`)
  }
  if (sha256File(budgetPath) !== record.budgetSha256) {
    return refuse(
      'instance-not-initialized',
      `instance '${instance}' BUDGET.md no longer matches the hash recorded at init-instance`,
    )
  }
  return record
}

function runInitInstance(
  cutroom: string,
  expectRevision: string,
  instance: string,
  hostSha256: string,
  existing: InstanceRecord | undefined,
): void {
  mkdirSync(join(instance, 'artifacts'), { recursive: true })
  mkdirSync(join(instance, 'logs'), { recursive: true })

  if (existing !== undefined) {
    // Same revision, already checked by checkInstanceRevisionConflict: idempotent, no rewrite.
    process.stdout.write(
      `${JSON.stringify({
        initialized: true,
        idempotent: true,
        instance,
        cutroomRevision: existing.cutroomRevision,
        budgetSource: existing.budgetSource,
        budgetSha256: existing.budgetSha256,
        hostSha256: existing.hostSha256,
        createdAt: existing.createdAt,
      })}\n`,
    )
    return
  }

  const budgetSourceAbs = join(cutroom, 'steering-ref', 'steering', 'BUDGET.md')
  if (!existsSync(budgetSourceAbs)) {
    throw new Error(`the runtime's steering-ref BUDGET.md is missing at '${budgetSourceAbs}'`)
  }
  const budgetTarget = join(instance, 'BUDGET.md')
  copyFileSync(budgetSourceAbs, budgetTarget)
  const record: InstanceRecord = {
    createdAt: new Date().toISOString(),
    cutroomRevision: expectRevision,
    budgetSource: relative(cutroom, budgetSourceAbs),
    budgetSha256: sha256File(budgetTarget),
    hostSha256,
  }
  writeFileSync(instanceJsonPath(instance), `${JSON.stringify(record, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ initialized: true, idempotent: false, instance, ...record })}\n`)
}

// ---------------------------------------------------------------------------------------------
// bad-port / bad-number / providers-not-allowed / secret-in-environment / bad-standin-script
// ---------------------------------------------------------------------------------------------

function parsePort(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^\d+$/.test(value)) return refuse('bad-port', `--port must be an integer 0-65535, got '${value}'`)
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0 || n > 65535) {
    return refuse('bad-port', `--port must be an integer 0-65535, got '${value}'`)
  }
  return n
}

function parsePositiveInt(flagName: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) return refuse('bad-number', `--${flagName} must be a positive integer, got '${value}'`)
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) {
    return refuse('bad-number', `--${flagName} must be a positive integer, got '${value}'`)
  }
  return n
}

function checkProviders(value: string | undefined): void {
  const mode = value ?? 'standin'
  if (mode !== 'standin') refuse('providers-not-allowed', `provider mode '${mode}' is not allowed; only 'standin' is`)
}

const FORBIDDEN_EXACT_ENV_NAMES: readonly string[] = [
  'MINIMAX_API_KEY',
  'FAL_AI_KEY',
  'FAL_KEY',
  'DATABASE_URL',
  'KS_DEV_TOKEN',
]

function checkSecretsAbsent(): void {
  const found = Object.keys(process.env)
    .filter((name) => FORBIDDEN_EXACT_ENV_NAMES.includes(name) || name.endsWith('_API_KEY'))
    .sort()
  if (found.length > 0) {
    refuse('secret-in-environment', `forbidden environment variable name(s) present: ${found.join(', ')}`)
  }
}

interface StandinScript {
  model?: unknown
  images?: unknown
  sensors?: unknown
  video?: unknown
  narration?: unknown
  media?: unknown
  holdAtCall?: number
}

const STANDIN_SCRIPT_KEYS: ReadonlySet<string> = new Set([
  'model',
  'images',
  'sensors',
  'video',
  'narration',
  'media',
  'holdAtCall',
])

interface LoadedStandin {
  script: StandinScript
  sha256: string | null
}

function loadStandinScript(path: string | undefined): LoadedStandin {
  if (path === undefined) return { script: {}, sha256: null }
  if (!isAbsolute(path)) return refuse('bad-standin-script', `--standin-script must be an absolute path, got '${path}'`)
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch (error) {
    return refuse('bad-standin-script', `could not read '${path}': ${message(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return refuse('bad-standin-script', `'${path}' is not valid JSON: ${message(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse('bad-standin-script', `'${path}' must contain a JSON object`)
  }
  for (const key of Object.keys(parsed)) {
    if (!STANDIN_SCRIPT_KEYS.has(key)) {
      return refuse('bad-standin-script', `'${path}' has unknown top-level key '${key}'`)
    }
  }
  return { script: parsed as StandinScript, sha256: createHash('sha256').update(raw).digest('hex') }
}

// ---------------------------------------------------------------------------------------------
// Minimal local interfaces for the dynamically imported Cutroom surface. Dynamic `import()` of a
// non-literal specifier types as `Promise<any>`; these interfaces describe only what is used here.
// ---------------------------------------------------------------------------------------------

interface ModelCallResult {
  value: unknown
  receipt: unknown
}
interface ModelPort {
  structured(call: unknown): Promise<ModelCallResult>
  observe(call: unknown): Promise<ModelCallResult>
  compare(call: unknown): Promise<ModelCallResult>
  judgeCut(call: unknown): Promise<ModelCallResult>
}

interface CutroomApi {
  baseUrl: string
  address: { port: number }
  stop(): Promise<void>
}
interface ApiModule {
  startApi(options: { dbPath: string; port?: number }): Promise<CutroomApi>
}

interface CutroomWorker {
  stop(): Promise<void>
}
interface WorkerStartOptions {
  dbPath: string
  pollMs?: number
  leaseMs?: number
  model: ModelPort
  settings?: unknown
  budgetPath?: string
  questionsPath?: string
  image: unknown
  sensors: unknown
  renderSettings?: unknown
  video: unknown
  narration: unknown
  media: unknown
  assembler: unknown
}
interface WorkerModule {
  startWorker(options: WorkerStartOptions): Promise<CutroomWorker>
}

interface FfmpegTools {
  ready(): Promise<void>
  run(tool: 'ffmpeg' | 'ffprobe', args: readonly string[]): Promise<unknown>
}
type StandinFactory<T> = (script: unknown, options?: unknown) => T
interface ProvidersModule {
  ffmpegTools(options?: unknown): FfmpegTools
  fakeModel(script: unknown, options: { models: unknown }): ModelPort
  fakeImage: StandinFactory<unknown>
  fakeSensors: StandinFactory<unknown>
  fakeVideo: (tools: FfmpegTools, script: unknown, options?: unknown) => unknown
  fakeNarration: StandinFactory<unknown>
  ffmpegMedia: (tools: FfmpegTools, options?: unknown) => unknown
  ffmpegAssembler: (tools: FfmpegTools, options?: unknown) => unknown
}
interface PipelineModule {
  DEFAULT_PLAN_SETTINGS: { models: Record<string, string> }
  DEFAULT_RENDER_SETTINGS: Record<string, unknown>
}

async function importCutroom<T>(cutroom: string, relativePath: string): Promise<T> {
  const url = pathToFileURL(join(cutroom, relativePath)).href
  return (await import(url)) as T
}

// ---------------------------------------------------------------------------------------------
// Readiness / stop.
// ---------------------------------------------------------------------------------------------

function writeReadiness(instance: string, role: 'api' | 'worker', payload: Record<string, unknown>): void {
  writeFileSync(join(instance, `${role}.ready.json`), `${JSON.stringify(payload, null, 2)}\n`)
}

/**
 * SIGTERM/SIGINT call `stop()` exactly once. A second signal received while the first stop is
 * still in flight is ignored outright: it neither speeds up nor forces the shutdown, and the
 * process still exits once the original `stop()` settles (api closes; worker finishes the job in
 * hand). There is no separate forced-exit path in this host.
 */
function installStopHandler(role: 'api' | 'worker', target: { stop(): Promise<void> }): void {
  let stopping = false
  const handle = (): void => {
    if (stopping) return
    stopping = true
    target
      .stop()
      .then(() => {
        process.stdout.write(`${JSON.stringify({ stopped: true, role, pid: process.pid })}\n`)
        process.exit(0)
      })
      .catch((error: unknown) => {
        process.stderr.write(`${JSON.stringify({ error: message(error) })}\n`)
        process.exit(1)
      })
  }
  process.on('SIGTERM', handle)
  process.on('SIGINT', handle)
}

// ---------------------------------------------------------------------------------------------
// api role
// ---------------------------------------------------------------------------------------------

async function startApiRole(options: {
  cutroom: string
  instance: string
  port: number
  hostSha256: string
  cutroomRevision: string
}): Promise<void> {
  const { cutroom, instance, port, hostSha256, cutroomRevision } = options
  const dbPath = join(instance, 'cutroom.sqlite')
  const apiMod = await importCutroom<ApiModule>(cutroom, 'apps/api/src/index.ts')
  const api = await apiMod.startApi({ dbPath, port })
  const readiness = {
    ready: true,
    role: 'api',
    pid: process.pid,
    node: process.version,
    execPath: process.execPath,
    startedAt: new Date().toISOString(),
    cutroomRevision,
    hostSha256,
    instance,
    dbPath,
    artifactRoot: join(instance, 'artifacts'),
    providers: 'standin',
    baseUrl: api.baseUrl,
    port: api.address.port,
  }
  writeReadiness(instance, 'api', readiness)
  process.stdout.write(`${JSON.stringify(readiness)}\n`)
  installStopHandler('api', api)
}

// ---------------------------------------------------------------------------------------------
// worker role
// ---------------------------------------------------------------------------------------------

/**
 * Copied as literal DATA from upstream `tests/engine/harness.ts` `TEST_RENDER_SETTINGS` at
 * `86d6e2c8b74228db4a5a953e53c53a7b77cef46e` — never imported, since this host never imports
 * Cutroom test code. Spread over the real `DEFAULT_RENDER_SETTINGS` the same way that constant
 * spreads it, so every field the default defines and this override does not keeps the default.
 */
const SMALL_RENDER_OVERRIDES = {
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
  captionStyle: { id: 'word-captions-test', fontName: 'Arial', fontSize: 12, marginV: 20 },
  transient: { maxAttempts: 3, backoffMs: 20 },
  stillPush: { endZoom: 1.1 },
} as const

/** `packages/domain/src/queue.ts` `DEFAULT_LEASE_MS` at the pinned revision — reported, not relied on. */
const UPSTREAM_DEFAULT_LEASE_MS = 60_000
/** `apps/worker/src/worker.ts`'s own `options.pollMs ?? 500` at the pinned revision. */
const UPSTREAM_DEFAULT_POLL_MS = 500

async function startWorkerRole(options: {
  cutroom: string
  instance: string
  hostSha256: string
  cutroomRevision: string
  renderProfile: 'default' | 'small'
  leaseMs: number | undefined
  pollMs: number | undefined
  standin: LoadedStandin
}): Promise<void> {
  const { cutroom, instance, hostSha256, cutroomRevision, renderProfile, leaseMs, pollMs, standin } = options
  const dbPath = join(instance, 'cutroom.sqlite')
  const artifactRoot = join(instance, 'artifacts')
  const questionsPath = join(instance, 'QUESTIONS.md')
  const budgetPath = join(instance, 'BUDGET.md')

  const providersMod = await importCutroom<ProvidersModule>(cutroom, 'packages/providers/src/index.ts')
  const workerMod = await importCutroom<WorkerModule>(cutroom, 'apps/worker/src/index.ts')
  const pipelineMod = await importCutroom<PipelineModule>(cutroom, 'packages/pipeline/src/index.ts')

  const settings = pipelineMod.DEFAULT_PLAN_SETTINGS
  const renderSettings =
    renderProfile === 'small'
      ? { ...pipelineMod.DEFAULT_RENDER_SETTINGS, ...SMALL_RENDER_OVERRIDES }
      : pipelineMod.DEFAULT_RENDER_SETTINGS

  const tools = providersMod.ffmpegTools()
  const root = { artifactRoot }
  const standInModel = providersMod.fakeModel(standin.script.model ?? {}, { models: settings.models })

  const holdAtCall = standin.script.holdAtCall
  let received = 0
  function holds(): boolean {
    received += 1
    return holdAtCall !== undefined && received === holdAtCall
  }
  function held<T>(call: number): Promise<T> {
    process.stdout.write(`${JSON.stringify({ held: true, call })}\n`)
    return new Promise<T>(() => {})
  }
  const model: ModelPort =
    holdAtCall === undefined
      ? standInModel
      : {
          structured: (call) => (holds() ? held(received) : standInModel.structured(call)),
          observe: (call) => (holds() ? held(received) : standInModel.observe(call)),
          compare: (call) => (holds() ? held(received) : standInModel.compare(call)),
          judgeCut: (call) => (holds() ? held(received) : standInModel.judgeCut(call)),
        }
  if (holdAtCall !== undefined) setInterval(() => {}, 60_000)

  const image = providersMod.fakeImage(standin.script.images ?? {}, root)
  const sensors = providersMod.fakeSensors(standin.script.sensors ?? {})
  const video = providersMod.fakeVideo(tools, standin.script.video ?? {}, root)
  const narration = providersMod.fakeNarration(standin.script.narration ?? {}, root)
  const media = providersMod.ffmpegMedia(tools, { ...root, script: standin.script.media ?? {} })
  const assembler = providersMod.ffmpegAssembler(tools, root)

  const worker = await workerMod.startWorker({
    dbPath,
    ...(leaseMs === undefined ? {} : { leaseMs }),
    ...(pollMs === undefined ? {} : { pollMs }),
    model,
    image,
    sensors,
    video,
    narration,
    media,
    assembler,
    settings,
    renderSettings,
    questionsPath,
    budgetPath,
  })

  const readiness = {
    ready: true,
    role: 'worker',
    pid: process.pid,
    node: process.version,
    execPath: process.execPath,
    startedAt: new Date().toISOString(),
    cutroomRevision,
    hostSha256,
    instance,
    dbPath,
    artifactRoot,
    providers: 'standin',
    renderProfile,
    leaseMs: leaseMs ?? UPSTREAM_DEFAULT_LEASE_MS,
    pollMs: pollMs ?? UPSTREAM_DEFAULT_POLL_MS,
    standinScriptSha256: standin.sha256,
  }
  writeReadiness(instance, 'worker', readiness)
  process.stdout.write(`${JSON.stringify(readiness)}\n`)
  installStopHandler('worker', worker)
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const roleArg = argv[0]
  if (roleArg !== 'api' && roleArg !== 'worker' && roleArg !== 'init-instance') {
    refuse('usage', `first argument must be one of api, worker, init-instance; got ${JSON.stringify(roleArg ?? null)}`)
  }
  const role: Role = roleArg
  const flags = parseFlags(argv.slice(1))

  for (const key of Object.keys(flags) as (keyof Flags)[]) {
    if (!COMMON_FLAGS.has(key) && !ROLE_FLAGS[role].has(key)) {
      refuse('usage', `flag for '${key}' is not valid for role '${role}'`)
    }
  }

  const cutroomArg = requireFlag(flags, 'cutroom', '--cutroom')
  const expectRevisionArg = requireFlag(flags, 'expectRevision', '--expect-revision')
  const instance = requireFlag(flags, 'instance', '--instance')

  if (!isAbsolute(cutroomArg)) refuse('usage', `--cutroom must be an absolute path, got '${cutroomArg}'`)
  if (!/^[0-9a-fA-F]{40}$/.test(expectRevisionArg)) {
    refuse('usage', `--expect-revision must be a 40-character hex revision, got '${expectRevisionArg}'`)
  }
  const renderProfileArg = flags.renderProfile ?? 'default'
  if (renderProfileArg !== 'default' && renderProfileArg !== 'small') {
    refuse('usage', `--render-profile must be 'default' or 'small', got '${renderProfileArg}'`)
  }
  const renderProfile: 'default' | 'small' = renderProfileArg

  const cutroom = resolve(cutroomArg)
  const expectRevision = expectRevisionArg

  checkNodeVersion()
  checkRevision(cutroom, expectRevision)
  checkClean(cutroom)
  checkInstancePath(instance, cutroom)

  if (role === 'init-instance') {
    const existing = checkInstanceRevisionConflict(instance, expectRevision)
    checkProviders(flags.providers)
    checkSecretsAbsent()
    const hostSha256 = sha256File(fileURLToPath(import.meta.url))
    runInitInstance(cutroom, expectRevision, instance, hostSha256, existing)
    return
  }

  const record = requireInitializedInstance(instance, expectRevision)
  const hostSha256 = sha256File(fileURLToPath(import.meta.url))

  if (role === 'api') {
    const port = parsePort(flags.port)
    checkProviders(flags.providers)
    checkSecretsAbsent()
    await startApiRole({ cutroom, instance, port, hostSha256, cutroomRevision: record.cutroomRevision })
    return
  }

  const leaseMs = parsePositiveInt('lease-ms', flags.leaseMs)
  const pollMs = parsePositiveInt('poll-ms', flags.pollMs)
  checkProviders(flags.providers)
  checkSecretsAbsent()
  const standin = loadStandinScript(flags.standinScript)
  await startWorkerRole({
    cutroom,
    instance,
    hostSha256,
    cutroomRevision: record.cutroomRevision,
    renderProfile,
    leaseMs,
    pollMs,
    standin,
  })
}

/**
 * Only run as a CLI when invoked directly (`node ops/cutroom-host/host.ts ...`). Guarded so
 * `self-check.ts` can `import` this file for `nodeVersionOk` alone without triggering `main()`
 * with its own argv.
 */
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ error: message(error) })}\n`)
    process.exit(1)
  })
}
