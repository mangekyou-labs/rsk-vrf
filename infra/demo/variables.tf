variable "region" {
  description = "Region of the demo host."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "Host instance type. t3.micro is Free Tier eligible and runs the x86 worker image."
  type        = string
  default     = "t3.micro"
}

variable "rsk_rpc_url" {
  description = "Rootstock RPC the worker reads and sends through. The demo runs no rskj node."
  type        = string
  default     = "https://public-node.testnet.rsk.co"

  validation {
    condition     = can(regex("^https?://", var.rsk_rpc_url))
    error_message = "rsk_rpc_url must be an http(s) URL."
  }
}

variable "ghcr_owner" {
  description = "GitHub owner whose GHCR rsk-vrf-worker image the host runs. The host refuses any other image."
  type        = string
  default     = "mangekyou-labs"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.ghcr_owner))
    error_message = "ghcr_owner must be a lowercase GitHub owner name."
  }
}

variable "worker_image" {
  description = "Worker image pinned by digest, as printed by the Worker image workflow."
  type        = string

  validation {
    condition     = can(regex("^ghcr\\.io/${var.ghcr_owner}/rsk-vrf-worker@sha256:[0-9a-f]{64}$", var.worker_image))
    error_message = "worker_image must be ghcr.io/<ghcr_owner>/rsk-vrf-worker@sha256:<64 hex>."
  }
}

variable "coordinator_address" {
  description = "VRF Coordinator address on the chain rsk_rpc_url serves."
  type        = string

  validation {
    condition     = can(regex("^0x[0-9a-fA-F]{40}$", var.coordinator_address))
    error_message = "coordinator_address must be a 20-byte hex address."
  }
}

variable "drand_pin" {
  description = "Locally pinned drand chain config the worker checks the on-chain one against."
  type = object({
    public_key = string # four comma-separated 0x words, as DRAND_PIN_PUBLIC_KEY
    genesis    = number
    period     = number
  })
}

variable "proving_key_hashes" {
  description = "keyHashes of Proving Keys to create empty rsk-vrf/proving-key/<keyHash> secrets for. Each costs $0.40 a month."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for h in var.proving_key_hashes : can(regex("^0x[0-9a-f]{64}$", h))])
    error_message = "Each keyHash must be 0x followed by 64 lowercase hex digits."
  }
}
