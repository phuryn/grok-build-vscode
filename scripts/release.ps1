<#
.SYNOPSIS
  One-command release for grok-build-vscode — encodes the standing
  "release push to main" procedure from CLAUDE.md so it doesn't have to be
  orchestrated by hand each time.

.DESCRIPTION
  Reads the version from package.json (bump it + write the changelog section
  FIRST — those stay user-initiated), then runs the gate and ships:

    1. assert on `main`
    2. tsc --noEmit + npm test       (skip all gating with -NoTest)
       + npm run test:integration    (real Extension Host; skip with -SkipIntegration)
       + npm run e2e:screens         (real Electron desktop; skip with -SkipScreens)
       + npm run test:live           (real grok — mandatory gate; skip with -SkipLive)
    3. assert tag vX.Y.Z is free     (bump the version if it isn't)
    4. npm run package               -> grok-vscode-phuryn-X.Y.Z.vsix
    5. commit the working tree        (message from -MessageFile / -Message / default)
    6. push main
    6b. wait for CI to go GREEN on the pushed SHA  (skip with -SkipCiWait,
        budget with -CiTimeoutMinutes) — before any tag exists
    7. annotated tag vX.Y.Z + push
    8. gh release create vX.Y.Z       with the changelog section as notes
                                       AND the .vsix attached as a release asset
    9. npm run publish:ovsx           publish that .vsix to Open VSX
   10. desktop installers             dispatch desktop-release.yml against the
                                       TAG, wait, and assert the .exe/.dmg/.AppImage are
                                       actually on the release (skip with
                                       -SkipInstallers)
   11. install.ps1 -VsixPath ... -All install the released .vsix into every
                                       detected local editor (skip with
                                       -NoInstall; never fails the release)

  Missing installers fail the release after the local install attempt.

  Open VSX is part of the release. The VS Code Marketplace is deliberately NOT —
  that one is the owner's, a separate explicit step (`npm run publish`).

.EXAMPLE
  pwsh scripts\release.ps1
.EXAMPLE
  powershell -File scripts\release.ps1 -MessageFile .git\RELEASE_MSG
.EXAMPLE
  pwsh scripts\release.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Message,
  [string]$MessageFile,
  [switch]$NoTest,
  [switch]$SkipLive,
  [switch]$SkipIntegration,
  [switch]$SkipScreens,
  [switch]$SkipCiWait,
  [int]$CiTimeoutMinutes = 20,
  [switch]$NoInstall,
  [switch]$SkipInstallers,
  [int]$InstallerTimeoutMinutes = 25,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($t) { Write-Host "==> $t" -ForegroundColor Cyan }
function Run($label, [scriptblock]$cmd) {
  Step $label
  # The success signal for an external tool is its EXIT CODE, not whether it wrote
  # to stderr. Under the script-level $ErrorActionPreference="Stop", PowerShell 5.1
  # turns ANY native-command stderr into a terminating error — so a clean exit-0
  # `npm test` aborted the gate just for printing Vite's CJS deprecation warning.
  # Make stderr non-fatal for the command (function-local; reverts on return) and
  # judge it solely on $LASTEXITCODE.
  $ErrorActionPreference = "Continue"
  & $cmd
  if ($LASTEXITCODE) { throw "$label failed (exit $LASTEXITCODE)" }
}

$pkg     = Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$tag     = "v$version"
if (-not $Message) { $Message = "Release $tag" }
Write-Host "Releasing $tag" -ForegroundColor Green

# 1. branch
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main") { throw "Not on main (on '$branch'). Releases are direct-to-main." }

# 2. gate
if (-not $NoTest) {
  Run "tsc --noEmit"  { npx tsc -p . --noEmit }
  Run "npm test"      { npm test }
  # `npm test` is only CI's `test` job. CI runs a SECOND required job — the
  # @vscode/test-electron smoke — which this gate used to skip entirely, so a release
  # could be tagged, pushed, and published to Open VSX before CI ever ran it, and a red
  # result would arrive after the release was public. It boots a real VS Code (~6s once
  # .vscode-test/ is warm), which is nothing next to the live suite.
  # Known limit: CI runs it on Ubuntu under xvfb, so a Linux-only quirk can still
  # surface there after a green local run. This narrows the window; it doesn't close it.
  if (-not $SkipIntegration) {
    Run "npm run test:integration (real Extension Host)" { npm run test:integration }
  } else {
    Step "SKIPPING the Extension Host smoke (-SkipIntegration) - CI still runs it, but only AFTER the release is public"
  }
  # The real-grok suite is a mandatory part of the release gate (CLAUDE.md § Publishing).
  # It spawns the actual CLI, so it can only run where grok is logged in — hence the
  # explicit -SkipLive escape hatch, but the DEFAULT is to run it so it can't be
  # silently forgotten under release pressure. A live FAIL (non-zero exit) aborts the
  # release; a SKIP inside the suite (no subscription, grok declined to delegate) is exit 0.
  # The desktop app ships the same compiled src/ as the extension, so a change
  # can reach it without src/desktop/ being touched — 3.10.1 shipped an ACP
  # capability change that way. This is the only gate that boots real Electron.
  if (-not $SkipScreens) {
    Run "npm run e2e:screens (real Electron desktop)" { npm run e2e:screens }
  } else {
    Step "SKIPPING the Electron desktop gate (-SkipScreens) - nothing else exercises the packaged app"
  }
  if (-not $SkipLive) {
    Run "npm run test:live (real grok)" { npm run test:live }
  } else {
    Step "SKIPPING real-grok tests (-SkipLive) - the release gate is WEAKER; run 'npm run test:live' by hand first"
  }
}

# 3. tag must be free (a collision means the version wasn't bumped)
if (git tag --list $tag) { throw "Tag $tag already exists - bump package.json/changelog first." }

# 4. build the vsix that will be attached to the release
$vsix = "grok-vscode-phuryn-$version.vsix"
# install.ps1 sets this so a local staging vsix can build. A release must not
# inherit it from the shell — that is how a staging artifact could ship.
Remove-Item Env:GROK_ALLOW_STAGING_RELAY_VSIX -ErrorAction SilentlyContinue
Run "npm run package" { npm run package }
if (-not (Test-Path $vsix)) { throw "Expected $vsix but it wasn't produced." }

# 5. extract this version's changelog section for the release notes
$lines = Get-Content CHANGELOG.md -Encoding UTF8
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match ('^##\s+' + [regex]::Escape($version) + '(\D|$)')) { $start = $i; break }
}
if ($start -lt 0) { throw "No '## $version' section in CHANGELOG.md." }
$end = $lines.Count
for ($i = $start + 1; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^##\s+\d') { $end = $i; break }
}
$notes     = ($lines[$start..($end - 1)] -join "`n").TrimEnd()
$notesFile = Join-Path ([System.IO.Path]::GetTempPath()) "grok-release-notes-$version.md"
[System.IO.File]::WriteAllText($notesFile, $notes, (New-Object System.Text.UTF8Encoding($false)))

