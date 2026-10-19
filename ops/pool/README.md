# Shared Reel pool database (`knowscroll_pool`)

These migrations define the live spend record shared by the dev and stage worlds on the VPS: `pool_order`, `pool_budget` and the SECURITY DEFINER `claim`/`settle`/`release` functions used by role `ks_pool_client`. The cap is 700¢ (the owner's $7, 2026-10-09), enforced by a CHECK. It sits outside every world so a world reset never forgets money already spent (CF-30, CF-62).

Moved unchanged from `packages/db/pool-migrations/` (v1). v2 reads and writes it only through those functions (S4.3). Never edit an applied migration; add a new one.
