#!/usr/bin/env bash
#
# Generate GitHub Release notes for a tag from Conventional Commits made since
# the previous tag. Groups by type (Features / Fixes / Performance / Other) and
# appends a compare link. Used by the release workflow and for backfilling.
#
# Usage: scripts/release-notes.sh <tag>        e.g. scripts/release-notes.sh v0.2.11
#
# Needs full history + tags (git fetch --tags, checkout with fetch-depth: 0).
set -euo pipefail

TAG="${1:?usage: release-notes.sh <tag>}"
REPO="multizenteam/multizen-browser"

# Previous tag reachable from this one; empty for the very first release.
PREV="$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)"
RANGE="${PREV:+${PREV}..}${TAG}"

# Print a "### Title" section for commits whose subject starts with `type:`
# (optionally `type(scope):` / `type!:`). Strips the prefix, keeps the scope as
# a bold tag, and appends the short hash.
section() {
  local title="$1" types="$2" body
  body="$(
    git log "$RANGE" --no-merges --format='%h%x09%s' \
      | awk -F'\t' -v types="$types" '
          {
            hash=$1; sub(/^[^\t]*\t/, "", $0); subj=$0
            # match "type" or "type(scope)" or "type!" at the start
            if (match(subj, /^([a-z]+)(\([^)]+\))?(!)?: /)) {
              head=substr(subj, 1, RLENGTH)
              rest=substr(subj, RLENGTH+1)
              type=head; sub(/[(!:].*/, "", type)
              scope=""
              if (match(head, /\(([^)]+)\)/)) scope=substr(head, RSTART+1, RLENGTH-2)
              # is this type in the requested set?
              n=split(types, want, " "); ok=0
              for (i=1;i<=n;i++) if (want[i]==type) ok=1
              if (ok) {
                if (scope!="") printf "- **%s:** %s (%s)\n", scope, rest, hash
                else           printf "- %s (%s)\n", rest, hash
              }
            }
          }'
  )"
  if [ -n "$body" ]; then printf '### %s\n%s\n\n' "$title" "$body"; fi
}

section "Features"    "feat"
section "Fixes"       "fix"
section "Performance" "perf"
section "Other"       "refactor revert build"

if [ -n "$PREV" ]; then
  printf '**Full changelog:** https://github.com/%s/compare/%s...%s\n' "$REPO" "$PREV" "$TAG"
fi
