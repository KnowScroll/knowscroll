import { z } from 'zod'

/**
 * The contract version. Every top-level message and every event carries it (D-095, D-106).
 * Version 1 carries Phase 1's fields only.
 */
export const CONTRACT_VERSION = 1 as const

export const ContractVersion = z.literal(CONTRACT_VERSION)
