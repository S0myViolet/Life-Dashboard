import { PROJECT_KIND_LABELS, PROJECT_STATUS_LABELS } from '@personal-home/core'
import { PageHeader } from '@/components/shell/app-shell'
import { ButtonLink } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PlannedSection } from '@/components/ui/planned-section'
import { Pill } from '@/components/ui/status-pill'
import { CaptureConversationList } from '@/components/capture/conversation-list'
import { AttachConversationForm } from '@/components/projects/attach-conversation-form'
import { CreateProjectForm } from '@/components/projects/create-project-form'
import { loadProjectsPage } from '@/lib/capture/data'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Projects' }

export default async function ProjectsPage() {
  const session = await requireOwner()
  const { projects, conversations, timezone } = await loadProjectsPage(session)
  const now = new Date()
  const unassigned = conversations.filter((c) => c.projectId === null)

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Work and personal projects with their linked ChatGPT and Claude conversations."
        actions={<ButtonLink href="/settings/chrome-helper">Chrome helper</ButtonLink>}
      />

      <div className="space-y-4">
        {projects.length === 0 ? (
          <Card>
            <EmptyState title="No projects yet">
              Create your first project below, then attach the conversations that belong to it.
            </EmptyState>
          </Card>
        ) : (
          projects.map((p) => {
            const linked = conversations.filter((c) => c.projectId === p.id)
            return (
              <Card key={p.id} as="article" aria-labelledby={`project-${p.id}`}>
                <CardHeader
                  title={p.name}
                  id={`project-${p.id}`}
                  meta={
                    <span className="inline-flex gap-1">
                      <Pill>{PROJECT_KIND_LABELS[p.kind]}</Pill>
                      <Pill tone={p.status === 'active' ? 'positive' : 'neutral'}>
                        {PROJECT_STATUS_LABELS[p.status]}
                      </Pill>
                    </span>
                  }
                />
                {p.goal ? <p className="mb-2 text-sm text-ink-muted">{p.goal}</p> : null}
                <h3 className="mt-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
                  Linked conversations
                </h3>
                <CaptureConversationList
                  conversations={linked}
                  now={now}
                  timeZone={timezone}
                  compact
                  showProject={false}
                  emptyTitle="No linked conversations"
                  emptyBody="Attach a ChatGPT or Claude conversation below."
                />
              </Card>
            )
          })
        )}

        {unassigned.length > 0 ? (
          <Card aria-labelledby="unassigned-heading">
            <CardHeader title="Conversations without a project" id="unassigned-heading" />
            <CaptureConversationList
              conversations={unassigned}
              now={now}
              timeZone={timezone}
              compact
              showProject={false}
            />
          </Card>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <Card aria-labelledby="attach-heading">
            <CardHeader title="Attach a conversation" id="attach-heading" />
            <AttachConversationForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
          </Card>
          <Card aria-labelledby="new-project-heading">
            <CardHeader title="New project" id="new-project-heading" />
            <CreateProjectForm />
          </Card>
        </div>

        <PlannedSection milestone="Milestone 2">
          <p>
            Notes, tasks, recent progress, open questions and next-action suggestions for each
            project, built from the collected conversations. Suggestions stay separate from your
            tasks until you accept them.
          </p>
        </PlannedSection>
      </div>
    </>
  )
}
