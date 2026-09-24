import { SettingsSubpageHeader } from '@/components/settings/settings-list'
import { Card } from '@/components/ui/card'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Data and privacy' }

/** Retention defaults from the product brief (§7). Shown as text; enforcement jobs come later. */
const RETENTION: { what: string; how: string }[] = [
  { what: 'Raw imported email and chat text', how: 'Deleted after 30 days.' },
  {
    what: 'Summaries made from imports, with their source links',
    how: 'Kept until you delete them.',
  },
  { what: 'Notes, journal entries and accepted tasks', how: 'Kept until you delete them.' },
  {
    what: 'Voice recordings',
    how: 'Deleted once the transcription is saved. A failed recording is kept privately for up to 7 days so you can retry, download or delete it.',
  },
  {
    what: 'Disconnecting an account',
    how: 'Stops its jobs, revokes and deletes its tokens, and removes its imported data and summaries. Tasks and notes you accepted stay, marked as source removed. Pausing keeps everything.',
  },
  { what: 'Spotify', how: 'All Spotify data is deleted when you disconnect it.' },
  {
    what: 'This device',
    how: 'Caches only the app itself and an offline page, never your inbox, bank or journal data. Signing out clears it.',
  },
]

export default async function DataPage() {
  await requireOwner()
  return (
    <>
      <SettingsSubpageHeader
        title="Data and privacy"
        subtitle="What is kept, for how long, and how to take it with you."
      />
      <Card aria-labelledby="retention-title" className="mb-4">
        <h2 id="retention-title" className="text-[15px] font-semibold text-ink">
          Retention defaults
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          These are the rules the app is built to follow. The automatic clean-up jobs that enforce
          them are not running yet.
        </p>
        <dl className="mt-3 divide-y divide-line text-sm">
          {RETENTION.map((row) => (
            <div key={row.what} className="py-2.5 sm:grid sm:grid-cols-[14rem_1fr] sm:gap-4">
              <dt className="font-medium text-ink">{row.what}</dt>
              <dd className="mt-0.5 text-ink-muted sm:mt-0">{row.how}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <PlannedSection milestone="Milestone 4">
        <p className="text-ink">Export and deletion</p>
        <p>
          Export everything as JSON, with notes and journals also as Markdown, and delete data by
          source or all at once (including linked summaries, search entries and queued jobs). Both
          are verified, together with a database restore, before the private release.
        </p>
        <p>
          The database is backed up daily by Supabase. Uploaded files are not part of those backups,
          so they will get their own export path.
        </p>
      </PlannedSection>
    </>
  )
}
