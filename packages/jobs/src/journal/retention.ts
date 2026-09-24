/**
 * Retention for voice journal recordings (brief §7): failed or unreviewed recordings are kept for
 * at most seven days. The `retention.purge` job deletes expired ones; the journal page also purges
 * opportunistically, so retention holds even before the job's schedule is enabled.
 *
 * Other areas will add their own purges (e.g. 30-day raw mail/chat text in Milestone 2); the
 * integrator can call `runJournalRecordingRetention` from a combined handler, or register
 * `createJournalRetentionPurgeJobHandler()` while it is the only one.
 */
import { purgeExpiredRecordings, withService, type Db } from '@personal-home/db'
import type { JobHandler } from '../dispatcher/types.ts'

export async function runJournalRecordingRetention(deps: {
  db: Db
  now: () => Date
}): Promise<{ journalRecordingsDeleted: number }> {
  const { deleted } = await withService(deps.db, (tx) => purgeExpiredRecordings(tx, deps.now()))
  return { journalRecordingsDeleted: deleted }
}

export function createJournalRetentionPurgeJobHandler(options: { timeoutMs?: number } = {}): JobHandler {
  return {
    kind: 'retention.purge',
    timeoutMs: options.timeoutMs ?? 15_000,
    async run(ctx) {
      return runJournalRecordingRetention({ db: ctx.db, now: ctx.now })
    },
  }
}
