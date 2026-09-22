<#
  bootstrap-secrets.ps1 - one command that turns your repo-root .env into the
  two cluster objects every Deployment consumes (via envFrom, see section 4):

      ConfigMap allrounder-config    non-secret settings
      Secret    allrounder-secrets   credentials

  Idempotent: rerun any time .env changes. The
  `--dry-run=client -o yaml | kubectl apply -f -` pattern recreates the full
  data set each run, so keys you delete from .env disappear from the cluster.

  Usage:
      powershell -ExecutionPolicy Bypass -File deploy\scripts\bootstrap-secrets.ps1
#>
param(
  [string]$EnvFile   = (Join-Path $PSScriptRoot "..\..\.env"),
  [string]$Namespace = "allrounder"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $EnvFile)) { throw "Env file not found: $EnvFile" }

function Assert-Ok([string]$What) {
  if ($LASTEXITCODE -ne 0) { throw "$What failed (kubectl exit code $LASTEXITCODE)" }
}

# ---------------------------------------------------------------------------
# 1. Parse .env (KEY=VALUE lines, '#' comments, optional surrounding quotes)
# ---------------------------------------------------------------------------
$envMap = @{}
foreach ($line in Get-Content $EnvFile) {
  $t = $line.Trim()
  if ($t -eq "" -or $t.StartsWith("#")) { continue }
  $eq = $t.IndexOf("=")
  if ($eq -lt 1) { continue }
  $key   = $t.Substring(0, $eq).Trim()
  $value = $t.Substring($eq + 1)
  if ($value.Length -ge 2 -and
      (($value.StartsWith('"') -and $value.EndsWith('"')) -or
       ($value.StartsWith("'") -and $value.EndsWith("'")))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  $envMap[$key] = $value
}

# ---------------------------------------------------------------------------
# 2. Classify. Only keys listed here are shipped; see the two rules above.
# ---------------------------------------------------------------------------
$configKeys = @(
  "MODEL_PROVIDER", "MODEL_NAME", "MODEL_BASE_URL",
  "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS",
  "JIRA_BASE_URL", "JIRA_PROJECT_KEY", "JIRA_TENANT_PROJECT_ALLOWLIST",
  "JIRA_TRANSPORT", "ATLASSIAN_MCP_URL", "JIRA_CLOUD_ID",
  "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_ACCESS",
  "GITHUB_REPOSITORY_ALLOWLIST", "GITHUB_BASE_BRANCH",
  "GITHUB_PATH_ALLOWLIST", "GITHUB_PATH_DENYLIST", "GITHUB_DESTRUCTIVE_PATHS",
  "GITHUB_MAX_PATCH_FILES", "GITHUB_MAX_PATCH_BYTES", "GITHUB_REQUEST_TIMEOUT_SECONDS",
  "RATE_LIMIT_PER_MINUTE", "TRUSTED_PROXY_IPS",
  "MASTRA_REQUEST_TIMEOUT_SECONDS", "MASTRA_PG_SSL", "MASTRA_MEMORY_EMBEDDER",
  "SUPABASE_URL", "SUPABASE_JWKS_URL", "SUPABASE_JWT_ISSUER", "SUPABASE_JWT_AUDIENCE"
)

$secretKeys = @(
  "DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "WEBHOOK_SECRET", "APPROVAL_HMAC_SECRET",
  "MODEL_API_KEY", "OPENROUTER_API_KEY",
  "JIRA_EMAIL", "JIRA_API_TOKEN",
  "GITHUB_APP_PRIVATE_KEY", "GITHUB_TOKEN", "GITHUB_MCP_TOKEN"
)

# ---------------------------------------------------------------------------
# 3. Build env files for kubectl. Values go in verbatim (no shell quoting to
#    fight); empty values are skipped per rule 2.
# ---------------------------------------------------------------------------
function Get-EnvLines([string[]]$Keys) {
  $lines = @()
  foreach ($k in $Keys) {
    if ($envMap.ContainsKey($k) -and $envMap[$k] -ne "") {
      $lines += "$k=$($envMap[$k])"
    }
  }
  return $lines
}

$configLines = Get-EnvLines $configKeys
$secretLines = Get-EnvLines $secretKeys
if ($configLines.Count -eq 0 -and $secretLines.Count -eq 0) {
  throw "No known keys found in $EnvFile - did you copy .env.example to .env?"
}

$configTmp = Join-Path $env:TEMP "allrounder-config.env"
$secretTmp = Join-Path $env:TEMP "allrounder-secrets.env"
[IO.File]::WriteAllLines($configTmp, $configLines)   # UTF-8, no BOM
[IO.File]::WriteAllLines($secretTmp, $secretLines)

# ---------------------------------------------------------------------------
# 4. Apply (create-or-update).
# ---------------------------------------------------------------------------
kubectl create namespace $Namespace --dry-run=client -o yaml | kubectl apply -f - | Out-Null
Assert-Ok "namespace"

kubectl create configmap allrounder-config -n $Namespace `
  --from-env-file=$configTmp --dry-run=client -o yaml | kubectl apply -f -
Assert-Ok "configmap"

kubectl create secret generic allrounder-secrets -n $Namespace `
  --from-env-file=$secretTmp --dry-run=client -o yaml | kubectl apply -f -
Assert-Ok "secret"

Remove-Item $configTmp, $secretTmp -Force

# ---------------------------------------------------------------------------
# 5. Report (key names only - values never printed).
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "ConfigMap allrounder-config  <- $($configLines.Count) keys" -ForegroundColor Green
Write-Host "Secret    allrounder-secrets <- $($secretLines.Count) keys" -ForegroundColor Green
Write-Host "Namespace: $Namespace. Re-run this script after editing .env."
