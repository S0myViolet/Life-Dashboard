/**
 * The daily `retention.purge` job (brief §7), combining each area's clean-up:
 *   - voice journal recordings past their 7-day expiry are deleted;
 *   - captured chat text older than 30 days is cleared (hashes, times and summaries stay).
 * Chat text is purged in bounded batches so one run stays within the dispatcher budget;
 * anything left is picked up by the next run.
 */
import { capturePurgeRawText, withService } from '@personal-home/db'
import type { JobHandler } from '../dispatcher/types.ts'
import { runJournalRecordingRetention } from '../journal/retention.ts'

const MAX_CAPTURE_BATCHES = 20

export function createRetentionPurgeJobHandler(options: { timeoutMs?: number } = {}): JobHandler {
  return {
    kind: 'retention.purge',
    timeoutMs: options.timeoutMs ?? 25_000,
    async run(ctx) {
      const journal = await runJournalRecordingRetention({ db: ctx.db, now: ctx.now })
      let captureTextPurged = 0
      let more = true
      for (let batch = 0; more && batch < MAX_CAPTURE_BATCHES && !ctx.signal.aborted; batch++) {
        const result = await withService(ctx.db, (tx) =>
          capturePurgeRawText(tx, { now: ctx.now() }),
        )
        captureTextPurged += result.purged
        more = result.more
      }
      return { ...journal, captureTextPurged, captureTextRemaining: more }
    },
  }
}
