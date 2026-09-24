import type postgres from 'postgres'
import type { Tx } from '../client.ts'

/**
 * Bind a JS object as a jsonb parameter. postgres.js serialises json/jsonb
 * parameters itself, so passing JSON.stringify(...) would double-encode it
 * into a jsonb *string*.
 */
export function jobsJsonb(tx: Tx, value: Record<string, unknown>): postgres.Parameter {
  return tx.json(value as postgres.JSONValue)
}
