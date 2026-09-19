/**
 * ADR-0021 phase-1 proof lane (#89). ADR-0020 requires a caller to keep the exact prepared bytes
 * and digest of a Cutroom submission durably, and to verify them again before any reconstructed
 * caller writes to the engine again. This is that durable store for the proof lane's own caller: a
 * small JSON file, written atomically, whose `preparedBody` is re-hashed on every load so a file
 * edited or corrupted between processes is refused rather than silently trusted.
 *
 * Plain Node (erasable TypeScript only): no enum/namespace/parameter-property syntax, so this file
 * can be run directly by `node` as well as by `tsx`.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Intent {
  requestId: string
  /** Present once the engine has accepted the request and named a run. */
  runId?: string
  /** The exact bytes submitted — the caller's own stored string, never a reserialized object. */
  preparedBody: string
  bodySha256: string
  /** The events cursor to resume paging from. */
  nextSince: number
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Throws if `intent.bodySha256` does not match `intent.preparedBody`: refuses to persist a
 * self-contradicting intent in the first place. */
export function saveIntent(path: string, intent: Intent): void {
  const expected = sha256(intent.preparedBody)
  if (intent.bodySha256 !== expected) {
    throw new Error(
      `intent-store: refusing to save ${path}: bodySha256 ${intent.bodySha256} does not match ` +
        `preparedBody's own hash ${expected}`,
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  // Atomic: written in full under a temporary name in the same directory, then renamed into place,
  // so no reader ever observes a partially written intent file.
  const temp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  writeFileSync(temp, JSON.stringify(intent, null, 2), { mode: 0o600 })
  renameSync(temp, path)
}

function malformed(path: string, why: string): never {
  throw new Error(`intent-store: ${path} is malformed: ${why}`)
}

/**
 * Reads and validates an intent file, recomputing `preparedBody`'s hash and rejecting a file whose
 * stored `bodySha256` no longer matches it, or whose shape is not a well-formed `Intent`.
 */
export function loadIntent(path: string): Intent {
  const text = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    malformed(path, `not valid JSON (${reason})`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    malformed(path, 'not a JSON object')
  }
  const value = parsed as Record<string, unknown>

  const requestId = value.requestId
  if (typeof requestId !== 'string' || requestId.length === 0) {
    malformed(path, 'requestId is missing or not a non-empty string')
  }
  const preparedBody = value.preparedBody
  if (typeof preparedBody !== 'string') {
    malformed(path, 'preparedBody is missing or not a string')
  }
  const bodySha256 = value.bodySha256
  if (typeof bodySha256 !== 'string' || bodySha256.length === 0) {
    malformed(path, 'bodySha256 is missing or not a non-empty string')
  }
  const nextSince = value.nextSince
  if (typeof nextSince !== 'number' || !Number.isInteger(nextSince) || nextSince < 0) {
    malformed(path, 'nextSince is missing or not a whole number, 0 or more')
  }
  const runId = value.runId
  if (runId !== undefined && (typeof runId !== 'string' || runId.length === 0)) {
    malformed(path, 'runId is present but not a non-empty string')
  }

  const recomputed = sha256(preparedBody as string)
  if (recomputed !== bodySha256) {
    malformed(
      path,
      `preparedBody hashes to ${recomputed}, not the stored bodySha256 ${String(bodySha256)} — ` +
        'the file was edited or corrupted after it was written',
    )
  }

  const intent: Intent = {
    requestId: requestId as string,
    preparedBody: preparedBody as string,
    bodySha256: bodySha256 as string,
    nextSince: nextSince as number,
  }
  return runId === undefined ? intent : { ...intent, runId: runId as string }
}
