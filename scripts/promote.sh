#!/bin/sh
# Promotes the commit a lower world is running to the next world (#201): dev → stage, stage → main.
# Fast-forward only, so main ⊆ stage ⊆ dev holds literally. The push triggers .github/workflows/
# deploy.yml, which reuses the release already on the server (no rebuild): the next world runs the
# same bytes. Promoting to live is for the owner or XZNON only; the agent's hook refuses it.
#
#   scripts/promote.sh stage    # dev's healthy commit → stage
#   scripts/promote.sh live     # stage's healthy commit → main
set -eu

case "${1:-}" in
  stage) from=dev from_host=backend.dev.knowscroll.space to=stage ;;
  live) from=stage from_host=backend.stage.knowscroll.space to=main ;;
  *) echo "usage: scripts/promote.sh stage|live" >&2; exit 2 ;;
esac

sha=$(curl -fsS "https://$from_host/health" | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p')
[ -n "$sha" ] || { echo "$from is not healthy; nothing to promote" >&2; exit 1; }

git fetch --quiet origin "$from" "$to"
git merge-base --is-ancestor "origin/$to" "$sha" ||
  { echo "refused: $sha does not fast-forward $to" >&2; exit 1; }
git merge-base --is-ancestor "$sha" "origin/$from" ||
  { echo "refused: $sha is not on $from" >&2; exit 1; }

checks=$(gh run list --workflow checks.yml --commit "$sha" --json conclusion --jq '[.[] | select(.conclusion == "success")] | length')
[ "$checks" -gt 0 ] || { echo "refused: checks have not passed on $sha" >&2; exit 1; }

echo "Promoting $sha ($from → $to)"
git push origin "$sha:refs/heads/$to"
