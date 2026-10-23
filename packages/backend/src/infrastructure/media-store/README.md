# MediaStore

Local content-addressed MP4 storage behind logical keys. Imports stream to exclusive temporary files
under an owner-only configured root, hash and bound bytes, fsync, validate in the worker, then atomically
rename and fsync the containing directory. Existing digests are verified before idempotent replacement.
Directories and files refuse symlinks; no absolute location crosses a consumer contract. A crash can
leave an unreferenced temporary/object file, never a ready database row naming partial bytes. Orphan
cleanup is an operator follow-up and must preserve referenced objects. Root ownership is a deployment
boundary: no unrelated process may modify its directories concurrently.

Reads use O_NOFOLLOW and regular-file checks. API admission and scope checks happen before opening an
object. Single HTTP range arithmetic lives here; no HTTP framework or business module is imported.
