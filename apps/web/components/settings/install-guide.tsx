'use client'

import { useSyncExternalStore } from 'react'
import { Share, SquarePlus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/ui/status-pill'

type Platform = { ios: boolean; standalone: boolean }

let cachedPlatform: Platform | undefined

function readPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform
  const nav = navigator as Navigator & { standalone?: boolean }
  const ios =
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  const standalone =
    nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches
  cachedPlatform = { ios, standalone }
  return cachedPlatform
}

const subscribe = () => () => {}

/**
 * Add to Home Screen guidance. Detection only tailors the wording; it never
 * prompts for anything. Notification permission will be requested later, and
 * only from an explicit "Enable notifications" button.
 */
export function InstallGuide() {
  const platform = useSyncExternalStore(subscribe, readPlatform, () => null)

  return (
    <div className="space-y-4">
      {platform?.standalone ? (
        <p className="rounded-xl bg-positive-soft px-3 py-2 text-sm text-positive" role="status">
          You are using Personal Home from your Home Screen.
        </p>
      ) : null}

      <Card aria-labelledby="install-iphone-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="install-iphone-title" className="text-[15px] font-semibold text-ink">
            On iPhone
          </h2>
          {platform?.ios && !platform.standalone ? <Pill tone="accent">This device</Pill> : null}
        </div>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-muted">
          <li>Open Personal Home in Safari and sign in.</li>
          <li>
            Tap <strong className="text-ink">Share</strong>{' '}
            <Share aria-hidden className="inline size-4 align-text-bottom" /> (the square with an
            arrow; on recent iOS versions it can sit inside the &hellip; menu).
          </li>
          <li>
            Scroll down and tap <strong className="text-ink">Add to Home Screen</strong>{' '}
            <SquarePlus aria-hidden className="inline size-4 align-text-bottom" />, then{' '}
            <strong className="text-ink">Add</strong>.
          </li>
          <li>Open Personal Home from the new icon. You stay signed in.</li>
        </ol>
      </Card>

      <Card aria-labelledby="install-laptop-title">
        <h2 id="install-laptop-title" className="text-[15px] font-semibold text-ink">
          On a laptop
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          In Chrome or Edge, use the install icon in the address bar (or the menu&rsquo;s{' '}
          <strong className="text-ink">Install Personal Home</strong>). In Safari on a Mac, choose{' '}
          <strong className="text-ink">File → Add to Dock</strong>.
        </p>
      </Card>

      <Card aria-labelledby="install-notifications-title">
        <h2 id="install-notifications-title" className="text-[15px] font-semibold text-ink">
          Notifications
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          Nothing here asks for permission. Notifications arrive in Milestone 2 behind an explicit
          Enable notifications button. On iPhone they need iOS 16.4 or later and the Home Screen
          app, and delivery time depends on the device and network.
        </p>
      </Card>
    </div>
  )
}
