/**
 * /projects/attach?url=<conversation url>
 *
 * Opened by the Chrome helper's "Track this conversation" button. Selecting a
 * conversation needs the owner's session (the helper's token cannot select), and
 * a GET never changes anything: the owner confirms with one click. The URL is
 * validated strictly and is never used as a redirect target.
 */
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { CAPTURE_PROVIDER_LABELS, captureParseConversationUrl } from '@personal-home/core'
import { PageHeader } from '@/components/shell/app-shell'
import { Card, CardHeader } from '@/components/ui/card'
import { CaptureStatePill } from '@/components/capture/conversation-list'
import { AttachConversationForm } from '@/components/projects/attach-conversation-form'
import { loadProjectsPage } from '@/lib/capture/data'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Collect a conversation' }

export default async function AttachPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireOwner()
  const params = await searchParams
  const raw = typeof params.url === 'string' ? params.url : ''
  const ref = raw ? captureParseConversationUrl(raw) : null
  const { projects, conversations } = await loadProjectsPage(session)
  const existing = ref
    ? conversations.find((c) => c.provider === ref.provider && c.externalId === ref.externalId)
    : undefined
  const options = projects
    .filter((p) => p.status !== 'done' || p.id === existing?.projectId)
    .map((p) => ({ id: p.id, name: p.name }))

  return (
    <>
      <Link
        href="/projects"
        className="mb-2 inline-flex min-h-11 items-center gap-1 text-sm text-ink-muted hover:text-ink sm:min-h-0"
      >
        <ChevronLeft aria-hidden className="size-4" />
        Projects
      </Link>
      <PageHeader title="Collect a conversation" />

      {ref ? (
        <Card aria-labelledby="attach-heading">
          <CardHeader
            title={`${CAPTURE_PROVIDER_LABELS[ref.provider]} conversation`}
            id="attach-heading"
          />
          <p className="break-all font-mono text-[13px] text-ink-muted">{ref.canonicalUrl}</p>
          {existing ? (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
              Already selected
              {existing.projectName ? ` in ${existing.projectName}` : ''}:
              <CaptureStatePill state={existing.captureState} />
            </p>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">
              The helper will collect the text Chrome renders while this conversation is open.
              Nothing is collected until you confirm.
            </p>
          )}
          <div className="mt-4">
            <AttachConversationForm
              projects={options}
              fixedUrl={ref.canonicalUrl}
              defaultProjectId={existing?.projectId ?? null}
              submitLabel={
                existing
                  ? existing.captureState === 'active'
                    ? 'Save project'
                    : 'Save and resume collecting'
                  : 'Start collecting'
              }
            />
          </div>
        </Card>
      ) : (
        <Card aria-labelledby="attach-heading">
          <CardHeader title="Paste a conversation link" id="attach-heading" />
          {raw ? (
            <p className="mb-3 text-sm text-danger" role="alert">
              That link is not a ChatGPT or Claude conversation that can be collected. Shared links,
              temporary chats and other pages are not supported.
            </p>
          ) : null}
          <AttachConversationForm projects={options} />
        </Card>
      )}
    </>
  )
}
