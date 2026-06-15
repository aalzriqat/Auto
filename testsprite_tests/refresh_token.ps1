# refresh_token.ps1 — Refresh CLERK_JWT_TOKEN in testsprite_tests/.env.test
#
# Option 1 (automatic, preferred — requires pnpm dev to be running):
#   node testsprite_tests/get_token.js
#
# Option 2 (manual fallback — run this script without pnpm dev):
#   Paste the __session cookie value from DevTools when prompted.
#
# The automatic path (get_token.js) uses a Playwright headless browser to:
#   1. Create a Clerk sign-in ticket via the Backend API
#   2. Navigate to localhost:3000 with the ticket — Clerk JS SDK signs in
#   3. Extract the __session cookie — the exact JWT Convex accepts
#
# This runs without any user interaction when pnpm dev is already running.

Write-Host ""
Write-Host "Attempting automatic token refresh via get_token.js ..."
$nodeScript = Join-Path $PSScriptRoot "get_token.js"
if (Test-Path $nodeScript) {
    node $nodeScript
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "[DONE] Token refreshed automatically. Run your tests now."
        exit 0
    }
    Write-Host "[WARN] get_token.js failed (exit $LASTEXITCODE). Falling back to manual paste."
    Write-Host "       Make sure 'pnpm dev' is running."
}

# Manual fallback
$envFile = Join-Path $PSScriptRoot ".env.test"

Write-Host ""
Write-Host "Paste your Clerk __session JWT (from DevTools → Application → Cookies → __session):"
Write-Host "(Note: expires in ~60 seconds — run tests immediately after)"
Write-Host ""
$token = Read-Host "Token"

if (-not $token) {
    Write-Error "No token provided."
    exit 1
}

$lines = if (Test-Path $envFile) { Get-Content $envFile } else { @() }
$updated = $false
$newLines = $lines | ForEach-Object {
    if ($_ -match "^CLERK_JWT_TOKEN=") {
        "CLERK_JWT_TOKEN=$token"
        $updated = $true
    } else {
        $_
    }
}
if (-not $updated) { $newLines += "CLERK_JWT_TOKEN=$token" }

$newLines | Set-Content $envFile -Encoding utf8
Write-Host ""
Write-Host "[OK] Token saved to $envFile"
Write-Host "     Run your tests now."
