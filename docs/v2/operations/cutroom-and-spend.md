# Ordering Reels from Cutroom, and the money

Status: **implemented, not yet runtime-verified.** The commands are tested against a labelled fake Cutroom
and a disposable pool in CI. No real order has been placed. The first real order is the first real test.

This page is for the coordinator. It needs no knowledge of the code. The design is D-041; the behaviour is
in `packages/backend/src/modules/content/README.md` ("Reels from Cutroom").

## The rules

- **Budget:** at most **400 cents** of new spend (D-030), on top of the 617 cents v1 already settled.
  The pool cap becomes 1017 and refuses any claim that would pass it. The pool counts cents Cutroom
  reports, which overcount real fal money, so real spend is lower.
- **One order, one ceiling:** at most **75 cents** (Cutroom's own cap for one Reel). Open ceilings count in
  full until the order settles at its real cost.
- **One paid order at a time.** Cutroom has one worker; runs take 13 to 41 minutes. If several were open,
  the pool would still refuse any claim that takes settled spend plus every open ceiling past 1017, so the
  400 cents cannot be overspent by ordering faster than orders settle.
- **Claim before order, settle once, never resend.** The command does these. You only choose the ceiling.
- **Never restart Cutroom while an order is open** (`ks status` shows `openPoolOrders`). A restart can
  make Cutroom run the same job again after its lease and pay twice.
- **No order for a script that fails `reel check`.** Rehearse first; it is free.
- **Editing a script is safe at any time.** An order keeps the exact script it was made from, and `reel follow` uses
  that copy. A new order under the same name waits until the earlier one has ended.
- **Record every order in #240**, with the script and its settled cost (D-030).

## One-time setup

Do these once, in order, after the release containing this work is deployed to dev. Deploying runs
migration `0053`, which creates the Reel tables and drops the unused commissioning tables (all empty).

### 1. Check the starting state

```sh
ssh knowscroll-vps ks status                                     # worlds.dev.openPoolOrders must be 0
ssh knowscroll-vps curl -s http://127.0.0.1:8797/v1/ready        # {"contractVersion":1,"ready":true}
ssh knowscroll-vps 'sudo grep -i "per reel" /etc/knowscroll-cutroom/pool.budget.md'   # the 75-cent row
ssh knowscroll-vps 'sudo -u postgres psql -d knowscroll_pool -At' <<'SQL'
select 'cap', cap_cents from pool_budget;
select 'committed', pool_committed_cents();
select 'open_claims', count(*) from pool_order where state = 'claimed';
SQL
```

Expected: cap 700, committed 617, open_claims 0. Read the fal balance on fal's dashboard (24 Oct: $11.99).
Anything different: stop and look before going on.

### 2. Raise the pool cap (migration 0005) and record it

The pool records the migrations it has applied in `schema_migrations` (the name of the file and the SHA-256
of its text). v1's migrator applied each file and inserted its row in the same transaction; step 2 does the
same for `0005`.

First look at the tracker and confirm its hash format against a row that already exists:

```sh
ssh knowscroll-vps 'sudo -u postgres psql -d knowscroll_pool -c "\d schema_migrations" -c "select * from schema_migrations order by 1"'
shasum -a 256 ops/pool/migrations/0001_shared_pool.sql ops/pool/migrations/0002_cap_seven_dollars.sql
```

Expected: rows for `0001_shared_pool.sql` and `0002_cap_seven_dollars.sql`, and each stored hash equals the
`shasum` of that file in the repository. The statements below use the columns `filename` and `sha256`. If `\d`
shows other names (v1's own code calls them `name` and `checksum`), change the two column names in the
`INSERT` and nothing else.

Take a copy, then apply the file and insert its row **in one transaction**. It runs as the pool's owner role.
The file refuses a pool that is not in the state step 1 checked, and then neither the cap nor the row changes.

```sh
ssh knowscroll-vps 'sudo -u postgres pg_dump -Fc knowscroll_pool | sudo tee /srv/knowscroll/backups/pool-before-0005.dump > /dev/null'
{ cat ops/pool/migrations/0005_cap_four_dollars_more.sql
  printf "INSERT INTO schema_migrations (filename, sha256) VALUES ('0005_cap_four_dollars_more.sql', 'bc56796c81fe0851b39386288b75be9e60b3a3b1f6d89f2ca449f40dabc518e7');\n"
} | ssh knowscroll-vps 'sudo -u postgres psql -v ON_ERROR_STOP=1 --single-transaction \
  "postgresql:///knowscroll_pool?host=/var/run/postgresql&options=-c%20role%3Dks_pool" -f -'
ssh knowscroll-vps 'sudo -u postgres psql -d knowscroll_pool -Atc "select * from pool_budget_status()" -c "select filename, sha256 from schema_migrations order by 1"'
```

Expected: `1017|617|400`, and three tracker rows ending with `0005_cap_four_dollars_more.sql`. Check the hash in the
`INSERT` first: `shasum -a 256 ops/pool/migrations/0005_cap_four_dollars_more.sql` must print the same value.
(CI keeps this page and the file in step: a test fails if the hash here is not the file's.)

**One thing to know before a v1 release is ever deployed to stage again.** v1's migrator
(`scripts/migrate-pool.ts` in the `legacy/v1-final` tag) reads the pool-migrations folder of the release being
deployed, requires every recorded migration to be present in it, and applies only files that are not recorded.
It never re-runs `0005`, because a v1 release has no such file. But with the row recorded it stops with
"Applied migration is missing from disk: 0005_cap_four_dollars_more.sql". A v2 release runs no pool migrator,
so nothing is affected by the row and the row is correct for any later v2-era pool tooling. If a v1 stage
deploy is still planned, delete the row first (`DELETE FROM schema_migrations WHERE filename =
'0005_cap_four_dollars_more.sql'`) and put it back afterwards; the cap itself needs no such care.

### 3. Let the world reach the pool

```sh
ssh knowscroll-vps 'sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT ks_pool_client TO ks2_dev"'
```

Repeat for `ks2_stage` when stage runs v2. This lets the world's own role call the pool functions and
nothing else; the tables stay closed.

### 4. Define the command

The commands run as the world's service user with read access to Cutroom's files (group `ks-pool`).
The world's secrets are read by the shell and never printed. Put this in your session:

```sh
reel() {
  sudo sh -c 'set -a; . /etc/knowscroll/dev.v2.env; . /etc/knowscroll/secrets/v2-dev/database.env; set +a
    export KS_CUTROOM_ORIGIN=http://127.0.0.1:8797 KS_CUTROOM_ARTIFACT_ROOT=/srv/knowscroll/cutroom-pool/artifacts
    cd /srv/knowscroll/dev/current/worker &&
    exec setpriv --reuid=ks2-dev --regid=ks2-dev --groups=ks-pool -- /usr/bin/node dist/operator.js reel "$@"' sh "$@"
}
reel status
```

`reel status` prints one JSON line: the world, whether Cutroom is ready, the pool budget
(`capCents`, `committedCents`, `leftCents`), every order this world made with its attempts (`open: true` means it
still needs a command or a decision), and `notOrdered`, the shipped scripts never touched. `pool` must not be `null`. If it
is, the grant in step 3 or the pool URL is wrong (the URL is the world's `DATABASE_URL` with the database
name `knowscroll_pool`; `KS_POOL_DATABASE_URL` overrides it). `engineReady` must be `true`.
To check the file access: `sudo setpriv --reuid=ks2-dev --regid=ks2-dev --groups=ks-pool -- id` lists `ks-pool`.

## The four scripts

They ship in the release (`approved/reels/`), one per generated Scroll. Each is approved as
`D-030 delegated (coordinator, delegated by owner)`. The order here is the order to try them: plainest
imagery first, since 2 in 3 real runs have stopped on what the pictures had to show.

| Script | Twin Scroll | What the Reel says | Shots |
| --- | --- | --- | --- |
| `stars-fusion` | Why a Star Keeps Its Glow Without Collapsing | Gravity squeezes in, fusion pushes out, heavier stars burn faster | yellow star, glowing gas ball, blue-white star, red star |
| `exoplanet-transit` | How a Planet Leaves a Tiny Shadow in Starlight | A planet blocks a little starlight, a bigger one blocks more, the dip repeats | bright star, small planet crossing, large planet crossing |
| `black-hole-horizon` | The Edge That Lets Go | The horizon is a one-way boundary; hot gas lights the shadow; the pull stretches what falls in | black sphere, bright ring, long streak of gas |
| `tides-spring-neap` | Why Tides Have Bigger and Smaller Rhythms | Low and high water; bigger swings near full Moon (spring tides, any season); smaller near half Moon | beach at low tide, beach at high tide, full Moon, half Moon |

All four have six sentences of at most 17 words, no sentence ends on "Sun", every claim rests on its
twin Scroll at revision 1, and none shares a fingerprint with any v1 script or with each other.

Check one offline (free, needs no database):

```sh
reel check --script stars-fusion
```

Expected: `"kind":"ok"`, `"findings":[]`, `"sentences":6`, and the identities an order would carry
(`rehearsal` and `order`, each with a request id). A script that fails prints its codes instead.

## Ordering one Reel, step by step

Do this for one script at a time. `S` is the script name.

### A. Rehearse (free)

```sh
reel order --script S --until plan --ceiling 75
reel follow --script S --until plan --wait-seconds 900
```

Cutroom plans the Reel (a model call on the MiniMax token plan, no fal). The result says
`"kind":"finished","outcome":"completed","costCents":0` and an `estimateCents` (what the pictures and clips
would cost; real cost runs 10 to 20 cents over it). `outcome":"stopped"` here means the plan failed at no cost:
`detail` says why (`rule split` means the sentences cannot be cut into six shots). Fix the script, redeploy,
rehearse again.

### B. Order (spends up to the ceiling)

Look at the budget first:

```sh
reel status        # pool.leftCents
```

Use `--ceiling` = the smaller of 75 and `leftCents`. Stop ordering when `leftCents` is below 40: a Reel
has cost 48 to 66 cents.

```sh
reel order --script S --until video --ceiling 75
```

Expected: `"kind":"sent"`, `"attempt":{"state":"succeeded","poolState":"claimed", …}`. The pool now holds
75 cents for it. Anything else, see "Reading the output".

### C. Follow it

```sh
reel follow --script S --until video --wait-seconds 3000
```

It prints a line every 20 seconds while Cutroom works (`"kind":"running"`, with the last gates and stages), and the
last line when it ends. Run it again after a drop; it is safe at any point. Without `--wait-seconds` it
looks once and returns. When it ends:

- **`finished`, `outcome":"completed"`, `published":{…}`, `settled":true`:** the Reel is in the world and
  the pool has the real cost. Go to D.
- **`finished`, `outcome":"stopped"` (or `failed`, `refused`, `cancelled`):** no Reel. The pool has the real
  cost. `detail` says why. Read it before spending again (see "After a stop").
- **`finished`, `reelRefused":"<code>"`:** the Reel was made but is not publishable (the engine's own record
  shows a failed check, the media is not a Reel, or it repeats another). The money is spent and settled.
- **`held`:** nothing was settled; fix the cause and run it again (see the table).

### D. Check it

```sh
reel status
ssh knowscroll-vps 'sudo -u postgres psql -d knowscroll_v2_dev -At' <<'SQL'
select a.kind, a.status, r.title, r.explanation_unit_id, d.facets
from content.assets a join content.asset_revisions r on r.asset_id = a.id
join content.discovery_revisions d on d.asset_id = r.asset_id
where r.explanation_unit_id = '<the twin Scroll unit>' order by a.kind;
SQL
```

Two rows (`reel`, `scroll`) with the same unit and the planet in `facets` means Explore can offer both. Then
open the app (an operator sign-in link, `environments.md`), reach the topic in Explore, play the Reel and use
the Reel/Scroll switch. Check the clip against its script.

### E. Log it in #240

One line per order, from the output:

```text
stars-fusion take 1 · ks-reel-… · ceiling 75¢ · completed · 58¢ settled · pool left 342¢ · asset 53fcdbab-… · run <id>
```

## After a stop

About one order in three completes. A stop costs 46 to 66 cents.

1. Read `detail` from `follow` (or `reel status`: each attempt keeps it). A `rule gate-5` stop names what a
   shot did not show; `gate-7` is a pairing of shots that did not sit well; `split` costs nothing.
2. If the script can be improved, change its JSON (`approved/reels/`), redeploy and rehearse again.
   A changed script has a new identity, so it starts at take 1.
3. If it looks like bad luck (a provider failure), retake the same script: `reel order … --retake`. It
   is a new take and a new request id, and it pays again.
4. Never retake blindly more than once.

## Reading the output

Every command prints one JSON line with a `kind`. Exit code 0 means done or under way, 2 means refused or
not ready yet, 1 means failure (the command could not run).

**`reel order` refusals** (`"kind":"refused"`, a `code`; nothing was sent unless stated):

| Code | Meaning and what to do |
| --- | --- |
| `script_unknown`, `script_findings` | The name is not a shipped script, or `reel check` fails. `detail` lists the findings |
| `repetition` | The script repeats a Reel already here. `detail.repetition` names which |
| `scroll_not_published`, `twin_unit_mismatch` | The twin Scroll is not admitted in this world at that revision. Produce it first |
| `ceiling_invalid` | The ceiling is not a whole number from 1 to 75 |
| `already_published` | The Reel exists. Nothing to do |
| `earlier_order_open` | An earlier order under this name, made from different content (the script was edited), has not ended. Follow it to the end first; `reel follow` uses the script that order was made from |
| `last_attempt_ended` | The last attempt ended without a Reel. `detail` is how. Add `--retake` to try again |
| `pool_cap_exceeded` | The pool has less than the ceiling left. Use a smaller ceiling, or stop |
| `pool_already_ordered` | Another world holds or has made this Reel. Use `reel receive` there |
| `pool_unavailable` | The pool could not be reached. Nothing was sent; run it again |
| `pool_take_taken` | Lost a race for the take. Run it again |
| `engine_not_ready` | Cutroom is not ready. The claim was given back; run it again |
| `engine_refused` | Cutroom made no run (`detail`: `invalid` or `conflict`). The claim was given back |

`"kind":"unknown"`: the request may or may not have arrived. Run `reel order` (or `follow`) again: a run that
exists is adopted. If it stays unknown for more than two minutes with Cutroom ready, Cutroom never received
it. Then `reel write-off --attempt <id> --reason "…" --release-claim` gives the claim back (it refuses unless
Cutroom answers, has no run and the request is over two minutes old). Without `--release-claim` the claim stays
open and counted. Nothing is ever resent.

**`reel follow` holds** (`"kind":"held"`, a `code`; the claim stays open, nothing is lost):

| Code | Meaning and what to do |
| --- | --- |
| `engine_unreachable`, `run_absent` | Cutroom did not answer, or has no such run. Check the service; run again |
| `chain_links`, `chain_request`, `chain_length` | Cutroom's runs do not line up. Stop and look at `journalctl -u ks-cutroom@pool` |
| `pool_unavailable` | The pool could not be reached. Run again |
| `artifact_not_readable`, `artifact_changed` | The video file is not readable yet. Check the `ks-pool` group and the artifact folder, then run again |
| `scroll_not_published`, `twin_changed` | The twin Scroll is missing or moved on. Fix, then run again |
| `record_identity`, `record_shots`, `result_without_video`, `asset_exists_for_other_run`, `run_id_not_uuid`, `artifact_unsafe` | Something does not add up. Read the run's record on the host. If you decide not to publish it, `reel settle --script S --until video --reason "…"` records its cost and closes the claim |

**`reel settle`** closes the claim of a request that finished but is held, at the cost Cutroom reported. It
refuses if the request has not finished, the claim is already closed or a Reel was published. It sends
nothing.

## Safety summary

- The pool is the only authority on money; a claim that does not fit is refused before anything is sent.
- The attempt ledger (`content.reel_attempts`) records the exact request bytes, a dispatch intent and every
  state change before the next step. The table refuses a paid attempt that left `reserved` without a claim.
- Cutroom is called only over loopback, through its published contract. Its files are read by the world's
  service user, never written. Cutroom's code and settings are not changed by any of this.
- Receiving a Reel in another world (`reel receive --script S`) costs nothing: it rebuilds the request from
  the same script, checks it against the pool's record byte for byte, and publishes the same Reel.
  It claims, sends and settles nothing. Run it in stage once stage runs v2.
- Provider credentials never reach a world: fal's key stays in Cutroom's environment.
