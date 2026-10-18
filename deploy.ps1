# Deploy DSH QQ Console 2.0 into the DSH profile vendor directory.
# Only writes <profile>/vendor/dsh-qq-console-v2; the legacy
# dsh-qq-console-plugin directory is never touched.
param(
  [string]$Profile = 'desktop',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$profileRoot = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not (Test-Path -LiteralPath $profileRoot)) {
  throw "DSH profile not found: $profileRoot"
}

$vendor = Join-Path $profileRoot 'vendor'
$dst = Join-Path $vendor 'dsh-qq-console-v2'

$vendorFull = [IO.Path]::GetFullPath($vendor)
$dstFull = [IO.Path]::GetFullPath($dst)
$prefix = $vendorFull.TrimEnd('\') + '\'
if (-not $dstFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside vendor: $dstFull"
}

if (-not (Test-Path -LiteralPath $vendor)) {
  New-Item -ItemType Directory -Path $vendor | Out-Null
}

if (Test-Path -LiteralPath $dst) {
  if (-not $Force) {
    throw "Destination exists: $dst. Re-run with -Force to replace it (a backup is kept)."
  }
  $backup = Join-Path $vendor ("backup-dsh-qq-console-v2-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Move-Item -LiteralPath $dst -Destination $backup
  Write-Host "Backup: $backup"
}

New-Item -ItemType Directory -Path $dst | Out-Null
Copy-Item -LiteralPath (Join-Path $src 'package.json') -Destination $dst
Copy-Item -LiteralPath (Join-Path $src 'cordis.patch.yml') -Destination $dst
Copy-Item -LiteralPath (Join-Path $src 'README.md') -Destination $dst
Copy-Item -LiteralPath (Join-Path $src 'lib') -Destination $dst -Recurse

Write-Host "Deployed: $dst"
Write-Host "Next: DSH -> Plugins -> install from local path -> $dst"
