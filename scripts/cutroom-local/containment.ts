/**
 * ADR-0021 phase-1 proof lane (#89). A Cutroom engine returns paths as untrusted host metadata
 * (ADR-0020): before this lane ever opens a path Cutroom names, it must be a real, ordinary file
 * genuinely inside the instance's own artifact root — never a symlink, a directory, or a path that
 * only reads that way before its `..` segments or a symlink hop are resolved.
 *
 * Plain Node (erasable TypeScript only): no enum/namespace/parameter-property syntax, so this file
 * can be run directly by `node` as well as by `tsx`.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

export interface ContainmentResult {
  ok: boolean
  /** Present exactly when `ok` is false: why the candidate was refused. */
  reason?: string
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `candidate` must be an absolute path, must resolve (following symlinks) to somewhere strictly
 * inside `root`'s own resolved location, and must itself be an ordinary file: not a symlink
 * (checked with `lstat`, which does not follow the final segment) and not a directory.
 */
export function checkContained(root: string, candidate: string): ContainmentResult {
  if (!isAbsolute(candidate)) {
    return { ok: false, reason: 'the path is not absolute' }
  }

  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch (error) {
    return { ok: false, reason: `the artifact root does not resolve: ${reasonOf(error)}` }
  }

  let realCandidate: string
  try {
    realCandidate = realpathSync(candidate)
  } catch (error) {
    return { ok: false, reason: `the path does not resolve: ${reasonOf(error)}` }
  }

  const inside = relative(realRoot, realCandidate)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return { ok: false, reason: `${realCandidate} is not inside the artifact root ${realRoot}` }
  }

  let stat
  try {
    // lstat, not stat: a symlink whose target happens to sit inside the root is still refused —
    // the check on the link itself, not just where it points, matters for containment.
    stat = lstatSync(candidate)
  } catch (error) {
    return { ok: false, reason: `the path cannot be inspected: ${reasonOf(error)}` }
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, reason: 'the path is a symlink, not a plain file' }
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'the path is not a regular file' }
  }

  return { ok: true }
}