if ($DryRun) {
  Write-Host "`n[dry-run] would commit, tag $tag, push main + tag, and run:" -ForegroundColor Yellow
  Write-Host "  gh release create $tag --title `"Release $tag`" --notes-file <notes> $vsix"
  Write-Host "  npm run publish:ovsx"
  if (-not $SkipInstallers) {
    Write-Host "  gh workflow run desktop-release.yml --ref $tag -f release_tag=$tag   (then wait for the assets)"
  }
  Write-Host "`n--- release notes ---`n$notes"
  return
}

# 6. commit whatever is staged/dirty (backlog.md is excluded via .git/info/exclude)
if (git status --porcelain) {
  Run "git add -A" { git add -A }
  if ($MessageFile) { Run "git commit" { git commit -F $MessageFile } }
  else              { Run "git commit" { git commit -m $Message } }
} else {
  Step "working tree clean - nothing to commit"
}

# 7. push, tag, push tag
Run "git push origin main" { git push origin main }

# 7b. CI must be green on exactly what was just pushed, and this is checked
# BEFORE a tag exists. Order is the whole point: a red build then costs a fix
# and a re-run, instead of a tag, a GitHub Release and an Open VSX publish that
# all have to be withdrawn. Local suites are not a substitute — v2.3.0 and
# v2.3.1 both shipped with `main` red because a green Windows box was taken as
# the answer, and the owner found it rather than the release.
if ($SkipCiWait) {
  Step "skipping the CI wait (-SkipCiWait)"
} else {
  # Full SHA, never the short form: `gh run list --commit` matches literally and
  # answers an empty list for an abbreviated one — which would read as "no CI
  # configured" and wave the release straight through.
  $sha = (git rev-parse HEAD).Trim()
  Step "waiting for CI on $sha"
  $deadline = (Get-Date).AddMinutes($CiTimeoutMinutes)
  $everSeen = $false
  while ($true) {
    $ErrorActionPreference = "Continue"
    $raw = gh run list --commit $sha --json status,conclusion,workflowName 2>$null
    $ErrorActionPreference = "Stop"
    $runs = @()
    if ($raw) { $runs = @(($raw | ConvertFrom-Json) | Where-Object { $_.workflowName -eq "CI" }) }
    if ($runs.Count -gt 0) {
      $everSeen = $true
      if (@($runs | Where-Object { $_.status -ne "completed" }).Count -eq 0) {
        $bad = @($runs | Where-Object { $_.conclusion -ne "success" })
        if ($bad.Count) { throw "CI is $($bad[0].conclusion) on $sha. Nothing tagged - fix it and re-run." }
        Write-Host "    CI green on $sha" -ForegroundColor DarkGray
        break
      }
    }
    if ((Get-Date) -ge $deadline) {
      if ($everSeen) { throw "CI did not finish on $sha within $CiTimeoutMinutes min. Nothing tagged." }
      throw "No CI run appeared for $sha within $CiTimeoutMinutes min. Nothing tagged."
    }
    Start-Sleep -Seconds 15
  }
}

Run "git tag -a $tag"      { git tag -a $tag -m "Release $tag" }
Run "git push origin $tag" { git push origin $tag }

# 8. GitHub Release with the vsix attached (always attach - update procedure)
Run "gh release create $tag" { gh release create $tag --title "Release $tag" --notes-file $notesFile $vsix }

# 9. Open VSX. Part of the release, not a reminder printed after it: leaving it
# to a follow-up step is how a version ships to GitHub and the Marketplace while
# Open VSX silently stays a release behind. It runs LAST on purpose — everything
# above is already durable, so a missing token costs a re-run of this one
# command rather than a half-made release.
#
# The VS Code Marketplace is deliberately still NOT here. That one is the
# owner's to run (`npm run publish`).
Run "npm run publish:ovsx" { npm run publish:ovsx }

# 10. The desktop installers, attached to the release that now exists.
#
# This used to be a manual second dispatch, remembered from the playbook, and
# 3.2.9 shipped with only the .vsix because the FIRST dispatch had happened and
# read like the job was done. The owner's question on 2026-08-26 was the right
# one: a release should release everything. So the same argument the Open VSX
# step above makes applies here — part of the release, not a reminder printed
# after it.
#
# Two dispatches still exist and they are different things. The one BEFORE a
# release (no release_tag, any branch) builds the owner's test installers and
# creates nothing; that one stays manual because it is a testing choice. This is
# the other one, and it was never a choice.
#
# `--ref $tag`, not main: the installers must be built from exactly what was
# released, not from whatever landed on main in the meantime.
#
# Unconditional, rather than "only when src/desktop or media/chat.js changed".
# That judgement has been got wrong once already, the workflow prunes installers
# from all but the newest releases anyway, and a release whose assets are
# consistent is worth five minutes of CI.
#
# What is asserted is the OUTCOME — the assets on the release — not that a run
# was dispatched. `gh release view --json assets` is the check the playbook says
# a release is not finished without, so the script makes it rather than asking a
# human to remember to.
$installerFailure = $null
if ($SkipInstallers) {
  Step "skipping the desktop installers (-SkipInstallers)"
} else {
  Run "gh workflow run desktop-release.yml (release_tag=$tag)" {
    gh workflow run desktop-release.yml --ref $tag -f release_tag=$tag
  }
  Step "waiting for the installers to be attached to $tag (up to $InstallerTimeoutMinutes min)"
  $deadline = (Get-Date).AddMinutes($InstallerTimeoutMinutes)
  $attached = $false
  $missing = @(".exe", ".dmg", ".AppImage")
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 20
    # No `2>$null` here. Redirecting a native command's stderr under
    # $ErrorActionPreference = "Stop" turns any warning line into a terminating
    # NativeCommandError, which the catch would swallow as "no assets yet" —
    # and the wait would then run to its timeout on a release that was fine.
    $names = @()
    try {
      $ErrorActionPreference = "Continue"
      $names = @(gh release view $tag --json assets --jq '.assets[].name')
    } catch {
      $names = @()
    } finally {
      $ErrorActionPreference = "Stop"
    }
    $hasWin = @($names | Where-Object { $_ -like "*.exe" }).Count -gt 0
    $hasMac = @($names | Where-Object { $_ -like "*.dmg" }).Count -gt 0
    $hasLinux = @($names | Where-Object { $_ -like "*.AppImage" }).Count -gt 0
    $missing = @(
      if (-not $hasWin) { ".exe" }
      if (-not $hasMac) { ".dmg" }
      if (-not $hasLinux) { ".AppImage" }
    )
    if ($hasWin -and $hasMac -and $hasLinux) { $attached = $true; break }
  }
  if ($attached) {
    Step "installers attached to $tag"
  } else {
    $installerFailure = "Release $tag is incomplete: missing installer artifacts $($missing -join ', ') after $InstallerTimeoutMinutes min."
    Write-Host "  $installerFailure" -ForegroundColor Yellow
    Write-Host "  The GitHub Release and Open VSX publish already exist. Check the installer run, then re-run:" -ForegroundColor Yellow
    Write-Host "    gh run list --workflow=desktop-release.yml --limit 3" -ForegroundColor Yellow
    Write-Host "    gh workflow run desktop-release.yml --ref $tag -f release_tag=$tag" -ForegroundColor Yellow
  }
}

# 11. Install what was just released into this machine's editors. The released
# .vsix is passed by path on purpose, so install.ps1 skips its own build AND its
# staging-relay swap — the editors end up running the exact artifact users get,
# production relay included, rather than a look-alike rebuilt afterwards.
#
# Never fatal. Everything above this line is published and irreversible, so a
# missing editor CLI must read as "install it yourself" and not as a failed
# release. -NoInstall skips it outright (CI, or a release cut from a machine
# that is not the one being tested on).
if ($NoInstall) {
  Step "skipping the local install (-NoInstall)"
} else {
  Step "installing $tag into local editors"
  $ErrorActionPreference = "Continue"
  & (Join-Path $PSScriptRoot "install.ps1") -VsixPath $vsix -All
  $installExit = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($installExit) {
    Write-Host "  Local install did not complete (exit $installExit). The GitHub Release and Open VSX publish already exist;" -ForegroundColor Yellow
    Write-Host "  re-run: scripts\install.ps1 -VsixPath $vsix -All" -ForegroundColor Yellow
  }
}

if ($SkipInstallers) {
  Write-Host "`nPublished $tag with $vsix attached and to Open VSX; installer completion was skipped (-SkipInstallers)." -ForegroundColor Yellow
} elseif ($installerFailure) {
  Write-Host "`nPublished $tag with $vsix attached and to Open VSX; installer completion failed." -ForegroundColor Yellow
} else {
  Write-Host "`nReleased $tag with $vsix and .exe/.dmg/.AppImage installers attached, and published to Open VSX." -ForegroundColor Green
}
Write-Host "Marketplace publish is the owner's: npm run publish" -ForegroundColor DarkGray
if ($installerFailure) { throw $installerFailure }
