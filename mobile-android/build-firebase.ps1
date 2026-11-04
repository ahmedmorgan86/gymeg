$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$required = @(
  (Join-Path $root 'management/google-services.json'),
  (Join-Path $root 'members/google-services.json'),
  (Join-Path $root '../android-support/google-services.json')
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_) })
if ($missing.Count -gt 0) {
  throw 'Missing Firebase configuration. Download one matching google-services.json per package from Firebase Console; do not substitute another app file.'
}
$gradle = Get-Command gradle -ErrorAction SilentlyContinue
if (-not $gradle) { throw 'Gradle is required for the Firebase Android build. Install Gradle 8.x and JDK 17 or newer.' }
Push-Location $root
try {
  & $gradle.Source --no-daemon :manager:assembleRelease :members:assembleRelease :support:assembleRelease
  if ($LASTEXITCODE -ne 0) { throw 'Firebase Android release build failed.' }
} finally { Pop-Location }
