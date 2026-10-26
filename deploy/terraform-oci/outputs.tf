output "instance_id" {
  value = oci_core_instance.k3s.id
}

output "public_ip" {
  description = "Serves HTTP and HTTPS through k3s Traefik once the oci overlay syncs. This is the URL you verify against."
  value       = oci_core_instance.k3s.public_ip
}

output "private_ip" {
  value = oci_core_instance.k3s.private_ip
}

output "image_used" {
  description = "Proof the Arm image was resolved rather than hard-coded."
  value       = "${local.image.operating_system} ${local.image.operating_system_version} (${local.image.display_name})"
}

output "ssh_command" {
  description = "cloud-init needs about three minutes on first boot. Until k3s is up, this is the only way in."
  value       = "ssh -i ${path.module}/keys/${var.display_name}-node.pem ubuntu@${oci_core_instance.k3s.public_ip}"
}

output "next_step" {
  value = <<-EOT
    Terraform has created the node. Now, from the repository root:
      powershell -ExecutionPolicy Bypass -File deploy\scripts\bootstrap-oci.ps1 -NodeKeyPath ${path.module}/keys/${var.display_name}-node.pem
    That pulls the kubeconfig, installs ArgoCD, applies the oci overlay, and ships the secrets.
  EOT
}
