'use client'

/**
 * React binding for the draft engine: an editor reads `value` / `indicator` from here and writes
 * with `setValue`. Editing is only possible once `ready` (the stored draft has been reconciled
 * with the server version), so an edit can never be based on the wrong version.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { draftKey, getDraftEngine, type DraftSnapshot, type DraftTransport } from './engine'
import type { ConflictChoice, DraftKind, ServerSnapshot } from './logic'

export interface UseDraftResult<C> extends DraftSnapshot<C> {
  ready: boolean
  setValue: (value: C) => void
  resolve: (choice: ConflictChoice<C>) => void
  discard: () => void
  /** Sync now and wait; true when nothing local remains unsynced. */
  flush: () => Promise<boolean>
  /** Adopt a newer server snapshot returned by another action. */
  observeServer: (server: ServerSnapshot<C>) => void
}

export function useDraft<C>(
  kind: DraftKind,
  targetId: string,
  server: ServerSnapshot<C> | null,
  transport: DraftTransport<C>,
): UseDraftResult<C> {
  const key = draftKey(kind, targetId)
  const serverVersion = server?.version ?? 0
  const [state, setState] = useState<{ key: string; snap: DraftSnapshot<C>; ready: boolean }>(() => ({
    key,
    ready: false,
    snap: {
      key,
      draft: null,
      server,
      value: server?.content ?? transport.empty,
      indicator: 'synced',
      persisting: false,
    },
  }))

  useEffect(() => {
    const engine = getDraftEngine()
    engine.register(kind, transport)
    let alive = true
    const unsubscribe = engine.subscribe(key, (s) => {
      if (alive) setState((prev) => ({ key, ready: prev.key === key ? prev.ready : false, snap: s as DraftSnapshot<C> }))
    })
    void engine.open(kind, targetId, server).then((s) => {
      if (alive) setState({ key, ready: true, snap: s })
    })
    return () => {
      alive = false
      unsubscribe()
    }
    // `server` is identified by its version; a new object with the same version is the same state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, kind, targetId, serverVersion, transport])

  const setValue = useCallback((value: C) => getDraftEngine().edit(kind, targetId, value), [kind, targetId])
  const resolve = useCallback(
    (choice: ConflictChoice<C>) => getDraftEngine().resolve(kind, targetId, choice),
    [kind, targetId],
  )
  const discard = useCallback(() => getDraftEngine().discard(kind, targetId), [kind, targetId])
  const flush = useCallback(() => getDraftEngine().flush(kind, targetId), [kind, targetId])
  const observeServer = useCallback(
    (s: ServerSnapshot<C>) => getDraftEngine().observeServer(kind, targetId, s),
    [kind, targetId],
  )

  const current = state.key === key ? state : null
  return useMemo(
    () => ({
      ...(current?.snap ?? {
        key,
        draft: null,
        server,
        value: server?.content ?? transport.empty,
        indicator: 'synced' as const,
        persisting: false,
      }),
      ready: current?.ready ?? false,
      setValue,
      resolve,
      discard,
      flush,
      observeServer,
    }),
    [current, key, server, transport.empty, setValue, resolve, discard, flush, observeServer],
  )
}
