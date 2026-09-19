// ADR-0021 phase-1 proof lane (#89): unit coverage for the KnowScroll-side helpers the joined proof
// needs, none of which talks to Cutroom. Run with `pnpm exec tsx --test tests/cutroom-local-helpers.test.ts`
// after sourcing scripts/env.sh; no database and no Cutroom runtime are required.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkContained } from '../scripts/cutroom-local/containment.ts'
import { type Intent, loadIntent, saveIntent } from '../scripts/cutroom-local/intent-store.ts'
import { createLostResponseProxy } from '../scripts/cutroom-local/lost-response-proxy.ts'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------- lost-response-proxy

test('the lost-response proxy lets the target receive a full body while the armed client gets a transport error', async () => {
  let receivedBody: string | null = null
  let resolveReceived!: () => void
  const received = new Promise<void>((resolve) => {
    resolveReceived = resolve
  })
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      resolveReceived()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  const targetPort = (address as { port: number }).port

  const proxy = await createLostResponseProxy({ host: '127.0.0.1', port: targetPort })
  try {
    proxy.arm()

    let threw = false
    try {
      const response = await fetch(`${proxy.origin}/dropped`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello world',
      })
      await response.text()
    } catch {
      threw = true
    }
    assert.equal(threw, true, 'the armed client should have observed a transport error')

    await received
    assert.equal(receivedBody, 'hello world', 'the target never received the full request body')
    assert.equal(proxy.dropped.length, 1, 'exactly one connection should be recorded as dropped')

    // Arming is single-shot: the next connection, unarmed, round-trips normally.
    const second = await fetch(`${proxy.origin}/ok`, { method: 'POST', body: 'second' })
    const secondJson = (await second.json()) as { ok: boolean }
    assert.deepEqual(secondJson, { ok: true })
    assert.equal(proxy.dropped.length, 1, 'an unarmed connection must not be recorded as dropped')
  } finally {
    await proxy.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

// ---------------------------------------------------------------- containment

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'cutroom-local-containment-'))
}

test('containment accepts an ordinary file genuinely inside the artifact root', () => {
  const root = tempRoot()
  try {
    const runDir = join(root, 'run-1')
    mkdirSync(runDir, { recursive: true })
    const file = join(runDir, 'a1-render.mp4')
    writeFileSync(file, 'not really a video')
    assert.deepEqual(checkContained(root, file), { ok: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('containment rejects a relative path', () => {
  const root = tempRoot()
  try {
    const result = checkContained(root, 'run-1/a1-render.mp4')
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /absolute/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('containment rejects a path that resolves outside the root via `..`', () => {
  const root = tempRoot()
  const outside = join(root, '..', `escape-${Date.now()}.txt`)
  try {
    writeFileSync(outside, 'outside')
    const result = checkContained(root, outside)
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /not inside/)
  } finally {
    rmSync(outside, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('containment rejects a symlink whose own target resolves inside the root', () => {
  // The escape check alone would pass this candidate — its realpath IS inside the root — so this
  // proves lstat's own symlink check, not the escape check, is what refuses it.
  const root = tempRoot()
  try {
    const realFile = join(root, 'real.mp4')
    writeFileSync(realFile, 'inside the root')
    const link = join(root, 'linked.mp4')
    symlinkSync(realFile, link)
    const result = checkContained(root, link)
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /symlink/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('containment rejects a symlink that escapes the root', () => {
  const root = tempRoot()
  const outsideDir = mkdtempSync(join(tmpdir(), 'cutroom-local-containment-outside-'))
  try {
    const realFile = join(outsideDir, 'real.mp4')
    writeFileSync(realFile, 'outside the root')
    const link = join(root, 'linked.mp4')
    symlinkSync(realFile, link)
    const result = checkContained(root, link)
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /not inside/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('containment rejects a directory', () => {
  const root = tempRoot()
  try {
    const dir = join(root, 'run-1')
    mkdirSync(dir, { recursive: true })
    const result = checkContained(root, dir)
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /not a regular file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('containment rejects a path that does not exist', () => {
  const root = tempRoot()
  try {
    const result = checkContained(root, join(root, 'never-written.mp4'))
    assert.equal(result.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- intent-store

test('intent-store saves and loads an intent unchanged, and detects a tampered file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutroom-local-intent-'))
  try {
    const path = join(dir, 'intent.json')
    const preparedBody = JSON.stringify({ requestId: 'r-1', example: true })
    const intent: Intent = { requestId: 'r-1', preparedBody, bodySha256: sha256(preparedBody), nextSince: 0 }
    saveIntent(path, intent)
    assert.deepEqual(loadIntent(path), intent)

    // Tamper with preparedBody only, leaving the stored hash as it was: a reader must reject this,
    // not silently trust the now-mismatched digest.
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    onDisk.preparedBody = `${onDisk.preparedBody as string}-tampered`
    writeFileSync(path, JSON.stringify(onDisk, null, 2))
    assert.throws(() => loadIntent(path), /is tampered|hashes to/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('intent-store round-trips a runId once the run has been accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutroom-local-intent-runid-'))
  try {
    const path = join(dir, 'intent.json')
    const preparedBody = JSON.stringify({ requestId: 'r-2' })
    const intent: Intent = {
      requestId: 'r-2',
      runId: 'run-abc',
      preparedBody,
      bodySha256: sha256(preparedBody),
      nextSince: 4,
    }
    saveIntent(path, intent)
    assert.deepEqual(loadIntent(path), intent)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('intent-store rejects malformed and incomplete files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutroom-local-intent-malformed-'))
  try {
    const notJson = join(dir, 'not-json.json')
    writeFileSync(notJson, '{ this is not json')
    assert.throws(() => loadIntent(notJson), /is malformed/)

    const missingField = join(dir, 'missing-field.json')
    writeFileSync(
      missingField,
      JSON.stringify({ requestId: 'r-1', preparedBody: '{}', bodySha256: sha256('{}') }),
    )
    assert.throws(() => loadIntent(missingField), /nextSince/)

    const notObject = join(dir, 'not-object.json')
    writeFileSync(notObject, JSON.stringify(['array', 'not', 'object']))
    assert.throws(() => loadIntent(notObject), /is malformed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('intent-store refuses to save a self-contradicting intent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutroom-local-intent-refuse-'))
  try {
    const path = join(dir, 'bad.json')
    assert.throws(
      () =>
        saveIntent(path, {
          requestId: 'r-1',
          preparedBody: '{"a":1}',
          bodySha256: 'not-the-real-hash',
          nextSince: 0,
        }),
      /does not match/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
