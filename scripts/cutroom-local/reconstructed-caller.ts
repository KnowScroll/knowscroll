/**
 * ADR-0021 phase-2 proof lane (#89), S8's "reconstructed caller": a SEPARATE process from the
 * orchestrator that ran the original submit. It never reuses any in-memory state from the process
 * that submitted the run — it loads the durable intent file from disk (`intent-store.ts`, which
 * re-verifies `bodySha256` against `preparedBody` on load and throws if they disagree), derives the
 * stage (`until`) it needs from that verified body, looks the run up by `requestId` against the
 * restarted api's own observed origin, and resumes paging events from the persisted `nextSince` —
 * proving a caller that crashed and came back with nothing but its own durable record can pick a
 * run back up safely, without ever re-submitting.
 *
 * Every resumed event is printed as one `{"resumedEvent": <RunEvent>}` JSON line on stdout, so the
 * orchestrator that spawned this process can check seq continuity across BOTH processes' collected
 * events. `intent-store.ts`'s `nextSince` is re-persisted after every page, exactly as ADR-0020
 * requires of any caller. Run with `pnpm exec tsx` (this is a KnowScroll script, not a Cutroom
 * module).
 *
 * Usage: pnpm exec tsx scripts/cutroom-local/reconstructed-caller.ts --intent <path> --origin <http://127.0.0.1:PORT>
 */
import { createCutroomHttpClient, type CutroomRunRef } from '../../apps/worker/src/cutroom/http-client.ts'
import { loadIntent, saveIntent } from './intent-store.ts'

interface Args {
  intentPath: string
  origin: string
  timeoutMs: number
}

function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === undefined || !key.startsWith('--')) continue
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`flag ${key} requires a value`)
    flags[key.slice(2)] = value
    i += 1
  }
  const intentPath = flags.intent
  const origin = flags.origin
  if (intentPath === undefined) throw new Error('--intent <path> is required')
  if (origin === undefined) throw new Error('--origin <http://127.0.0.1:PORT> is required')
  return { intentPath, origin, timeoutMs: flags['timeout-ms'] === undefined ? 60_000 : Number(flags['timeout-ms']) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Loading re-verifies bodySha256 against preparedBody; a corrupted/edited intent throws here.
  const intent = loadIntent(args.intentPath)
  if (intent.runId === undefined) {
    throw new Error(`intent at ${args.intentPath} has no runId yet; nothing to resume`)
  }
  const body = JSON.parse(intent.preparedBody) as { options: { until: 'plan' | 'stills' | 'video' } }
  const until = body.options.until
  const ref: CutroomRunRef = { requestId: intent.requestId, runId: intent.runId, until }

  const client = createCutroomHttpClient({ origin: args.origin })

  let cursor = intent.nextSince
  let finished = false
  const deadline = Date.now() + args.timeoutMs
  let totalResumed = 0

  process.stdout.write(
    `${JSON.stringify({ resuming: true, requestId: ref.requestId, runId: ref.runId, until: ref.until, fromSince: cursor })}\n`,
  )

  while (!finished) {
    if (Date.now() > deadline) {
      throw new Error(`reconstructed caller: run ${ref.runId} did not finish within ${args.timeoutMs}ms of resuming`)
    }
    const page = await client.events(ref, cursor)
    if (!('kind' in page) || page.kind !== 'ok') {
      throw new Error(`reconstructed caller: events(${cursor}) did not return ok: ${JSON.stringify(page)}`)
    }
    for (const event of page.value.events) {
      totalResumed += 1
      process.stdout.write(`${JSON.stringify({ resumedEvent: event })}\n`)
      if (event.type === 'run.finished') finished = true
    }
    cursor = page.value.nextSince
    saveIntent(args.intentPath, { ...intent, runId: ref.runId, nextSince: cursor })
    if (!finished) await sleep(50)
  }

  process.stdout.write(
    `${JSON.stringify({ resumeComplete: true, requestId: ref.requestId, runId: ref.runId, finalNextSince: cursor, resumedEventCount: totalResumed })}\n`,
  )
}

await main()
