/**
 * Says plainly when labelled demo rows (titles starting with "[demo]", from
 * scripts/seed-demo.mjs) are present, so they are never mistaken for the owner's own data.
 * The seed script only writes to a local database; if demo rows ever show up in a deployed
 * (real-account) app, the notice turns into a warning.
 */
import { DataStatePill } from '@/components/ui/status-pill'
import { loadDemoPresence } from './data'

export async function DemoNotice() {
  const present = await loadDemoPresence()
  if (!present) return null
  const deployed = Boolean(process.env.VERCEL)
  return (
    <section
      aria-label="Demo data"
      data-testid="demo-notice"
      className={`mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-sm ${
        deployed
          ? 'border-danger/30 bg-danger-soft text-danger'
          : 'border-tentative/20 bg-tentative-soft text-ink'
      }`}
    >
      <DataStatePill state="demo" />
      <p className="min-w-0 flex-1 basis-60">
        {deployed
          ? 'Demo rows (starting with “[demo]”) were found in this account. They are examples, not your data; remove them with the seed script’s --remove option.'
          : 'Rows starting with “[demo]” are labelled examples, not your own data. Remove them with node scripts/seed-demo.mjs --remove.'}
      </p>
    </section>
  )
}
