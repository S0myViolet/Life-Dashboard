import { buttonClass } from '@/components/ui/button'

export const metadata = { title: 'Offline' }

/**
 * Served by the service worker when a page cannot be loaded. It is cached
 * without cookies, so it must stay static and never show owner data.
 */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <p className="text-sm font-medium text-ink-faint">Personal Home</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">You&rsquo;re offline</h1>
      <p className="mt-2 text-sm text-ink-muted">
        This page needs a connection. Your data stays on the server and is not stored on this
        device, so nothing is shown here until you reconnect.
      </p>
      {/* A full page load on purpose: it goes back through the service worker's network-first
          navigation instead of a client-side fetch that would fail again offline. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className={buttonClass('primary', 'mt-6 w-full')}>
        Try again
      </a>
    </main>
  )
}
