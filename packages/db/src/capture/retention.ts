/**
 * Retention for captured chat text (brief §7: raw imported chat text is kept for
 * 30 days by default). Only the raw text is removed; content hashes, version
 * metadata, snapshot coverage and derived data stay, so later captures still
 * reconcile without re-creating messages and summaries keep their provenance.
 *
 * The clock starts when a text version was first captured. Seeing the same text
 * again later does not restore it (the hash proves it is unchanged).
 * Service transaction; intended for the `retention.purge` job. NOT scheduled
 * yet: no job handler calls it until retention.purge arrives (Milestone 2), and
 * the Settings copy says so (apps/web/lib/capture/view.ts CAPTURE_RETENTION_NOTE).
 */
import { CAPTURE_LIMITS } from '@personal-home/core'
import type { Tx } from '../client.ts'

export interface CapturePurgeResult {
  purged: number
  /** More rows are due; call again (the batch size bounds each transaction). */
  more: boolean
}

export async function capturePurgeRawText(
  tx: Tx,
  options: { now?: Date; retentionDays?: number; batchSize?: number } = {},
): Promise<CapturePurgeResult> {
  const now = options.now ?? new Date()
  const days = options.retentionDays ?? CAPTURE_LIMITS.rawTextRetentionDays
  const batchSize = options.batchSize ?? 5000
  if (!Number.isInteger(days) || days < 1) throw new RangeError('retentionDays must be a positive integer')
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer')
  const cutoff = new Date(now.getTime() - days * 86_400_000)

  const rows = await tx`
    update public.captured_message_versions
    set text = null, text_purged_at = ${now}
    where id in (
      select id from public.captured_message_versions
      where text is not null and captured_at < ${cutoff}
      order by captured_at
      limit ${batchSize}
      for update skip locked
    )
    returning id
  `
  return { purged: rows.length, more: rows.length === batchSize }
}
