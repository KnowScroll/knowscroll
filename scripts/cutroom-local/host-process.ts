/**
 * ADR-0021 phase-2 proof lane (#89). Shared process-management helpers for driving
 * `ops/cutroom-host/host.ts` as a spawned child of the joined-proof runner
 * (`scripts/run-local-cutroom-journey.ts`) and its reconstructed caller
 * (`scripts/cutroom-local/reconstructed-caller.ts`). Every host process this file spawns gets an
 * explicit allowlisted environment only — `PATH`, `HOME`, `TMPDIR`, `KS_DEV_ROOT`, `LANG` — never
 * this repository's own `.env` and never a provider credential, regardless of what the calling
 * process's own environment happens to hold (ADR-0021 section 3; `ops/cutroom-host/host.ts` itself
 * refuses if a secret name is present, but this file never lets one reach the child in the first
 * place).
 *
 * This file is only ever imported by KnowScroll's own `tsx`-run scripts (never dynamically loaded
 * by plain `node`, and never itself a Cutroom module), so it is ordinary, non-erasable-only
 * TypeScript.
 */
import { type ChildProcess, spawn } from 'node:child_process'

export const ALLOWLISTED_HOST_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR', 'KS_DEV_ROOT', 'LANG'] as const

/** The exact, explicit environment every host child process receives — nothing else. */
export function hostChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ALLOWLISTED_HOST_ENV_NAMES) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

export interface SpawnedHost {
  readonly role: string
  readonly child: ChildProcess
  readonly stdoutLines: string[]
  readonly stderrLines: string[]
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = ''
  return (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      onLine(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }
}

/** Spawns any command, capturing stdout/stderr line-by-line for `waitForJsonLine`. */
export function spawnProcess(
  role: string,
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string },
): SpawnedHost {
  const child = spawn(command, args, {
    env: options.env,
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.stdout === null || child.stderr === null) {
    throw new Error(`${role}: spawned child has no stdout/stderr pipe`)
  }
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  child.stdout.on('data', lineSplitter((line) => stdoutLines.push(line)))
  child.stderr.on('data', lineSplitter((line) => stderrLines.push(line)))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
    child.on('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  return { role, child, stdoutLines, stderrLines, exited }
}

/** Spawns `node <hostScriptAbs> ...args` with the allowlisted environment only, plain `node` (never `tsx`). */
export function spawnHost(role: string, hostScriptAbs: string, args: readonly string[]): SpawnedHost {
  return spawnProcess(role, 'node', [hostScriptAbs, ...args], { env: hostChildEnv() })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Polls `lines()` from `fromIndex` for a line that parses as JSON and satisfies `predicate`. */
export async function waitForJsonLine<T>(
  lines: () => readonly string[],
  fromIndex: number,
  predicate: (value: unknown) => value is T,
  timeoutMs: number,
  label: string,
): Promise<{ value: T; nextIndex: number }> {
  const deadline = Date.now() + timeoutMs
  let index = fromIndex
  for (;;) {
    const current = lines()
    while (index < current.length) {
      const raw = current[index]
      index += 1
      if (raw === undefined) continue
      try {
        const parsed: unknown = JSON.parse(raw)
        if (predicate(parsed)) return { value: parsed, nextIndex: index }
      } catch {
        // Not a JSON line (or not the one we want): ignore and keep scanning.
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: timed out after ${timeoutMs}ms waiting for a matching line`)
    }
    await sleep(20)
  }
}

export interface Readiness {
  ready: true
  role: 'api' | 'worker'
  pid: number
  node: string
  execPath: string
  startedAt: string
  cutroomRevision: string
  hostSha256: string
  instance: string
  dbPath: string
  artifactRoot: string
  providers: string
  baseUrl?: string
  port?: number
  renderProfile?: string
  leaseMs?: number
  pollMs?: number
  standinScriptSha256?: string | null
}

function isReadiness(value: unknown): value is Readiness {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.ready === true && typeof record.pid === 'number' && typeof record.role === 'string'
}

export async function waitForReadiness(host: SpawnedHost, timeoutMs = 20_000): Promise<Readiness> {
  const { value } = await waitForJsonLine(
    () => host.stdoutLines,
    0,
    isReadiness,
    timeoutMs,
    `${host.role} readiness (stderr so far: ${JSON.stringify(host.stderrLines)})`,
  )
  return value
}

export interface HeldNotice {
  held: true
  call: number
}
function isHeld(value: unknown): value is HeldNotice {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).held === true
}

export async function waitForHeld(
  host: SpawnedHost,
  fromIndex: number,
  timeoutMs: number,
): Promise<{ value: HeldNotice; nextIndex: number }> {
  return waitForJsonLine(() => host.stdoutLines, fromIndex, isHeld, timeoutMs, `${host.role} held notice`)
}

export interface StoppedNotice {
  stopped: true
  role: string
  pid: number
}
function isStopped(value: unknown): value is StoppedNotice {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).stopped === true
}

/**
 * Sends SIGTERM, waits for the host's own `{stopped:true}` line, and then for a clean `exit(0)`.
 * Throws if the process does not report `stopped` and exit 0 within `timeoutMs`.
 */
export async function gracefulStop(host: SpawnedHost, timeoutMs = 30_000): Promise<StoppedNotice> {
  host.child.kill('SIGTERM')
  const { value } = await waitForJsonLine(() => host.stdoutLines, 0, isStopped, timeoutMs, `${host.role} graceful stop line`)
  const exit = await withTimeout(host.exited, timeoutMs, `${host.role} exit after SIGTERM`)
  if (exit.code !== 0) {
    throw new Error(`${host.role} exited ${JSON.stringify(exit)} after SIGTERM; expected code 0`)
  }
  return value
}

/** Sends SIGKILL and waits for the process to actually exit. No graceful line is expected. */
export async function forceKill(
  host: SpawnedHost,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  host.child.kill('SIGKILL')
  return withTimeout(host.exited, timeoutMs, `${host.role} exit after SIGKILL`)
}
