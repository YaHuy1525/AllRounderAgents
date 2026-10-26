variable "tenancy_ocid" {
  type        = string
  description = "OCID of your Oracle tenancy. Found under Profile, Tenancy, Tenancy OCID."
}

variable "user_ocid" {
  type        = string
  description = "OCID of the API user whose API key authenticates Terraform."
}

variable "fingerprint" {
  type        = string
  description = "SHA-256 fingerprint of the public API key uploaded to that user."
}

variable "api_key_private_key_path" {
  type        = string
  description = "Path to the .pem private key for the OCI API user. This is not the node key generated below."
}

variable "region" {
  type        = string
  default     = "ap-sydney-1"
  description = "OCI region identifier. Your home region is fixed at signup and cannot be changed later, so choose it deliberately. ap-sydney-1 is the closest Australian region with more Always Free capacity than ap-melbourne-1."
}

variable "compartment_ocid" {
  type        = string
  description = "Compartment to build in. Defaults to the tenancy root, which is where Always Free resources live by policy."
}

variable "display_name" {
  type        = string
  default     = "allrounder"
  description = "Prefix for every created resource name."
}

variable "vcn_dns_label" {
  type        = string
  default     = "allr"
  description = "DNS label for the VCN. Must be 15 characters or fewer, alphanumeric."
}

variable "subnet_dns_label" {
  type        = string
  default     = "public"
  description = "DNS label for the public subnet."
}

variable "admin_cidr" {
  type        = string
  default     = "0.0.0.0/0"
  description = "CIDR allowed to reach SSH. Tighten this to your own /32 as soon as it works, because a public key with no passphrase and 0.0.0.0/0 is an invitation."
}

variable "shape" {
  type        = string
  default     = "VM.Standard.A1.Flex"
  description = "Ampere Arm shape. This is the Always Free compute shape and the reason images must be built for linux/arm64."
}

variable "ocpus" {
  type        = number
  default     = 2
  description = "OCPU count. Two is the current Always Free ceiling, so more means paid billing."
}

variable "memory_in_gbs" {
  type        = number
  default     = 12
  description = "RAM in GB. Twelve is the current Always Free ceiling for the Ampere allocation."
}

variable "boot_volume_size_in_gbs" {
  type        = number
  default     = 100
  description = "Boot volume size. k3s plus every container image lives here, so anything under 50 GB will fill up during a rollout."
}

variable "k3s_version" {
  type        = string
  default     = ""
  description = "Exact k3s channel such as v1.33.5+k3s1. Left empty, the installer takes the current stable release."
}
