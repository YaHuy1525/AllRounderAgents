<#
.SYNOPSIS
    Proves the deployed stack actually serves, and rolls back if it does not.

.DESCRIPTION
    CD finishes at "the pin commit was pushed". That is not the same claim as
    "the application is serving traffic", and only the second one matters. This
    watchdog closes that gap for the local k3d cluster.

    It runs on the machine that hosts the cluster, because a GitHub-hosted
    runner has no network path to k3d. Three checks in order:
      1. ArgoCD reports the Application Synced and Healthy.
      2. Every Deployment finished rolling out.
      3. The ingress serves real HTTP responses through the nip.io hostnames.

    A failing image pull, a crash loop, or a bad environment variable stops the
    run here. With -AutoRollback the script reverts the image pin commit and
    pushes it, which sends ArgoCD back to the previous known good images.

.PARAMETER AutoRollback
    Revert the most recent pin commit and push it when verification fails.

.PARAMETER TimeoutSec
    Total seconds to wait for ArgoCD and the rollouts before declaring failure.

.PARAMETER BaseUrl
    Root URL of the environment to verify, such as http://203.0.113.10 for the
    Oracle node. Left empty, the laptop k3d defaults are used, where each
    service has its own nip.io host. A cloud cluster reached by bare IP has no
    per-service hostname, because the UI container proxies /backend to the api
    Service itself.

.PARAMETER Kubeconfig
    Path to a kubeconfig file to select instead of the ambient one, such as
    tmp/oci-kubeconfig.yaml written by bootstrap-oci.ps1.

.PARAMETER Context
    Context name to switch to inside the active kubeconfig.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy\scripts\verify-deployment.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy\scripts\verify-deployment.ps1 -AutoRollback

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy\scripts\verify-deployment.ps1 -BaseUrl http://203.0.113.10 -Kubeconfig tmp\oci-kubeconfig.yaml -Context oci
#>
[CmdletBinding()]
param(
    [string]$AppName = "allrounder",
    [string]$AppNamespace = "argocd",
    [string]$TargetNamespace = "allrounder",
    [int]$TimeoutSec = 300,
    [string]$BaseUrl = "",
    [string]$Kubeconfig = "",
    [string]$Context = "",
    [switch]$AutoRollback
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($Kubeconfig -ne "") {
    if (-not (Test-Path $Kubeconfig)) { throw "Kubeconfig not found: $Kubeconfig" }
    $env:KUBECONFIG = (Resolve-Path $Kubeconfig).Path
}
if ($Context -ne "") {
    kubectl config use-context $Context | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Context '$Context' is not in the active kubeconfig" }
}

# The deployments CD owns. redis is stateful infrastructure and is checked by
# rollout for the same reason the application workloads are.
$deployments = @("api", "mastra", "ui", "redis")

# The endpoints that prove the stack serves. On the laptop cluster each service
# has its own nip.io hostname through Traefik host matching. On a cloud node
# addressed by IP there is no hostname to match, so the API is reached through
# the same-origin /backend proxy inside the UI container instead.
if ($BaseUrl -ne "") {
    $root = $BaseUrl.TrimEnd('/')
    $probes = @(
        @{ Name = "ui index"; Url = "$root/"; Expect = 200 },
        @{ Name = "api health via /backend"; Url = "$root/backend/health"; Expect = 200 }
    )
} else {
    $probes = @(
        @{ Name = "api health"; Url = "http://api.127.0.0.1.nip.io/health"; Expect = 200 },
        @{ Name = "ui index"; Url = "http://app.127.0.0.1.nip.io/"; Expect = 200 }
    )
}

function Write-Step([string]$Message) {
    Write-Host "==> $Message"
}

function Invoke-Rollback {
    Write-Step "Locating the most recent image pin commit to undo"
    $pin = git log -1 --format=%H --grep="^cd: pin images" 2>$null
    if (-not $pin) {
        Write-Host "ROLLBACK SKIPPED: no pin commit found, so nothing to revert." -ForegroundColor Yellow
        return $false
    }
    $short = $pin.Substring(0, 7)
    Write-Host "Reverting pin commit $short and pushing it so ArgoCD rolls back." -ForegroundColor Yellow
    git revert --no-edit $pin
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ROLLBACK FAILED: git revert exited $LASTEXITCODE. Resolve by hand." -ForegroundColor Red
        return $false
    }
    git push
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ROLLBACK PUSH FAILED: git push exited $LASTEXITCODE. The cluster still targets the bad images." -ForegroundColor Red
        return $false
    }
    Write-Host "Rollback pushed. ArgoCD will sync the previous tags within a few minutes." -ForegroundColor Green
    return $true
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$failures = @()

# --- Check 1: ArgoCD converged ------------------------------------------------
Write-Step "Waiting for ArgoCD Application '$AppName' to be Synced and Healthy"
$argocdOk = $false
while ((Get-Date) -lt $deadline) {
    $sync = (kubectl get application $AppName -n $AppNamespace -o jsonpath="{.status.sync.status}" 2>$null)
    $health = (kubectl get application $AppName -n $AppNamespace -o jsonpath="{.status.health.status}" 2>$null)
    $operation = (kubectl get application $AppName -n $AppNamespace -o jsonpath="{.status.operationState.phase}" 2>$null)
    Write-Host "   sync=$sync health=$health operation=$operation"
    if ($sync -eq "Synced" -and $health -eq "Healthy") {
        $argocdOk = $true
        break
    }
    Start-Sleep -Seconds 10
}
if (-not $argocdOk) {
    $failures += "ArgoCD did not reach Synced and Healthy within ${TimeoutSec}s"
}

# --- Check 2: rollouts finished -----------------------------------------------
foreach ($name in $deployments) {
    Write-Step "Checking rollout for deployment/$name"
    $out = kubectl rollout status "deployment.apps/$name" -n $TargetNamespace --timeout=60s 2>&1
    if ($LASTEXITCODE -ne 0) {
        $failures += "deployment/$name did not roll out: $out"
        Write-Host "   FAILED: $out" -ForegroundColor Red
        continue
    }
    Write-Host "   OK: $out"
}

# --- Check 3: the stack answers over HTTP -------------------------------------
foreach ($probe in $probes) {
    Write-Step "Requesting $($probe.Name) at $($probe.Url)"
    try {
        $response = Invoke-WebRequest -Uri $probe.Url -UseBasicParsing -TimeoutSec 20
        if ($response.StatusCode -eq $probe.Expect) {
            Write-Host "   OK: HTTP $($response.StatusCode)"
        } else {
            $failures += "$($probe.Name) returned HTTP $($response.StatusCode), expected $($probe.Expect)"
            Write-Host "   FAILED: HTTP $($response.StatusCode)" -ForegroundColor Red
        }
    } catch {
        $failures += "$($probe.Name) request failed: $($_.Exception.Message)"
        Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# --- Verdict ------------------------------------------------------------------
if ($failures.Count -eq 0) {
    Write-Host ""
    Write-Host "VERIFICATION PASSED: the deployed stack is serving." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "VERIFICATION FAILED:" -ForegroundColor Red
foreach ($failure in $failures) {
    Write-Host "  - $failure" -ForegroundColor Red
}

if ($AutoRollback) {
    Invoke-Rollback | Out-Null
} else {
    Write-Host "Rerun with -AutoRollback to revert the image pin automatically." -ForegroundColor Yellow
}
exit 1
