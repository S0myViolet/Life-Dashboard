/**
 * Persistent quick capture (Home, and reusable on other pages): task, reading log, note and
 * journal. Loads only what the forms need (the owner's today and the books to log against)
 * in one owner transaction; the saves go through each area's own server actions.
 */
import { unstable_rethrow } from 'next/navigation'
import { addLocalDays, isValidTimeZone, localDateInZone } from '@personal-home/core'
import { listBookOptions } from '@personal-home/db'
import { withOwnerTx } from '@/lib/server/session'
import { QuickCaptureTabs } from './quick-capture-tabs'
import type { QuickCaptureBook } from './reading-capture'

export const QUICK_CAPTURE_ID = 'quick-capture'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section
      id={QUICK_CAPTURE_ID}
      aria-labelledby="quick-capture-title"
      className="mt-4 scroll-mt-4 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5"
    >
      <h2
        id="quick-capture-title"
        className="mb-3 text-[15px] font-semibold tracking-tight text-ink"
      >
        Quick capture
      </h2>
      {children}
    </section>
  )
}

export async function QuickCapture() {
  let data: { today: string; tomorrow: string; tz: string; books: QuickCaptureBook[] } | null
  try {
    data = await withOwnerTx(async (tx) => {
      const [settings] = await tx<
        { timezone: string }[]
      >`select timezone from public.owner_settings`
      const tz = settings?.timezone
      if (!tz || !isValidTimeZone(tz)) return null
      const today = localDateInZone(new Date(), tz)
      const books = await listBookOptions(tx, { statuses: ['reading', 'paused', 'want'] })
      return { today, tomorrow: addLocalDays(today, 1), tz, books }
    })
  } catch (error) {
    unstable_rethrow(error)
    console.error('[home] could not load quick capture', {
      name: error instanceof Error ? error.name : typeof error,
    })
    return (
      <Frame>
        <p role="alert" className="text-sm text-danger">
          Quick capture could not be loaded right now. Reload to try again.
        </p>
      </Frame>
    )
  }
  if (!data) {
    return (
      <Frame>
        <p role="alert" className="text-sm text-danger">
          Your saved timezone can&rsquo;t be used here, so due dates can&rsquo;t be entered. Choose
          your timezone again in Settings.
        </p>
      </Frame>
    )
  }
  return (
    <Frame>
      <QuickCaptureTabs
        today={data.today}
        tomorrow={data.tomorrow}
        tz={data.tz}
        books={data.books}
      />
    </Frame>
  )
}

/** Placeholder while quick capture loads (same frame, so nothing jumps). */
export function QuickCaptureSkeleton() {
  return (
    <Frame>
      <div aria-busy="true" className="space-y-3">
        <div className="h-11 animate-pulse rounded-xl bg-surface-muted" />
        <div className="h-11 animate-pulse rounded-xl bg-surface-muted" />
      </div>
    </Frame>
  )
}
