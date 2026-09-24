/**
 * The handlers the deployed dispatcher runs. Only real handlers are listed:
 * a kind without one is never claimed, and its schedule stays disabled in
 * JOB_SCHEDULE_DEFINITIONS (packages/core/src/jobs/schedules.ts). Later
 * milestones add their sync/AI/push handlers here.
 *
 * Network access and server settings are injected so packages never read the
 * environment themselves. With the defaults (no settings), the connection
 * checks find nothing to do and report that honestly.
 */
import { aiReconcileJobHandler } from '../ai/reconcile-handler.ts'
import { briefingJobHandlers } from '../briefings/handler.ts'
import { connectionJobHandlers } from '../connections/job-handlers.ts'
import { createJobHandlerRegistry, type JobHandlerRegistry } from './types.ts'

export interface DefaultJobHandlerDeps {
  fetch?: typeof fetch
  /** Server settings lookup, e.g. `(name) => Deno.env.get(name)`. */
  env?: (name: string) => string | undefined
}

export function createDefaultJobHandlerRegistry(
  deps: DefaultJobHandlerDeps = {},
): JobHandlerRegistry {
  const fetchImpl = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const env = deps.env ?? (() => undefined)
  return createJobHandlerRegistry([
    ...briefingJobHandlers,
    aiReconcileJobHandler,
    ...connectionJobHandlers({ fetch: fetchImpl, env }),
  ])
}
