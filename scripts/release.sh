#!/usr/bin/env bash
# Extension release for grok-build-vscode on macOS/Linux/WSL.
# Publishes the VSIX and Open VSX; desktop installers require the manual
# dispatch and verification commands printed below. scripts/release.ps1
# automates that installer step as well.
#
# Bump package.json + write the changelog section FIRST (those stay
# user-initiated), then run:
#   ./scripts/release.sh                 # extension release (incl. real-grok test:live)
#   ./scripts/release.sh --no-test       # skip ALL gating (tsc + npm test + test:live)
#   ./scripts/release.sh --skip-live     # keep tsc + npm test, skip only real-grok test:live
#   ./scripts/release.sh --skip-integration  # skip only the real-VS-Code Extension Host smoke
#   ./scripts/release.sh --skip-screens  # skip only the real-Electron desktop gate
#   ./scripts/release.sh --skip-ci-wait  # tag without waiting for CI on the pushed SHA
#   ./scripts/release.sh --ci-timeout 30 # minutes to wait for CI (default 20)
#   ./scripts/release.sh --no-install    # do not install the released vsix locally
#   ./scripts/release.sh --dry-run       # print what it would do
#   ./scripts/release.sh -F .git/MSG     # commit with a message file
#
# Steps: assert main -> tsc+test+integration+screens+live -> assert tag free ->
#        npm run package -> commit -> push main -> WAIT FOR CI GREEN ->
#        annotated tag -> push tag -> gh release create (changelog section as
#        notes, .vsix attached) -> npm run publish:ovsx -> install locally.
#
# Open VSX is part of the release. The VS Code Marketplace is deliberately NOT —
# that one is the owner's, a separate explicit step (npm run publish).
set -euo pipefail

cd "$(dirname "$0")/.."

NO_TEST=0; SKIP_LIVE=0; SKIP_INTEGRATION=0; SKIP_SCREENS=0; SKIP_CI_WAIT=0
CI_TIMEOUT_MINUTES=20; NO_INSTALL=0; DRY_RUN=0; MSG=""; MSG_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-test) NO_TEST=1 ;;
    --skip-live) SKIP_LIVE=1 ;;
    --skip-integration) SKIP_INTEGRATION=1 ;;
    --skip-screens) SKIP_SCREENS=1 ;;
    --skip-ci-wait) SKIP_CI_WAIT=1 ;;
    --ci-timeout) CI_TIMEOUT_MINUTES="$2"; shift ;;
    --no-install) NO_INSTALL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -m|--message) MSG="$2"; shift ;;
    -F|--message-file) MSG_FILE="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

installer_handoff() {
  echo "This script does not dispatch or wait for desktop installers. The release is incomplete until .exe, .dmg and .AppImage artifacts are attached."
  echo "  gh workflow run desktop-release.yml --ref $tag -f release_tag=$tag"
  echo "  gh release view $tag --json assets"
}

version="$(node -p "require('./package.json').version")"
tag="v$version"
vsix="grok-vscode-phuryn-$version.vsix"
[ -n "$MSG" ] || MSG="Release $tag"
printf '\033[32mReleasing %s\033[0m\n' "$tag"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || { echo "Not on main (on '$branch'). Releases are direct-to-main." >&2; exit 1; }

if [ "$NO_TEST" -eq 0 ]; then
  step "tsc --noEmit"; npx tsc -p . --noEmit
  step "npm test";     npm test
  # npm test is only CI's `test` job. CI runs a SECOND required job — the
  # @vscode/test-electron smoke — which this gate used to skip, so a release could be
  # tagged and published before CI ever ran it. Boots a real VS Code (~6s warm).
  # Known limit: CI runs it on Ubuntu under xvfb, so a Linux-only quirk can still
  # surface after a green local run — this narrows the window, it does not close it.
  if [ "$SKIP_INTEGRATION" -eq 0 ]; then
    step "npm run test:integration (real Extension Host)"; npm run test:integration
  else
    step "SKIPPING the Extension Host smoke (--skip-integration) - CI still runs it, but only AFTER the release is public"
  fi
  # The desktop app ships the same compiled src/ as the extension, so a change can
  # reach it without src/desktop/ being touched — 3.10.1 shipped an ACP capability
  # change that way. This is the only gate that boots real Electron.
  if [ "$SKIP_SCREENS" -eq 0 ]; then
    step "npm run e2e:screens (real Electron desktop)"; npm run e2e:screens
  else
    step "SKIPPING the Electron desktop gate (--skip-screens) - nothing else exercises the packaged app"
  fi
  # The real-grok suite is a mandatory part of the release gate (CLAUDE.md § Publishing).
  # It spawns the actual CLI, so it only runs where grok is logged in — hence --skip-live,
  # but the DEFAULT runs it so it can't be silently forgotten under release pressure. A live
  # FAIL aborts (set -e); an in-suite SKIP (no subscription / grok declined) is exit 0.
  if [ "$SKIP_LIVE" -eq 0 ]; then
    step "npm run test:live (real grok)"; npm run test:live
  else
    step "SKIPPING real-grok tests (--skip-live) - gate is WEAKER; run 'npm run test:live' by hand first"
  fi
fi

if git tag --list "$tag" | grep -q .; then
  echo "Tag $tag already exists - bump package.json/changelog first." >&2; exit 1
