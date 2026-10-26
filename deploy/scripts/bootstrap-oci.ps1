<#
.SYNOPSIS
    Turns a freshly created Oracle k3s node into a working ArgoCD cluster.

.DESCRIPTION
    This is the bridge between Terraform and GitOps. Terraform produces an
    instance with cloud-init already running k3s, and this script makes the
    cluster usable from the laptop in one pass.

    Sequence:
      1. Read the node's public IP from Terraform state, or take it as a flag.
      2. Wait for SSH, because cloud-init needs a few minutes on first boot.
      3. Copy /etc/rancher/k3s/k3s.yaml, rewrite it for remote access, and save
         it to tmp/oci-kubeconfig.yaml.
      4. Install ArgoCD at a version resolved from the GitHub release API.
      5. Apply deploy/argocd/applications-oci.yaml so ArgoCD adopts the oci
         overlay.
      6. Ship the ConfigMap and Secret by calling bootstrap-secrets.ps1 with
         KUBECONFIG pointed at the cloud context.
      7. Report the URL to verify.

    Nothing here writes a credential into git. The kubeconfig and the node key
    both live under paths that .gitignore already excludes.

.PARAMETER NodeKeyPath
    The private node key Terraform generated, usually
    deploy/terraform-oci/keys/allrounder-node.pem. It is the private half, even
    though ssh(1) pairs it with the public key registered in OCI.

.PARAMETER NodeIp
    Skip Terraform state lookup and target an address directly.

.PARAMETER ArgoVersion
    Pin an ArgoCD release tag such as v3.0.3. Left empty, the script asks the
    GitHub API for the current latest release, so no stale version is baked
    into the repository.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy\scripts\bootstrap-oci.ps1 -NodeKeyPath deploy\terraform-oci\keys\allrounder-node.pem
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodeKeyPath,
    [string]$NodeIp = "",
    [string]$ArgoVersion = "",
    [string]$RepoRoot = (Join-Path $PSScriptRoot "..\.."),
    [int]$BootWaitSec = 420
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$Message) {
    Write-Host "==> $Message"
}

# --- 1. Where is the node? ---------------------------------------------------
if ($NodeIp -eq "") {
    Write-Step "Reading the public IP from Terraform state"
    $NodeIp = (terraform -chdir="$RepoRoot/deploy/terraform-oci" output -raw public_ip) 2>$null
    if (-not $NodeIp) {
        throw "Could not read the public_ip output. Pass -NodeIp, or run terraform init and apply in deploy/terraform-oci first."
    }
}
Write-Host "   Node: $NodeIp"

if (-not (Test-Path $NodeKeyPath)) {
    throw "Node key not found at $NodeKeyPath. Terraform writes it under deploy/terraform-oci/keys/."
}

# --- 2. Wait for cloud-init to finish installing k3s ------------------------
Write-Step "Waiting for SSH and for the k3s installer to finish (up to ${BootWaitSec}s)"
$deadline = (Get-Date).AddSeconds($BootWaitSec)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        # accept-new keeps first contact non-interactive without the blanket
        # "ignore every host key" habit that would invite a machine-in-the-middle.
        $probe = & ssh -i $NodeKeyPath -o StrictHostKeyChecking=accept-new `
            -o ConnectTimeout=10 "ubuntu@$NodeIp" "sudo test -x /usr/local/bin/k3s && echo k3s-up" 2>$null
        if ($LASTEXITCODE -eq 0 -and ($probe -match "k3s-up")) {
            $ready = $true
            break
        }
    } catch {
        # Cloud-init is still running. Retry until the deadline.
    }
    Start-Sleep -Seconds 15
    Write-Host "   not ready yet, retrying"
}
if (-not $ready) {
    throw "k3s was not detectable within ${BootWaitSec}s. Inspect with: ssh -i $NodeKeyPath ubuntu@$NodeIp 'sudo tail -f /var/log/cloud-init-output.log'"
}
Write-Host "   k3s binary present on the node"

# --- 3. Pull and rewrite the kubeconfig ------------------------------------
Write-Step "Fetching the k3s kubeconfig"
$raw = (& ssh -i $NodeKeyPath -o StrictHostKeyChecking=accept-new `
    -o ConnectTimeout=10 "ubuntu@$NodeIp" "sudo cat /etc/rancher/k3s/k3s.yaml") -join "`n"
if (-not $raw) { throw "Empty kubeconfig. Is /etc/rancher/k3s/k3s.yaml present?" }

