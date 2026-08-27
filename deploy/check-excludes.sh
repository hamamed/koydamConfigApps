#!/usr/bin/env bash
#
# Refuses an exclude pattern that would silently drop source code.
#
# rsync reads `--exclude wallpapers` as "a path component of that name at any
# depth". So a source directory called src/wallpapers/ is skipped by a rule
# meant for the uploads folder, the file never reaches the server, and the
# service dies on an import of a module that was never copied. That happened.
#
# A leading slash anchors the pattern to the transfer root, which is what every
# runtime-data exclude wants. node_modules, .git and .env are the exceptions:
# those should be skipped wherever they appear.
#
# Run from the repository root. Exits non-zero on a collision.
#
set -uo pipefail

CONF_FILES=(
  platform-api/deploy/deploy.sh
  platform-api/deploy/services.conf
)

# Excludes that are correct unanchored, because they are never source.
ALWAYS_ANYWHERE='^(node_modules|\.git|\.env)$'

fail=0
checked=0

collect_patterns() {
  # The default list, from the array literal.
  sed -n 's/^PRESERVE_DEFAULT=(\(.*\))/\1/p' platform-api/deploy/deploy.sh | tr ' ' '\n'

  # Any per-service override, from services.conf.
  sed -n 's/^preserve *= *//p' platform-api/deploy/services.conf | tr ' ' '\n'
}

while read -r pattern; do
  [[ -z "$pattern" ]] && continue
  # Already anchored: cannot match a nested path.
  [[ "$pattern" == /* ]] && continue
  [[ "$pattern" =~ $ALWAYS_ANYWHERE ]] && continue

  checked=$((checked + 1))

  # Only the first path component can collide; `data/brawler-meta.json` is
  # specific enough that it cannot match a directory called data.
  top="${pattern%%/*}"

  hits=$(find . -type d -name "$top" -not -path '*/node_modules/*' -not -path './.git/*' \
         2>/dev/null | grep '/src/' || true)

  if [[ -n "$hits" ]]; then
    echo "  exclude '$pattern' is unanchored and matches source:"
    printf '    %s\n' $hits
    echo "    -> write it as /$pattern so it only matches the install root"
    fail=1
  fi
done < <(collect_patterns | sort -u)

if [[ $fail -eq 0 ]]; then
  echo "  $checked unanchored pattern(s) checked, no collisions with source"
fi

exit $fail
