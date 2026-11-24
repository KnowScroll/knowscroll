# Removing the v1 and v2 Scrolls from a database

Use this to take every `scroll-document.v1` and `scroll-document.v2` Scroll out of dev, so the library can be written again in document v3. The command is `content cleanup-old-scrolls`, in the worker release (#791, [D-437](../decisions.md)). The owner asked for it on 23 November: "yes on dev delete on db old and create all new scrolls from scratch you can completely clean dev db as needed just keep the accounts".

It runs only in the worlds `local`, `ci` and `dev`. In `stage` and `production` it refuses with `world_not_allowed` before it reads the database settings. Those need the owner's own word, in another change.

## The repair of assets an earlier run withdrew (#800, D-439)

The first version of this command withdrew an asset that was left with only a document v3 revision the review gate had **rejected**, after it removed the old revision the asset was serving. A withdrawn asset makes the production job refuse every later take of the recipe as `asset_conflict`. The command now holds such an asset instead, as the review gate leaves an asset that was never released (it is not served either way: the readers serve only `admitted`), and it repairs the assets the first version had already withdrawn.

The repair is part of the same command, under the same lock. It finds a Scroll that is `withdrawn`, every revision of which is a kept revision (not v1 or v2) that the review gate rejected, and that has no row in `content.release_withdrawals`. The release policy's withdrawal is the one other way an asset is withdrawn: it needs a `released` review and records the asset there, so it is never taken for this state. `--dry-run` and `--run` both print `wronglyWithdrawnAssets: { count, assetIds }` (library assets, not people's data); a dry run lists those a run would repair, a run lists those it repaired and puts each back to `held`, in its own short transaction before anything else. When no old revision is left, a run does only the repair: it clears nobody and changes nothing else. A second run reports `count: 0`. A withdrawn asset with a revision that was released, held or never reviewed is left withdrawn.

To repair dev after this release: run `content cleanup-old-scrolls --dry-run`, read `wronglyWithdrawnAssets`, then `--run`, then `content production-status --only <the recipe keys>`: the recipes that were `stopped` read `retryable` (their `asset_conflict` takes no longer count, `refusedTakes` says how many), and `content produce-library --only <keys>` queues the next take.

## What it removes and what it keeps

| Removed | Kept |
|---|---|
| Every Scroll asset whose revisions are all v1 or v2, with its revisions, provenance, reviews, support checks, release-policy rows, coverage, discovery rows, topic attribution, series units, continuity links and region bindings | Accounts, their addresses, sessions and sign-in links, their recording pause and resume commands, shared receipts and the reasoning ledger (its accounting redacted, never deleted) |
| The old revisions of an asset that also has a later revision (its later revisions stay, and its current revision moves to the newest one a person may read; with none left it is held, never withdrawn) | Every document v3 Scroll and its coverage, and every Reel |
| The made-to-order rows, production runs, recipe standing and queued jobs of the Scrolls that went | Friends, friend requests, conversations and their messages, rooms and their members |
| Every account's reading history and progress (see "What Clear removes") | Saved items of Scrolls that stay |
| Threads and room discussions about an old Scroll, whole | Threads and discussions about anything else |
| Keeps, shares, reports and call reveals of old Scrolls | |

In a thread, a room or a direct conversation that stays, a card to an old Scroll becomes a tombstone (no author, words, card or note, the same place and number). A branch card (What if, Another perspective) whose Scroll is old is closed: it becomes the bare placeholder the thread already draws for a removed branch.

## What Clear removes and what it keeps

The cleanup clears every account with the product's own Clear (`privacy.clear-exploration`, D-050), one account after another. The foreign keys from a person's readings to a Scroll are `restrict`, and nothing in the product subtracts a removed reading from the totals derived from it, so the history is cleared and the totals are rebuilt by the person's next reading. Clear steps each account's privacy epoch from `n` to `n + 1`, which is what makes a signed-in app drop what it holds for the account.

