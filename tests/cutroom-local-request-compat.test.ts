// ADR-0021 phase-1 proof lane (#89), goal 4: confirms KnowScroll's OWN pinned client
// (apps/worker/src/cutroom/http-client.ts, ADR-0020/0021) accepts each generated joined-proof
// request unchanged. This never modifies the client or the copied contracts — it only calls
// `prepareCutroomRequest` on data scripts/cutroom-local/make-standin-script.ts already wrote to
// docs/journeys/evidence/cutroom-local/, and checks the immutable bytes it returns.
//
// Run with `pnpm exec tsx --test tests/cutroom-local-request-compat.test.ts` after generating the
// joined-proof-*.bundle.json files (this file does not itself import Cutroom or run plain `node`;
// apps/worker/src/cutroom/http-client.ts uses a TypeScript parameter property, which only `tsx`
// compiles — Node's own type-stripping refuses it).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { prepareCutroomRequest } from '../apps/worker/src/cutroom/http-client.ts'

const EVIDENCE_DIR = join(import.meta.dirname, '..', 'docs', 'journeys', 'evidence', 'cutroom-local')
const VARIANTS = ['complete-video', 'restart-first', 'restart-second', 'cancel'] as const

function readBundle(variant: string): { request: unknown } {
  const path = join(EVIDENCE_DIR, `joined-proof-${variant}.bundle.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as { request: unknown }
}

for (const variant of VARIANTS) {
  test(`prepareCutroomRequest accepts the generated ${variant} request unchanged under the successor pin`, () => {
    const { request } = readBundle(variant)
    const prepared = prepareCutroomRequest(request)
    const asRecord = request as { requestId: string; options: { until: string } }
    assert.equal(prepared.requestId, asRecord.requestId)
    assert.equal(prepared.until, asRecord.options.until)
    // The prepared bytes really are this exact request, reserialized the one way the client does it
    // (JSON.stringify of the parsed, strict-schema value) — not some other canonicalisation.
    assert.deepEqual(JSON.parse(prepared.body), request)
    assert.equal(createHash('sha256').update(prepared.body).digest('hex'), prepared.bodySha256)
    assert.ok(Object.isFrozen(prepared))
  })
}

test('the restart pair shares one identical request, so both workers act on the same run', () => {
  const first = readBundle('restart-first').request as { requestId: string }
  const second = readBundle('restart-second').request as { requestId: string }
  assert.deepEqual(first, second)
  const preparedFirst = prepareCutroomRequest(first)
  const preparedSecond = prepareCutroomRequest(second)
  assert.equal(preparedFirst.bodySha256, preparedSecond.bodySha256)
})
