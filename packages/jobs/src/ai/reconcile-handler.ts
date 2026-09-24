import type { JobHandler } from '../dispatcher/types.ts'
import { runAiReconcileJob } from './gateway.ts'

/**
 * Hourly sweep: reservations still `reserved` after 24h become `ambiguous`.
 * They stay fully counted against the budget; nothing is ever auto-released.
 */
export const aiReconcileJobHandler: JobHandler = {
  kind: 'ai.reconcile',
  timeoutMs: 20_000,
  async run(ctx) {
    const { swept } = await runAiReconcileJob({ db: ctx.db, now: ctx.now })
    return { swept }
  },
}