fi

# install.ps1 sets this so a local staging vsix can build. A release must not
# inherit it from the shell — that is how a staging artifact could ship.
unset GROK_ALLOW_STAGING_RELAY_VSIX
step "npm run package"; npm run package
[ -f "$vsix" ] || { echo "Expected $vsix but it wasn't produced." >&2; exit 1; }

# Extract this version's changelog section for the release notes.
notes_file="$(mktemp -t grok-release-notes.XXXXXX)"
awk -v ver="$version" '
  /^## / { if (started) exit; if (index($0, "## " ver) == 1) started=1 }
  started { print }
' CHANGELOG.md > "$notes_file"
[ -s "$notes_file" ] || { echo "No '## $version' section in CHANGELOG.md." >&2; exit 1; }

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\033[33m[dry-run] would commit, tag %s, push main + tag, then:\033[0m\n' "$tag"
  echo "  gh release create $tag --title \"Release $tag\" --notes-file <notes> $vsix"
  echo "  npm run publish:ovsx"
  installer_handoff
  [ "$NO_INSTALL" -eq 1 ] || echo "  ./scripts/install.sh $vsix --all"
  echo "--- release notes ---"; cat "$notes_file"
  exit 0
fi

# backlog.md is excluded via .git/info/exclude, so -A won't sweep it.
if [ -n "$(git status --porcelain)" ]; then
  step "git commit"; git add -A
  if [ -n "$MSG_FILE" ]; then git commit -F "$MSG_FILE"; else git commit -m "$MSG"; fi
else
  step "working tree clean - nothing to commit"
fi

step "git push origin main"; git push origin main

# 6b. CI is a REQUIRED part of the gate, and it can only run on a pushed SHA —
# so it gates the TAG, not the push. Nothing is irreversible yet at this point:
# a red CI here means fix and re-run, with no tag and no release to unpick.
if [ "$SKIP_CI_WAIT" -eq 1 ]; then
  step "SKIPPING the CI wait (--skip-ci-wait) - tagging without CI's verdict"
else
  # Full SHA, never the short form: `gh run list --commit` matches literally and
  # answers an empty list for an abbreviated one — which would read as "no CI
  # configured" and wave the release straight through.
  sha="$(git rev-parse HEAD)"
  step "waiting for CI on $sha"
  deadline=$(( $(date +%s) + CI_TIMEOUT_MINUTES * 60 ))
  ever_seen=0
  while :; do
    runs="$(gh run list --commit "$sha" --json status,conclusion,workflowName 2>/dev/null || true)"
    if [ -n "$runs" ]; then
      total="$(printf '%s' "$runs" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s||"[]").filter(x=>x.workflowName==="CI");process.stdout.write(String(r.length))})')"
      if [ "$total" -gt 0 ]; then
        ever_seen=1
        pending="$(printf '%s' "$runs" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s||"[]").filter(x=>x.workflowName==="CI");process.stdout.write(String(r.filter(x=>x.status!=="completed").length))})')"
        if [ "$pending" -eq 0 ]; then
          bad="$(printf '%s' "$runs" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s||"[]").filter(x=>x.workflowName==="CI"&&x.conclusion!=="success");process.stdout.write(r.length?String(r[0].conclusion):"")})')"
          [ -z "$bad" ] || { echo "CI is $bad on $sha. Nothing tagged - fix it and re-run." >&2; exit 1; }
          printf '    CI green on %s\n' "$sha"
          break
        fi
      fi
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      if [ "$ever_seen" -eq 1 ]; then
        echo "CI did not finish on $sha within $CI_TIMEOUT_MINUTES min. Nothing tagged." >&2
      else
        echo "No CI run appeared for $sha within $CI_TIMEOUT_MINUTES min. Nothing tagged." >&2
      fi
      exit 1
    fi
    sleep 15
  done
fi

step "git tag $tag";         git tag -a "$tag" -m "Release $tag"
step "git push origin $tag"; git push origin "$tag"
step "gh release create $tag (vsix attached)"
gh release create "$tag" --title "Release $tag" --notes-file "$notes_file" "$vsix"

# 9. Open VSX. Part of the release, not a reminder printed after it: leaving it to
# a follow-up step is how a version ships to GitHub and the Marketplace while Open
# VSX silently stays a release behind. It runs LAST on purpose — everything above
# is already durable, so a missing token costs a re-run of this one command rather
# than a half-made release.
step "npm run publish:ovsx"; npm run publish:ovsx

# 10. Install what was just released into this machine's editors. The released
# .vsix is passed BY PATH on purpose, so install.sh skips its own build AND its
# staging-relay swap — the editors end up running the exact artifact users get,
# production relay included, rather than a look-alike rebuilt afterwards.
#
# Never fatal. Everything above this line is published and irreversible, so a
# missing editor CLI must read as "install it yourself", not as a failed release.
if [ "$NO_INSTALL" -eq 1 ]; then
  step "skipping the local install (--no-install)"
else
  step "installing $tag into local editors"
  "$(dirname "$0")/install.sh" "$vsix" --all || \
    echo "  (local install failed - the release itself is already published)" >&2
fi

printf '\033[33mPublished %s with %s attached, and published to Open VSX.\033[0m\n' "$tag" "$vsix"
installer_handoff
echo "Marketplace publish is separate: npm run publish"
