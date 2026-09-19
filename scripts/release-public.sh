#!/usr/bin/env bash
#
# Cut a public snapshot release.
#
# This repository has two homes:
#
#   origin   private upstream  — full development history
#   github   public            — SNAPSHOT releases only; its history is one
#                                audited commit per release, nothing else
#
# The development history is deliberately not published. Commits from before
# the current .gitignore rules existed contain credential material and
# operational data (config backups that bundled a database and a large
# indexed-content cache, password hashes, internal addresses). Rewriting all
# of that out is neither reliable nor necessary, so each public release is a
# single fresh commit of the current tree with the internal-only paths
# removed, parented on the previous public snapshot so the public repository
# keeps a linear release history and each push is a fast-forward.
#
# Usage:
#   scripts/release-public.sh 1.0.1            # dry run: audit + report, no writes
#   scripts/release-public.sh 1.0.1 --publish  # create branch, tag, push, release
#
# The dry run is the default on purpose: publishing cannot be undone once the
# repo is public and a crawler has seen it.

set -euo pipefail

VERSION="${1:-}"
PUBLISH="${2:-}"
PUBLIC_REMOTE="${PUBLIC_REMOTE:-github}"
PUBLIC_REPO="${PUBLIC_REPO:-Project-SandStar/FantomMcpServer}"
RELEASE_NAME="${RELEASE_NAME:-FantomMcpServer}"

if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version> [--publish]" >&2
  exit 64
fi

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ── Paths that must never reach the public tree ────────────────────────────
# Internal engineering notes: real hostnames, addresses and incident detail.
# Keep this list in sync with what a fresh audit finds (see AUDIT below).
EXCLUDE_PATHS=(
  "docs/reports"
  "docs/tasks"
  "docs/sidecar-interop-findings-2026-09-13.md"
  "fan/tokens.json"
)

# ── Patterns that must not appear in the published tree ────────────────────
# A hit is a hard stop, not a warning. Machine NAMES (BASWS*, *-Mac-mini) are
# deliberately not here: they appear in code comments and test fixtures and
# were reviewed as acceptable. Addresses and personal paths are not.
declare -a AUDIT_NAMES=(
  "private IPs"
  "personal paths"
  "internal git host"
  "real credentials"
)
declare -a AUDIT_PATTERNS=(
  '(10\.10\.[0-9]+\.[0-9]+|192\.168\.88\.[0-9]+|100\.(1[0-9]|[6-9][0-9])\.[0-9]+\.[0-9]+)'
  '/(home|Users)/(mahmoud|alper)'
  'bas\.co'
  '(sk-or-v1-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|"passwordHash"\s*:)'
)

# Files that may never be tracked at all. POSIX ERE only — BSD grep (macOS)
# has no -P, and a pattern it cannot compile makes the check pass silently,
# which is worse than having no check. Exceptions are subtracted separately
# rather than written as a negative lookahead.
FORBIDDEN_TRACKED='^(config|dashboard/config)/.*\.json$|(^|/)\.env($|\..*)$|\.(db|sqlite3?)$|^\.cache/|^proj/'
FORBIDDEN_ALLOWED='(^|/)[^/]*example[^/]*\.json$|(^|/)\.env\.example$'

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }

# ── Preconditions ──────────────────────────────────────────────────────────
say "Preconditions"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "working tree has uncommitted changes"
ok "working tree clean"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$CURRENT_BRANCH" == "main" ]] || fail "run this from main (on '$CURRENT_BRANCH')"
ok "on main"

PKG_VERSION="$(node -p "require('./package.json').version")"
[[ "$PKG_VERSION" == "$VERSION" ]] || fail "package.json says $PKG_VERSION, you asked for $VERSION — bump it first (also the MCP identity strings in src/index.ts and src/axon/axonMcpClient.ts)"
ok "package.json version is $VERSION"

git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && fail "tag v$VERSION already exists"
ok "tag v$VERSION is free"

say "Build and tests"
npx tsc --noEmit -p tsconfig.json >/dev/null || fail "typecheck failed"
ok "typecheck"
npm test --silent >/dev/null 2>&1 || fail "tests failed"
ok "tests"

# ── Assemble the public file list ──────────────────────────────────────────
say "Assembling the public tree"
PUBLIC_LIST="$(mktemp)"
trap 'rm -f "$PUBLIC_LIST"' EXIT
EXCLUDE_ARGS=()
for p in "${EXCLUDE_PATHS[@]}"; do EXCLUDE_ARGS+=(":(exclude)$p"); done
git ls-files -- . "${EXCLUDE_ARGS[@]}" > "$PUBLIC_LIST"
echo "  $(wc -l < "$PUBLIC_LIST" | tr -d ' ') files (excluded: ${EXCLUDE_PATHS[*]})"

# ── Audit ──────────────────────────────────────────────────────────────────
say "Audit"

# Canary: prove the scanner can actually FIND something before trusting it to
# report nothing. The 1.0.0 dry run passed its forbidden-files check while
# grep was erroring out on an unsupported flag; a clean audit is only
# meaningful if a dirty one would have been caught.
CANARY="$(git grep -I -l -E 'Model Context Protocol' -- . || true)"
[[ -n "$CANARY" ]] || fail "audit self-test failed: the scanner found no match for a string that is definitely present — do not trust this run"
ok "audit self-test (scanner is working)"