Clear **erases** (each module's own eraser, keyed by universe): readings and encounters (`experience`: exposures, offers, actions, navigation, recorder certificates, cover outcomes), observations and qualification (`evidence`), formation evidence and Universe topics (`personal_context`), ranking state (`composer`), the Universe's places and sky (`geography`, `scenes`, `planner`), play (calls, results, landmarks), asks and Quick answers (`supply`), a friend's copy of the person's Universe (`social` visit rows), the person's place and picks in threads, their drafts, their launch answers and flaw taps in rooms, their command receipts, their data exports, their protected model requests, and the queued jobs that name the universe.

Clear **keeps**: the account, its addresses, sessions and sign-in links, its recording-pause commands and Clear records, its sharing choices (visibility settings); friends, conversations, messages, threads, rooms and their members; the person's Saved items and places; reports; and the reasoning ledger's accounting (redacted, never deleted). The cleanup then removes the Saved items and reports that point at an old Scroll itself.

Clear's accounting phase can wait for a paid model attempt that is still settling. It stays a durable operation, and the worker's recovery job finishes it after the worker starts again.

## Steps on dev

Run these in order. Stop at any step that does not read as described.

1. **Deploy.** The release that carries migration `0125_old_scroll_cleanup_guard` and the command must be on dev. Compare `https://app.dev.knowscroll.space/health` `commit` with the merged revision.
2. **Back up.** As root on the VPS, dump the world's database and check the dump can be read:
   ```sh
   ssh knowscroll-vps 'sudo sh -c "umask 077; d=/srv/knowscroll/backups/knowscroll_v2_dev;
     f=\$d/before-scroll-cleanup-\$(date -u +%Y%m%dT%H%M%SZ).dump;
     runuser -u postgres -- pg_dump --format=custom --dbname=knowscroll_v2_dev > \$f && pg_restore --list \$f > /dev/null && echo \$f"'
   ```
3. **Stop the worker.** Its jobs write readings, and a reading of a removed Scroll would make the removal fail.
   ```sh
   ssh knowscroll-vps 'sudo systemctl stop ks2-worker@dev.service'
   ```
   Stop the API too when nobody should open a Scroll meanwhile: `sudo systemctl stop ks2-api@dev.service`. The command withdraws every asset it removes first, so an open API cannot serve one, but a stopped API is the quietest way.
4. **Dry run.** From the world's **worker** tree, with the world's settings and database secret (the pattern of [environments.md](environments.md)):
   ```sh
   ssh knowscroll-vps "sudo sh -c 'set -a; . /etc/knowscroll/dev.v2.env; . /etc/knowscroll/secrets/v2-dev/database.env; set +a;
     cd /srv/knowscroll/dev/current/worker && exec runuser -u ks2-dev -- /usr/bin/node dist/operator.js content cleanup-old-scrolls --dry-run'"
   ```
   It prints one JSON line and changes nothing. Read it: `assets` (what goes whole, which asset's current revision moves, which assets stay), `accounts` (by account id only: whether Clear can run for it now, the rows Clear erases and the Keeps removed; a `clearable: false` account stops a run), `threads` (each conversation that is removed or keeps with tombstones), `branches`, `rooms`, `tables` (every table the cleanup touches, with its action and row count) and `wronglyWithdrawnAssets` (the assets the repair above would put back to `held`). Exactly one of `--dry-run` and `--run` is required.
5. **Run.** The same command with `--run`. It prints the same shape; `result` is `done`.
6. **Check, read only.**
   ```sh
   ssh knowscroll-vps "sudo -u postgres psql -X -d knowscroll_v2_dev -c \"select document_version, count(*) from content.asset_revisions ar join content.assets a on a.id = ar.asset_id where a.kind = 'scroll' group by 1;\""
   ```
   It shows only `scroll-document.v3` (or no row at all while no v3 Scroll exists).
7. **Start the worker** (and the API if you stopped it): `sudo systemctl start ks2-worker@dev.service ks2-api@dev.service`. Watch `journalctl -u ks2-worker@dev` for a few minutes.

A second `--run` finds nothing to remove and changes nothing; it does not clear anyone again.

## How it runs

1. It takes a session lock (`content.cleanup-old-scrolls`). A second cleanup while one runs is refused with `cleanup_already_running`.
2. It counts everything on one snapshot. With nothing to remove it stops (`nothing_to_do`); with `--dry-run` it stops there (`planned`).
3. **Repair, then withdraw.** In its own short transaction it puts back to `held` the assets an earlier run withdrew by mistake (see above); with no old revision left, a run ends here. Then, in one short transaction, it withdraws every asset that goes whole, so no one opens it, no job writes about it and the production job refuses it.
4. **Clear** every account, each in its own transactions.
5. **Remove**, in one transaction, the modules' parts in this order: rooms, scenarios, social, experience, feedback, content. A row that points at a revision goes before the row it points at, and content goes last: discovery chain, coverage, review, revisions, assets, then the rows with no foreign key (made-to-order rows, production runs, recipe standing, queued jobs). It checks that no old revision is left before it commits. One transaction means the shared content is either all removed or untouched.

The one transaction sets the local setting `knowscroll.old_scroll_cleanup` to `v1` around the coverage and release-risk deletes. Migration 0125 lets those append-only guards pass a delete only with that setting and only for a revision of a retired format. See [the content README](../../../packages/backend/src/modules/content/README.md).

## When it stops

| `result` and `code` | Meaning | What to do |
|---|---|---|
| `refused`, `world_not_allowed` | The world is not `local`, `ci` or `dev`. | Nothing. This is the rule. |
| `refused`, `cleanup_already_running` | Another cleanup holds the lock. | Wait for it. |
| `planned` or `done` with `wronglyWithdrawnAssets.count` above 0 and nothing else to remove | Only the repair above is pending (or was done). | Nothing: read the ids, then run. |
| `failed`, `clear_incomplete` | An account could not be cleared now (suspended or being deleted). `accountsNotCleared` names it. | Nothing was removed. The assets are withdrawn. Fix or delete the account and run again. |
| `failed`, `phase: remove`, a SQLSTATE such as `23503` | A row the cleanup does not know points at an old revision, or a lock timed out. `constraint` and `table` name it; no value is printed. | Nothing was removed (the transaction rolled back). The accounts are cleared and the assets are withdrawn. Fix the cause, add the missing step in the same change as the new table, and run again. |

A failed run is safe to repeat. Restoring the dump from step 2 is the way back from anything else (see [backups.md](backups.md)).

## What can bring v1 and v2 back

- **The authored starter Scroll** (`why-the-sky-is-blue`, `scroll-document.v1`) is removed with the rest. It is never imported at start-up or by a deploy: only the manual `content import-editorial` step of [environments.md](environments.md) admits it, and the Maestro fixture world and the integration tests do. Do not run that step on dev again.
- **The production job** can write a v1 or v2 library Scroll again for a recipe that is not yet a v3 recipe, and made-to-order Scrolls are written as v1. Made-to-order production is off in every world (D-436). Keep library production off on dev, or have the v3 writer on, until the library is written again; the cleanup does not stop it.
