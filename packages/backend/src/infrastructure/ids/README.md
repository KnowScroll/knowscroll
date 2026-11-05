# Server IDs

Use this module when the server needs a new ID or a repeatable name for the same work.
The public [index](index.ts) exports two pure helpers; neither reads or writes the database.

| Helper | Use it for | What it does not establish |
| --- | --- | --- |
| `uuidv7(now?)` | A new server-minted record ID | Its embedded clock helps index locality; it is not authority or causal event order. |
| `stableUuid(name)` | A repeatable job ID derived from an exact work identity | It is deterministic, not random or secret. It cannot authorize work. |

For example, `stableUuid('fixture:one-business-run')` returns the same UUID on every call.
A sender must include every field that distinguishes its work in the name it constructs. The
queue's retention and duplicate policy still decide whether sending that ID again inserts a job;
a worker must separately check authority and the business operation's current state.

Run `pnpm --filter @knowscroll/backend exec vitest run src/infrastructure/ids` from the root.
The fixtures check UUID shape, deterministic names and version/variant bits. See the
[job port](../jobs/README.md) for transactional enqueue and retry rules, and blueprint §5 for IDs.
