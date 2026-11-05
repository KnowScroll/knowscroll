# Local media storage

This adapter stores Reel MP4s and painted room backdrops under a configured, owner-controlled
root. Content importers and room backdrop commands stage bytes, validate them, then commit the
object before a ready database row refers to it. API handlers check access before opening bytes.
The store owns files, not account authority or database publication.

## Follow an import

[localMediaStore](index.ts) returns `stage(stream, mime?)` and `open(key)`:

1. `stage` creates an exclusive temporary file, bounds and hashes the stream, then fsyncs it.
   MP4 is the default, limited to 64 MiB. JPEG, PNG and WebP stills are limited to 8 MiB.
2. The caller validates the staged file in the worker. A rejected import calls `discard()`.
3. `commit()` checks any existing object with the same digest, renames atomically and fsyncs the
   directory. It returns a logical key, digest, size, MIME type and `backend: local`.
4. The caller publishes the database reference. No absolute file path enters a consumer contract.

A logical key has the form `sha256/<first-two-hex>/<64-hex-digest>.mp4`; image keys use `.jpg`,
`.png` or `.webp`. The declared type determines the extension, so identical bytes declared as
different types have different keys. A filename alone never proves an existing file's checksum.

## Filesystem authority and recovery

Directories and files reject symlinks. Reads use `O_NOFOLLOW` and require a regular, bounded file.
The root must remain under the service owner's control; another process must not rewrite it
concurrently. [range.ts](range.ts) owns single-range HTTP arithmetic and imports no HTTP framework.

A crash can leave an unreferenced temporary or committed object. It must not leave a ready row
pointing at partial bytes. Orphan cleanup is an operator follow-up: check database references
before removing anything, and preserve referenced bytes during rollback. A failed commit can be
retried only while that staged handle remains open; after commit or discard it is ended.

Run `pnpm --filter @knowscroll/backend exec vitest run src/infrastructure/media-store` from the root,
with `TMPDIR` in the dedicated SSD data directory. These are temporary-file fixtures, not a check
of production permissions, media or recovery. See the
[Cutroom runbook](../../../../../docs/v2/operations/cutroom-and-spend.md) before an operator import.
