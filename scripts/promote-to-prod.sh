#!/usr/bin/env bash
# Promote the staging-v2 redesign to production in one go.
#
#   npm run promote        (or: bash scripts/promote-to-prod.sh)
#
# What it does, in order — and it stops at the first problem:
#   1. Asks you to type PROMOTE.
#   2. Checks you are on staging-v2 with no uncommitted or untracked changes,
#      and that staging-v2 is fully pushed to GitHub.
#   3. Runs a quick syntax check on server.js.
#   4. Merges staging-v2 into main (a merge commit; no history is rewritten).
#   5. Pushes main to GitHub. The existing Vercel project auto-deploys main to the
#      live domain, with its current environment variables — nothing else is needed.
#   6. Prints how to roll back.
#
# It never touches any database or Vercel setting.
set -euo pipefail

STAGING_BRANCH="staging-v2"
PROD_BRANCH="main"
REMOTE="origin"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

say "This will merge '$STAGING_BRANCH' into '$PROD_BRANCH' and deploy it to the LIVE site."
read -r -p "Type PROMOTE to continue: " answer
[ "$answer" = "PROMOTE" ] || fail "Not confirmed — nothing was changed."

say "1/5  Checking the working tree…"
current="$(git rev-parse --abbrev-ref HEAD)"
[ "$current" = "$STAGING_BRANCH" ] || fail "You are on '$current'. Switch to '$STAGING_BRANCH' first."
[ -z "$(git status --porcelain)" ] || { git status --short; fail "Uncommitted or untracked changes — commit or remove them first."; }

say "2/5  Checking staging-v2 is pushed…"
git fetch "$REMOTE" "$STAGING_BRANCH" "$PROD_BRANCH"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$REMOTE/$STAGING_BRANCH")" ] \
  || fail "Local '$STAGING_BRANCH' differs from $REMOTE/$STAGING_BRANCH — push or pull first."

say "3/5  Syntax check…"
node --check server.js || fail "server.js has a syntax error."

say "4/5  Merging $STAGING_BRANCH into $PROD_BRANCH…"
prev_prod="$(git rev-parse "$REMOTE/$PROD_BRANCH")"
git checkout -q "$PROD_BRANCH"
trap 'git checkout -q "$STAGING_BRANCH" 2>/dev/null || true' EXIT
git merge -q --ff-only "$REMOTE/$PROD_BRANCH" || fail "Local '$PROD_BRANCH' has commits not on $REMOTE — resolve that first."
if ! git merge --no-ff --no-edit -m "Promote $STAGING_BRANCH to production" "$STAGING_BRANCH"; then
  git merge --abort || true
  fail "Merge conflict — nothing was pushed. Merge '$PROD_BRANCH' into '$STAGING_BRANCH', fix, test on staging, then retry."
fi
merge_sha="$(git rev-parse HEAD)"

say "5/5  Pushing $PROD_BRANCH (Vercel deploys production from this push)…"
git push "$REMOTE" "$PROD_BRANCH"

say "✓ Promoted. Production now runs $merge_sha (was $prev_prod)."
cat <<EOF

ROLLBACK (if anything is wrong on the live site):
  Fastest:  Vercel dashboard → production project → Deployments → pick the
            deployment before this one → "Instant Rollback".
  In git:   git checkout $PROD_BRANCH && git revert -m 1 $merge_sha && git push $REMOTE $PROD_BRANCH
            (this makes Vercel redeploy the previous code; nothing is deleted)

Note: the staging database is NOT copied to production. Production data is unchanged.
EOF
