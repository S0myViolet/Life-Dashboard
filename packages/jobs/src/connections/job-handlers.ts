/**
 * Adapts the connection handlers to the dispatcher's JobHandler contract.
 * Network access and server settings are injected (packages must not read
 * the environment themselves); the Edge Function passes Deno.env and fetch.
 */
import { JobFailure } from '@personal-home/core'
import type { JobHandler } from '../dispatcher/types.ts'
import { connectionHandlers, type ConnectionJobHandler } from './handlers.ts'

export interface ConnectionJobDeps {
  fetch: typeof fetch
  env: (name: string) => string | undefined
}

function toJobHandler(
  kind: 'sync.google' | 'sync.microsoft',
  handler: ConnectionJobHandler,
  deps: ConnectionJobDeps,
): JobHandler {
  return {
    kind,
    // Must fit the Edge dispatcher budget (see EDGE_DISPATCHER_LIMITS); the handler
    // stops between accounts when aborted and asks to be retried.
    timeoutMs: 25_000,
    async run(ctx) {
      const result = await handler(
        { db: ctx.db, now: ctx.now, fetch: deps.fetch, signal: ctx.signal, env: deps.env },
        { id: ctx.job.id, kind: ctx.job.kind, payload: ctx.job.payload },
      )
      if (result.status === 'succeeded') return { outcome: 'succeeded' }
      throw new JobFailure(result.error, {
        retryable: result.status === 'retry',
        retryAt: result.status === 'retry' ? (result.retryAt ?? null) : null,
      })
    },
  }
}

export function connectionJobHandlers(deps: ConnectionJobDeps): JobHandler[] {
  return [
    toJobHandler('sync.google', connectionHandlers['sync.google'], deps),
    toJobHandler('sync.microsoft', connectionHandlers['sync.microsoft'], deps),
  ]
}
