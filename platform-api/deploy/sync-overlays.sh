#!/usr/bin/env bash
#
# Pushes this repo's shared files into the sibling repos, on your machine.
#
#   ./deploy/sync-overlays.sh          # show what would change
#   ./deploy/sync-overlays.sh --write  # actually copy
#
# The point: each service commits its own copy of the SSO client and the
# stylesheet, because both are hard imports and every service must boot from a
# bare clone. That copy is a cache of what lives here. Run this
# after changing anything under deploy/shared, then commit the siblings.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIBLINGS="$(cd "$HERE/../.." && pwd)"

declare -A REPO_DIR=(
  [brawl]="$SIBLINGS/brawl-vps"
  [skincraft]="$SIBLINGS/skincraft-work"
  [minebox]="$SIBLINGS/minebox"
)

WRITE=0
[[ "${1:-}" == "--write" ]] && WRITE=1

changed=0
missing=0

for name in brawl skincraft minebox; do
  manifest="$HERE/overlays/$name/manifest"
  repo="${REPO_DIR[$name]}"

  [[ -f "$manifest" ]] || continue
  if [[ ! -d "$repo" ]]; then
    echo "  - $name: no checkout at $repo, skipping"
    continue
  fi

  echo "[$name]"

  while read -r src dest; do
    [[ -z "$src" || "$src" == \#* ]] && continue

    from="$HERE/$src"
    to="$repo/$dest"

    if [[ ! -f "$from" ]]; then
      echo "  ! source missing: $src"
      missing=$((missing + 1))
      continue
    fi

    # Only files the sibling actually carries. The overlay also delivers files
    # that exist only on the server — head.ejs into a checkout that has its own
    # is right on the VPS and wrong here.
    if [[ ! -f "$to" ]]; then
      echo "  - $dest (not in this repo)"
      continue
    fi

    if cmp -s "$from" "$to"; then
      echo "  = $dest"
    else
      echo "  ~ $dest"
      changed=$((changed + 1))
      [[ $WRITE -eq 1 ]] && cp "$from" "$to"
    fi
  done < "$manifest"
done

echo
if [[ $missing -gt 0 ]]; then
  echo "$missing source file(s) missing — fix before deploying."
  exit 1
fi

if [[ $changed -eq 0 ]]; then
  echo "In sync."
elif [[ $WRITE -eq 1 ]]; then
  echo "Updated $changed file(s). Commit the sibling repos."
else
  echo "$changed file(s) differ. Re-run with --write to copy."
fi
