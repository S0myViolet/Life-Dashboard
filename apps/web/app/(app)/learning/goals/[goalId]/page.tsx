import { notFound } from 'next/navigation'
import { z } from 'zod'
import { LEARNING_GOAL_STATUS_LABELS } from '@personal-home/core'
import { listBookOptions, listLearningGoals, listPracticeHabitOptions } from '@personal-home/db'
import { deleteGoalAction, setGoalStatusAction } from '@/app/(app)/learning/actions'
import { PageHeader } from '@/components/shell/app-shell'
import { ButtonLink, buttonClass } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { ConfirmDeleteButton } from '@/components/learning/form-kit'
import { GoalForm } from '@/components/learning/goal-form'
import { goalLines } from '@/components/learning/goals-section'
import { ownerToday } from '@/components/learning/owner-today'
import { requireOwner, withOwnerTx } from '@/lib/server/session'

export const metadata = { title: 'Learning goal' }

export default async function GoalPage({ params }: { params: Promise<{ goalId: string }> }) {
  await requireOwner()
  const { goalId } = await params
  if (!z.uuid().safeParse(goalId).success) notFound()
  const data = await withOwnerTx(async (tx) => {
    const { today } = await ownerToday(tx)
    const goals = await listLearningGoals(tx, today)
    const goal = goals.find((g) => g.id === goalId)
    if (!goal) return null
    return {
      goal,
      today,
      books: await listBookOptions(tx),
      habits: await listPracticeHabitOptions(tx),
    }
  })
  if (!data) notFound()
  const { goal, today, books, habits } = data
  const lines = goalLines(goal, today)
  const statusButtons =
    goal.status === 'active'
      ? [
          { status: 'done', label: 'Mark done' },
          { status: 'paused', label: 'Pause' },
        ]
      : [{ status: 'active', label: goal.status === 'done' ? 'Reopen' : 'Resume' }]

  return (
    <>
      <PageHeader
        title={goal.title}
        subtitle={LEARNING_GOAL_STATUS_LABELS[goal.status]}
        actions={<ButtonLink href="/learning">Learning</ButtonLink>}
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="min-w-0 space-y-4 lg:col-span-3">
          <Card aria-labelledby="goal-summary-title">
            <CardHeader id="goal-summary-title" title="Where it stands" />
            {lines.length ? (
              <ul className="space-y-1">
                {lines.map((line) => (
                  <li key={line} className="text-sm text-ink">
                    {line}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">
                No target date, book, minutes or habit yet — add one below to track it.
              </p>
            )}
            {goal.details ? (
              <p className="mt-3 whitespace-pre-wrap break-words text-sm text-ink-muted">
                {goal.details}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {statusButtons.map((b) => (
                <form key={b.status} action={setGoalStatusAction.bind(null, goal.id, b.status)}>
                  <button
                    type="submit"
                    className={buttonClass(b.status === 'done' ? 'primary' : 'secondary')}
                  >
                    {b.label}
                  </button>
                </form>
              ))}
            </div>
          </Card>
          <Card aria-labelledby="goal-edit-title">
            <CardHeader id="goal-edit-title" title="Edit goal" />
            <GoalForm
              goal={{
                id: goal.id,
                title: goal.title,
                details: goal.details,
                targetDate: goal.targetDate,
                status: goal.status,
                habitId: goal.habitId,
                bookId: goal.bookId,
                dailyMinutes: goal.dailyMinutes,
              }}
              books={books.map((b) => ({ id: b.id, title: b.title }))}
              habits={habits.map((h) => ({ id: h.id, title: h.title }))}
            />
          </Card>
        </div>
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card aria-labelledby="goal-remove-title">
            <CardHeader id="goal-remove-title" title="Remove" />
            <p className="mb-2 text-sm text-ink-muted">
              Deleting a goal keeps its book and practice habit.
            </p>
            <ConfirmDeleteButton
              action={deleteGoalAction.bind(null, goal.id)}
              label="Delete goal"
              confirmLabel="Delete"
              question={`Delete “${goal.title}”?`}
            />
          </Card>
        </div>
      </div>
    </>
  )
}
