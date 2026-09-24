import type { Tx } from './client.ts'

export type ClaimOwnerResult = 'claimed' | 'already_owner' | 'rejected'

/**
 * Claim (or confirm) the single dashboard owner. Service transaction only:
 * the caller must already have verified that the identity's email matches
 * OWNER_EMAIL and that the provider marked it verified.
 */
export async function claimOwner(tx: Tx, userId: string, email: string): Promise<ClaimOwnerResult> {
  const [row] = await tx<{ result: ClaimOwnerResult }[]>`
    select private.claim_owner(${userId}::uuid, ${email}) as result
  `
  if (!row) throw new Error('claim_owner returned no row')
  return row.result
}

/** True when the current transaction's JWT subject is the dashboard owner. */
export async function isOwner(tx: Tx): Promise<boolean> {
  const [row] = await tx<{ isOwner: boolean }[]>`select public.is_owner() as is_owner`
  return row?.isOwner === true
}
