#!/usr/bin/env bash
#
# Every state modifier the stylesheet defines must be written by something.
#
# The bug this catches: admin.css styles `.ad-nav-link.is-active` and
# `.ad-toast.is-error`, while the panels wrote `active` and `err`. Both are
# real class names - Bootstrap even defines `.active` - so nothing was
# undefined and nothing errored. The active nav item simply never highlighted,
# and every error toast rendered as an ordinary success. For months.
#
# A plain "is this class defined" check cannot find that, because the wrong
# class is defined too, just somewhere else and doing nothing. So this checks
# the other direction: a `.x.is-y` rule that no panel ever produces is either
# dead CSS or a name nobody is matching.
#
# Run from the repository root.
#
set -uo pipefail

CSS=platform-api/deploy/shared/css/admin.css

SOURCES=(
  platform-api/src/panel
  brawl-vps/src/panel
  skincraft/views
  skincraft/public/js
  minebox/views
  minebox/public/js
  fortnite/views
)

[[ -f "$CSS" ]] || { echo "  no stylesheet at $CSS"; exit 1; }

fail=0
checked=0

# Every is-* modifier the stylesheet styles.
while read -r modifier; do
  [[ -z "$modifier" ]] && continue
  checked=$((checked + 1))

  found=0
  for dir in "${SOURCES[@]}"; do
    [[ -d "$dir" ]] || continue
    # Markup and scripts only. The panels each carry a copy of the stylesheet
    # under src/panel/css, and searching that would find every modifier in its
    # own definition - the check would pass by reading itself.
    if grep -rq --include='*.js' --include='*.html' --include='*.ejs'          "$modifier" "$dir" 2>/dev/null; then
      found=1
      break
    fi
  done

  if [[ $found -eq 0 ]]; then
    echo "  '$modifier' is styled in admin.css but no panel ever sets it"
    echo "    -> either the markup uses a different name, or the rule is dead"
    fail=1
  fi
done < <(grep -oE '\.is-[a-z-]+' "$CSS" | sed 's/^\.//' | sort -u)

if [[ $fail -eq 0 ]]; then
  echo "  $checked state modifier(s) checked, all of them are set somewhere"
fi

exit $fail