FORBIDDEN_HITS="$(git ls-files | grep -E "$FORBIDDEN_TRACKED" | grep -vE "$FORBIDDEN_ALLOWED" || true)"
if [[ -n "$FORBIDDEN_HITS" ]]; then
  echo "$FORBIDDEN_HITS" | head -10 | sed 's/^/    /'
  fail "forbidden files are tracked (see .gitignore)"
fi
ok "no config/env/database/cache/proj files tracked"

FOUND=0
for i in "${!AUDIT_PATTERNS[@]}"; do
  HITS="$(git grep -I -l -E "${AUDIT_PATTERNS[$i]}" -- . "${EXCLUDE_ARGS[@]}" ':(exclude)*package-lock.json' ':(exclude)scripts/release-public.sh' || true)"
  if [[ -n "$HITS" ]]; then
    printf '\033[31m✖ %s:\033[0m\n%s\n' "${AUDIT_NAMES[$i]}" "$(echo "$HITS" | sed 's/^/    /')"
    FOUND=1
  else
    ok "no ${AUDIT_NAMES[$i]}"
  fi
done
[[ "$FOUND" -eq 0 ]] || fail "audit found content that must not be published — exclude the file or scrub it, then re-run"

if [[ "$PUBLISH" != "--publish" ]]; then
  say "Dry run complete — nothing was written."
  echo "  Re-run with --publish to create the branch, tag, push and release."
  exit 0
fi

# ── Publish ────────────────────────────────────────────────────────────────
BRANCH="public-$VERSION"
say "Publishing $VERSION"
git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null && fail "branch $BRANCH already exists"

# The public history is one audited snapshot commit per release: each new
# snapshot's parent is the previous public main, never anything from this
# repository's own history. The first release has no parent at all.
PARENT=""
if git fetch -q "$PUBLIC_REMOTE" main 2>/dev/null; then
  PARENT="$(git rev-parse FETCH_HEAD)"
  ok "previous public snapshot $(git rev-parse --short "$PARENT")"
else
  say "no public main yet — this will be the first snapshot"
fi

# Build the release tree in a scratch index so the working tree and main are
# never touched: read HEAD, drop the internal-only paths, write the tree.
SCRATCH_INDEX="$(mktemp)"
rm -f "$SCRATCH_INDEX"
export GIT_INDEX_FILE="$SCRATCH_INDEX"
git read-tree HEAD
git rm -r -q --cached "${EXCLUDE_PATHS[@]}" >/dev/null
TREE="$(git write-tree)"
unset GIT_INDEX_FILE
rm -f "$SCRATCH_INDEX"

MSG="$RELEASE_NAME $VERSION

Snapshot release. Development history lives in the private upstream
repository and is not published: commits predating the current .gitignore
rules contain credential material and operational data. The parent of this
commit is the previous public snapshot, if any.

Not included: ${EXCLUDE_PATHS[*]}"
if [[ -n "$PARENT" ]]; then
  COMMIT="$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")"
else
  COMMIT="$(git commit-tree "$TREE" -m "$MSG")"
fi
git branch -q "$BRANCH" "$COMMIT"
ok "snapshot commit $(git rev-parse --short "$COMMIT") ($(git ls-tree -r --name-only "$COMMIT" | wc -l | tr -d ' ') files)"

git tag -a "v$VERSION" "$COMMIT" -m "$RELEASE_NAME $VERSION"
git push -q "$PUBLIC_REMOTE" "$BRANCH:main"
git push -q "$PUBLIC_REMOTE" "v$VERSION"
ok "pushed to $PUBLIC_REMOTE"

ZIP="$(mktemp -d)/$RELEASE_NAME-$VERSION.zip"
git archive --format=zip --prefix="$RELEASE_NAME-$VERSION/" -o "$ZIP" "v$VERSION"
ok "zip $(du -h "$ZIP" | cut -f1)"

# Release notes: the "## <version>" section of CHANGELOG.md when there is one,
# otherwise a one-line default.
NOTES="$(mktemp)"
if [[ -f CHANGELOG.md ]] && grep -q -E "^## $VERSION( |$)" CHANGELOG.md; then
  awk -v v="$VERSION" '
    $0 ~ "^## " v "( |$)" { on = 1; next }
    on && /^## / { exit }
    on { print }
  ' CHANGELOG.md > "$NOTES"
  ok "release notes from CHANGELOG.md ($(wc -l < "$NOTES" | tr -d ' ') lines)"
else
  echo "Snapshot release $VERSION. See the README for install and configuration." > "$NOTES"
  say "no CHANGELOG.md section for $VERSION — using the default one-line notes"
fi

gh release create "v$VERSION" "$ZIP" \
  --repo "$PUBLIC_REPO" \
  --title "$RELEASE_NAME $VERSION" \
  --notes-file "$NOTES"
ok "release published"

say "Done. Local branch $BRANCH and tag v$VERSION point at the snapshot."