# Two edits make it usable off-node. The server address has to leave loopback,
# and the embedded certificate authority signs for localhost and the node's own
# addresses, not the public IP, so a verified TLS handshake by that address
# would fail. Skipping verification is acceptable here only because port 6443 is
# restricted to the operator CIDR in the security list.
$rewritten = $raw `
    -replace "server: https://127\.0\.0\.1:6443", "server: https://$NodeIp`:6443" `
    -replace '(?m)^\s*certificate-authority-data: .+$', "    insecure-skip-tls-verify: true"

$kubeDir = Join-Path $RepoRoot "tmp"
if (-not (Test-Path $kubeDir)) { New-Item -ItemType Directory -Path $kubeDir | Out-Null }
$KubeConfigPath = Join-Path $kubeDir "oci-kubeconfig.yaml"
Set-Content -Path $KubeConfigPath -Value $rewritten -Encoding ascii

# Ambient kubectl now targets the cloud cluster, including the calls made by
# bootstrap-secrets.ps1 later in this script.
$env:KUBECONFIG = $KubeConfigPath
kubectl config rename-context default oci | Out-Null
Write-Host "   context 'oci' written to $KubeConfigPath"

Write-Step "Confirming the node is Ready"
kubectl get nodes
if ($LASTEXITCODE -ne 0) { throw "kubectl cannot reach the cluster" }

# Raise the ingress edge above the 600s agent ceiling before any run is driven
# through it. The HelmChartConfig merges into k3s's bundled Traefik install, so
# the entrypoint responding timeouts stop relying on the 180s idle default.
Write-Step "Applying the Traefik edge timeout override"
kubectl apply -f (Join-Path $RepoRoot "deploy/k8s/oci-traefik-timeouts.yaml")
if ($LASTEXITCODE -ne 0) { throw "Could not apply the Traefik HelmChartConfig" }

# --- 4. Install ArgoCD ------------------------------------------------------
if ($ArgoVersion -eq "") {
    Write-Step "Resolving the current ArgoCD release from the GitHub API"
    # The GitHub API rejects requests with no User-Agent, hence the header.
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/argoproj/argo-cd/releases/latest" `
        -Headers @{ "User-Agent" = "allrounder-bootstrap" }
    $ArgoVersion = $release.tag_name
    if (-not $ArgoVersion) { throw "Could not resolve an ArgoCD release tag. Pass -ArgoVersion explicitly." }
}
Write-Host "   Installing ArgoCD $ArgoVersion"
kubectl apply -n argocd --server-side --force-conflicts -f `
    "https://raw.githubusercontent.com/argoproj/argo-cd/$ArgoVersion/manifests/install.yaml"
if ($LASTEXITCODE -ne 0) { throw "ArgoCD manifest apply failed" }

Write-Step "Waiting for ArgoCD components to roll out"
foreach ($deploy in @("argocd-application-controller", "argocd-repo-server", "argocd-server")) {
    kubectl -n argocd rollout status "deployment/$deploy" --timeout=300s
    if ($LASTEXITCODE -ne 0) { throw "$deploy did not become ready" }
}

# --- 5. Let GitOps take over -----------------------------------------------
Write-Step "Applying the ArgoCD Application for the oci overlay"
kubectl apply -f (Join-Path $RepoRoot "deploy/argocd/applications-oci.yaml")
if ($LASTEXITCODE -ne 0) { throw "Could not create the ArgoCD Application" }

# --- 6. Ship configuration and credentials ---------------------------------
Write-Step "Creating the ConfigMap and Secret from .env against the oci context"
& (Join-Path $PSScriptRoot "bootstrap-secrets.ps1")

# --- 7. What to do next ----------------------------------------------------
Write-Host ""
Write-Host "Bootstrap complete. The stack is pulling images now." -ForegroundColor Green
Write-Host "  Console:  http://$NodeIp/"
Write-Host "  API:      http://$NodeIp/backend/health"
Write-Host "  ArgoCD:   kubectl -n argocd port-forward svc/argocd-server 8080:443"
Write-Host ""
Write-Host "Images are still downloading on first sync. Watch with:"
Write-Host "  kubectl -n allrounder get pods -w"
Write-Host ""
Write-Host "Then verify the result:"
Write-Host "  powershell -File deploy\scripts\verify-deployment.ps1 -BaseUrl http://$NodeIp -ContextName oci"
Write-Host ""
Write-Host "Note: the arm64 image tag must exist before pods can pull. If you see"
Write-Host "ImagePullBackOff, the first multi-arch CD run has not published a tag"
Write-Host "yet, and the overlay pin is still amd64-only." -ForegroundColor Yellow
