terraform {
  required_version = ">= 1.5.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 5.0, < 7.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = ">= 4.0"
    }
  }
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.api_key_private_key_path
  region           = var.region
}

# ---------------------------------------------------------------------------
# Placement
# ---------------------------------------------------------------------------

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

locals {
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name

  # The Always Free Arm shape is AMD64-incompatible, which is exactly why the
  # CD pipeline had to start publishing linux/arm64 images. Ubuntu 24.04 is
  # picked by OS name and version rather than by a hard-coded image OCID,
  # because Oracle retires and re-publishes image OCIDs regularly.
  image = data.oci_core_images.ubuntu.images[0]
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
  state                    = "AVAILABLE"
}

# ---------------------------------------------------------------------------
# Network: one VCN, one public subnet, internet route, and the only firewall
# that matters on OCI (the security list, not the OS firewall).
# ---------------------------------------------------------------------------

resource "oci_core_vcn" "this" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "${var.display_name}-vcn"
  dns_label      = var.vcn_dns_label
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.display_name}-igw"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.display_name}-public-routes"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.this.id
  }
}

resource "oci_core_security_list" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.display_name}-security"

  egress_security_rules {
    protocol         = "all"
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    description      = "Required for image pulls, k3s updates and provider calls"
  }

  ingress_security_rules {
    protocol    = "6"
    source      = var.admin_cidr
    source_type = "CIDR_BLOCK"

    tcp_options {
      min = 22
      max = 22
    }

    description = "SSH from the operator network only"
  }

  # k3s runs Traefik as the cluster ingress, and NodePort ranges are used by
  # the k3s service load balancer. Both 80 and 443 are the whole public face.
  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"

    tcp_options {
      min = 80
      max = 443
    }

    description = "Public HTTP and HTTPS through the Traefik ingress"
  }

  # bootstrap-oci.ps1 copies the k3s kubeconfig to the laptop and talks to the
  # API server from here, so 6443 must be reachable by the operator. It is
  # scoped to admin_cidr rather than the world, and the kubeconfig client
  # certificate is the actual gate.
  ingress_security_rules {
    protocol    = "6"
    source      = var.admin_cidr
    source_type = "CIDR_BLOCK"

    tcp_options {
      min = 6443
      max = 6443
    }

    description = "k3s API server for the operator kubeconfig"
  }

  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"

    tcp_options {
      min = 30000
      max = 32767
    }

    description = "k3s NodePort range, used by the Traefik service"
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.this.id
  cidr_block                 = "10.0.0.0/24"
  display_name               = "${var.display_name}-public"
  dns_label                  = var.subnet_dns_label
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.this.id]
  prohibit_internet_ingress  = false
  prohibit_public_ip_on_vnic = false
}

# ---------------------------------------------------------------------------
# Compute: one Always Free Ampere A1 node running single-node k3s.
# ---------------------------------------------------------------------------

resource "tls_private_key" "node" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "local_file" "node_private_key" {
  content         = tls_private_key.node.private_key_pem
  filename        = "${path.module}/keys/${var.display_name}-node.pem"
  file_permission = "0600"
}

resource "oci_core_ssh_key" "node" {
  compartment_id = var.compartment_ocid
  public_key     = tls_private_key.node.public_key_openssh
  name           = "${var.display_name}-node"
}

resource "oci_core_instance" "k3s" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = "${var.display_name}-k3s"
  shape               = var.shape

  shape_config_details {
    # Always Free Ampere allowance as of October 2026 is 2 OCPU and 12 GB RAM.
    # Raising either number turns an Always Free instance into a paid one.
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  create_boot_volume = true

  source_details {
    source_type             = "image"
    image_id                = local.image.id
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
  }

  subnet_id   = oci_core_subnet.public.id
  ssh_key_ids = [oci_core_ssh_key.node.id]

  # The modern provider places this inside create_vnic_details. The top-level
  # assign_public_ip argument is the legacy path and the two conflict.
  create_vnic_details {
    assign_public_ip = true
  }

  metadata = {
    user_data = base64encode(templatefile("${path.module}/cloud-init.yml.tftpl", {
      # Nothing secret belongs in user_data. OCI instance metadata is readable
      # by anyone with read access to the instance, so this carries only the
      # k3s bootstrap. Cluster secrets arrive later through bootstrap-secrets.
      k3s_version = var.k3s_version
    }))
  }

  # A replacement image or a resized shape should not silently destroy the
  # node and its container storage.
  lifecycle {
    prevent_destroy = false
  }
}
