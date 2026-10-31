# MediaStore

Local content-addressed storage behind logical keys, for Reel MP4 video and, since v3 R-4 (D-166), the painted stills of room backdrops (JPEG, PNG
or WebP, at most 8 MiB; the type decides the key's extension and the size bound, and the same bytes as another type are another object). Imports stream to exclusive temporary files
under an owner-only configured root, hash and bound bytes, fsync, validate in the worker, then atomically
rename and fsync the containing directory. Existing digests are verified before idempotent replacement.
Directories and files refuse symlinks; no absolute location crosses a consumer contract. A crash can
leave an unreferenced temporary/object file, never a ready database row naming partial bytes. Orphan
cleanup is an operator follow-up and must preserve referenced objects. Root ownership is a deployment
boundary: no unrelated process may modify its directories concurrently.

Reads use O_NOFOLLOW and regular-file checks. API admission and scope checks happen before opening an
object. Single HTTP range arithmetic lives here; no HTTP framework or business module is imported.
