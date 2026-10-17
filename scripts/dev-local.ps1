$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$envFile = Join-Path $projectRoot ".env.local"

if (-not (Test-Path -LiteralPath $envFile)) {
  Write-Error "Create .env.local from .env.example and configure the required values."
  exit 1
}

foreach ($line in Get-Content -LiteralPath $envFile) {
  if ($line -match '^\s*([^#\s=]+)\s*=(.*)$') {
    $key = $matches[1]
    $value = $matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

if (-not $env:DATABASE_URL) {
  Write-Error "Set DATABASE_URL in .env.local."
  exit 1
}
if (-not $env:SESSION_SECRET -or $env:SESSION_SECRET.Length -lt 32) {
  Write-Error "Set a SESSION_SECRET of at least 32 characters in .env.local."
  exit 1
}

Push-Location $projectRoot
try {
  npx vercel dev --local
} finally {
  Pop-Location
}
