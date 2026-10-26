variable "name" {
  description = "Worker name, also its WORKER_ID: primary or backup."
  type        = string
}

variable "grace_blocks" {
  description = "Blocks this worker waits before fulfilling: 0 for the Primary Worker, 100 for the Backup."
  type        = number
}

variable "compose" {
  description = "Contents of infra/compose/compose.yaml."
  type        = string
}

variable "rsk_network" {
  type = string
}

variable "instance_type" {
  type = string
}

variable "data_volume_gb" {
  type = number
}

variable "worker_image" {
  type = string
}

variable "coordinator_address" {
  type = string
}

variable "drand_pin" {
  type = object({
    public_key = string
    genesis    = number
    period     = number
  })
}

variable "proving_key_hashes" {
  type = list(string)
}

variable "vpc_cidr" {
  description = "CIDR of the host's VPC."
  type        = string
  default     = "10.37.0.0/24"
}
