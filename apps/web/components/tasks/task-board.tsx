'use client'

/**
 * Plan › Tasks: inline add, the task list grouped Overdue / Today / Upcoming /
 * No date / Done (collapsed), the edit sheet, and complete-with-undo.
 * Completing and reopening update the list optimistically; the server's
 * re-render then replaces the optimistic state.
 */
import { useCallback, useEffect, useMemo, useOptimistic, useState, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { TASK_DUE_GROUP_LABELS, type TaskDueGroup } from '@personal-home/core'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { setTaskStatusAction } from '@/lib/tasks/actions'
import type { TaskBoardData, TaskView } from '@/lib/tasks/view-types'
import { TaskAddForm } from './task-add-form'
import { TaskEditSheet } from './task-edit-sheet'
import { TaskRow } from './task-row'
import { Toast, useToast } from './ui'

type OptimisticChange =
  { type: 'status'; id: string; status: 'open' | 'done' } | { type: 'delete'; id: string }

function reduce(tasks: TaskView[], change: OptimisticChange): TaskView[] {
  if (change.type === 'delete') return tasks.filter((t) => t.id !== change.id)
  return tasks.map((t) => {
    if (t.id !== change.id) return t
    return change.status === 'done'
      ? { ...t, status: 'done', group: 'done', closedLabel: 'Done just now' }
      : { ...t, status: 'open', group: t.openGroup, closedLabel: null }
  })
}

/** Where focus goes when a row leaves its list: the next row, else the previous, else the heading. */
function focusAfterLeaving(button: HTMLElement) {
  const li = button.closest('li')
  const section = button.closest('section, details')
  const sibling =
    li?.nextElementSibling?.querySelector<HTMLElement>('[data-task-toggle]') ??
    li?.previousElementSibling?.querySelector<HTMLElement>('[data-task-toggle]') ??
    section?.querySelector<HTMLElement>('h2, summary') ??
    document.getElementById('add-title')
  requestAnimationFrame(() => {
    if (sibling?.isConnected) {
      if (sibling.tagName === 'H2' && !sibling.hasAttribute('tabindex')) {
        sibling.setAttribute('tabindex', '-1')
      }
      sibling.focus()
    } else {
      document.getElementById('add-title')?.focus()
    }
  })
}

export function TaskBoard({
  data,
  initialEditId,
}: {
  data: TaskBoardData
  initialEditId: string | null
}) {
  const [tasks, applyChange] = useOptimistic(data.tasks, reduce)
  const [, startTransition] = useTransition()
  const { toast, show, dismiss, timeoutMs } = useToast()
  const [editingId, setEditingId] = useState<string | null>(initialEditId)
  const router = useRouter()
  const pathname = usePathname()

  const editing = editingId ? (data.tasks.find((t) => t.id === editingId) ?? null) : null

  // A ?task=<id> link to a task that is gone: say so rather than silently showing nothing.
  useEffect(() => {
    if (initialEditId && !data.tasks.some((t) => t.id === initialEditId)) {
      show({
        message: 'That task no longer exists or is older than the list shows.',
        tone: 'error',
      })
      router.replace(pathname, { scroll: false })
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const closeEditor = useCallback(() => {
    setEditingId(null)
    if (initialEditId) router.replace(pathname, { scroll: false })
  }, [initialEditId, pathname, router])

  function setStatus(task: TaskView, next: 'open' | 'done') {
    startTransition(async () => {
      applyChange({ type: 'status', id: task.id, status: next })
      const r = await setTaskStatusAction(task.id, next === 'done' ? 'complete' : 'reopen')
      if (!r.ok) {
        show({ message: r.message, tone: 'error' })
      } else if (next === 'done') {
        show({
          message: `Completed “${task.title}”.`,
          action: { label: 'Undo', run: () => setStatus(task, 'open') },
        })
      } else {
        show({ message: `Reopened “${task.title}”.` })
      }
    })
  }

  function onToggle(task: TaskView, button: HTMLButtonElement) {
    focusAfterLeaving(button)
    setStatus(task, task.status === 'open' ? 'done' : 'open')
  }

  const groups = useMemo(() => {
    const g: Record<TaskDueGroup, TaskView[]> = {
      overdue: [],
      today: [],
      upcoming: [],
      no_date: [],
      done: [],
    }
    for (const t of tasks) g[t.group].push(t)
    return g
  }, [tasks])
  const openCount = tasks.length - groups.done.length

  const group = (key: Exclude<TaskDueGroup, 'done'>, emptyText?: string) => {
    const list = groups[key]
    if (list.length === 0 && !emptyText) return null
    return (
      <Card as="section" aria-labelledby={`group-${key}`} key={key}>
        <h2
          id={`group-${key}`}
          className={`mb-1 flex items-baseline gap-2 text-[15px] font-semibold tracking-tight ${
            key === 'overdue' ? 'text-danger' : 'text-ink'
          }`}
        >
          {TASK_DUE_GROUP_LABELS[key]}
          <span className="text-sm font-normal text-ink-faint">
            {list.length}
            <span className="sr-only"> {list.length === 1 ? 'task' : 'tasks'}</span>
          </span>
        </h2>
        {list.length === 0 ? (
          <p className="py-2 text-sm text-ink-muted">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((t) => (
              <TaskRow key={t.id} task={t} onToggle={onToggle} onEdit={(x) => setEditingId(x.id)} />
            ))}
          </ul>
        )}
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <TaskAddForm
        projects={data.projects}
        today={data.today}
        tomorrow={data.tomorrow}
        tz={data.tz}
      />

      {openCount === 0 ? (
        <EmptyState title="No open tasks">
          Tasks you add appear here, grouped by when they are due.
        </EmptyState>
      ) : (
        <>
          {group('overdue')}
          {group('today', 'Nothing due today.')}
          {group('upcoming')}
          {group('no_date')}
        </>
      )}
      {data.openTruncated ? (
        <p className="text-sm text-caution">
          Showing the first {data.tasks.length - groups.done.length} open tasks.
        </p>
      ) : null}

      {groups.done.length > 0 ? (
        <Card as="div">
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg text-[15px] font-semibold tracking-tight text-ink">
              <ChevronRight
                aria-hidden
                className="size-4 text-ink-faint transition-transform group-open:rotate-90"
              />
              <h2 className="inline">
                Done{' '}
                <span className="text-sm font-normal text-ink-faint">{groups.done.length}</span>
              </h2>
            </summary>
            <ul className="mt-1 divide-y divide-line">
              {groups.done.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onToggle={onToggle}
                  onEdit={(x) => setEditingId(x.id)}
                />
              ))}
            </ul>
            {data.closedHasMore ? (
              <p className="mt-2 text-sm text-ink-muted">
                Showing the most recent {groups.done.length}.
              </p>
            ) : null}
          </details>
        </Card>
      ) : null}

      <TaskEditSheet
        task={editing}
        onClose={closeEditor}
        onSaved={(message) => {
          closeEditor()
          show({ message })
        }}
        onDeleted={(task) => {
          startTransition(() => applyChange({ type: 'delete', id: task.id }))
          closeEditor()
          show({ message: `Deleted “${task.title}”.` })
        }}
        onDeleteFailed={(message) => show({ message, tone: 'error' })}
        projects={data.projects}
        today={data.today}
        tomorrow={data.tomorrow}
        tz={data.tz}
      />
      <Toast toast={toast} dismiss={dismiss} timeoutMs={timeoutMs} />
    </div>
  )
}
