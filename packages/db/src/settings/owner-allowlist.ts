/**
 * Sign-up allowlist read by the Supabase "Before User Created" hook
 * (public.hook_before_user_created). Service transactions only: the table lives
 * in the private schema and is invisible to anon/authenticated.
 */
import { z } from 'zod'
import type { Tx } from '../client.ts'

const AllowlistEmailSchema = z
  .email()
  .max(320)
  .transform((v) => v.trim().toLowerCase())

/** Add an address to the sign-up allowlist (idempotent). Returns the stored form. */
export async function ensureOwnerAllowlisted(tx: Tx, email: string): Promise<string> {
  const normalized = AllowlistEmailSchema.parse(email.trim())
  await tx`
    insert into private.owner_allowlist (email) values (${normalized})
    on conflict (email) do nothing
  `
  return normalized
}

/** Remove an address from the sign-up allowlist. Existing users are not affected. */
export async function removeOwnerAllowlisted(tx: Tx, email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase()
  const rows = await tx`delete from private.owner_allowlist where email = ${normalized} returning 1`
  return rows.length > 0
}
