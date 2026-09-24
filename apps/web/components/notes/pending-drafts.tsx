'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { getDraftEngine } from '@/lib/drafts/engine'
import { journalTransport, noteTransport } from '@/lib/drafts/transports'

/**
 * Background sync for drafts saved on this device (e.g. written offline, then the page was closed):
 * registers the transports, syncs everything due, and lists what is still waiting.
 */
export function PendingDrafts() {
  const [pending, setPending] = useState<string[]>([])

  useEffect(() => {
    const engine = getDraftEngine()
    engine.register('note', noteTransport)
    engine.register('journal', journalTransport)
    let alive = true
    const refresh = () => {
      if (alive) setPending(engine.attentionKeys())
    }
    void engine.load().then(async () => {
      refresh()
      await engine.syncAll()
      refresh()
    })
    const timer = setInterval(refresh, 3_000)
    window.addEventListener('online', refresh)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('online', refresh)
    }
  }, [])

  if (pending.length === 0) return null
  return (
    <div role="status" className="mb-4 rounded-xl border border-caution/30 bg-caution-soft px-3 py-2 text-sm text-ink">
      <p className="font-medium">
        {pending.length === 1 ? '1 draft is' : `${pending.length} drafts are`} saved on this device and not synced yet.
      </p>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {pending.map((key) => {
          const [kind, ...rest] = key.split(':')
          const target = rest.join(':')
          const href = kind === 'note' ? `/capture/notes/${target}` : `/capture/journal/${target}`
          return (
            <li key={key}>
              <Link href={href} className="text-accent underline-offset-2 hover:underline">
                {kind === 'note' ? 'Open note' : `Journal ${target}`}
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
