# PowerShell 5.1 / Docker Desktop: no WSL or Linux deps on the host required.
# Builds in an ephemeral Linux container; never uses Windows node_modules.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$artifactRoot = Join-Path $repoRoot 'dist-desktop'
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
# A unique output directory avoids treating a stale artifact as build evidence.
$artifactDir = Join-Path $artifactRoot ('linux-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $artifactDir | Out-Null
function Run-Docker([string[]]$DockerArgs) {
    $ErrorActionPreference = 'Continue'
    & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw "docker failed (exit $LASTEXITCODE)" }
}
Run-Docker @('info')
Run-Docker @('run', '--rm', '--mount', "type=bind,source=$repoRoot,target=/source,readonly",
    '--mount', "type=bind,source=$artifactDir,target=/artifacts",
    'node:20-bookworm', 'bash', '/source/scripts/build-linux-container.sh')
$debs = @(Get-ChildItem -LiteralPath $artifactDir -Filter '*-linux-amd64.deb')
if ($debs.Count -ne 1) { throw 'Expected exactly one built deb' }
foreach ($distro in @('ubuntu:24.04', 'debian:12')) {
    Write-Host "Lifecycle: $distro" -ForegroundColor Cyan
    Run-Docker @('run', '--rm', '--mount', "type=bind,source=$repoRoot,target=/source,readonly",
        '--mount', "type=bind,source=$artifactDir,target=/pkg,readonly",
        $distro, 'bash', '/source/scripts/verify-linux-deb-lifecycle.sh',
        '/pkg/lifecycle/previous.deb', ('/pkg/' + $debs[0].Name))
}
Write-Host "PASS build, artifact checks, install, upgrade, remove and purge. Artifacts: $artifactDir"
Write-Host 'Ubuntu AppArmor sandbox launch still requires the native ubuntu-24.04 CI gate.'
