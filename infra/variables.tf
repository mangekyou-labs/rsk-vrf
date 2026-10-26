variable "primary_region" {
  description = "Region of the Primary Worker (graceBlocks 0)."
  type        = string
  default     = "eu-central-1"
}

variable "backup_region" {
  description = "Region of the Backup Worker (graceBlocks 100)."
  type        = string
  default     = "us-east-1"
}

variable "rsk_network" {
  description = "rskj network flag: testnet (chain 31) or main (chain 30)."
  type        = string
  default     = "testnet"

  validation {
    condition     = contains(["testnet", "main"], var.rsk_network)
    error_message = "rsk_network must be testnet or main."
  }
}

variable "instance_type" {
  description = "Host instance type."
  type        = string
  default     = "m7i.large"
}

variable "data_volume_gb" {
  description = "Size of the gp3 volume holding the rskj database."
  type        = number
  default     = 250
}

variable "worker_image" {
  description = "Worker image pinned by digest, as printed by the Worker image workflow."
  type        = string

  validation {
    condition     = can(regex("^ghcr\\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.worker_image))
    error_message = "worker_image must be a ghcr.io image pinned by digest (…@sha256:<64 hex>)."
  }
}

variable "coordinator_address" {
  description = "VRF Coordinator address on the chain rskj follows."
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
  description = "keyHashes of Proving Keys to create empty rsk-vrf/proving-key/<keyHash> secrets for, in both regions. Values are set out of band."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for h in var.proving_key_hashes : can(regex("^0x[0-9a-f]{64}$", h))])
    error_message = "Each keyHash must be 0x followed by 64 lowercase hex digits."
  }
}
