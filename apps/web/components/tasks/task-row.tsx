'use client'

import { Bell, CalendarClock, Check, FolderKanban, Scissors, Timer } from 'lucide-react'
import { Pill } from '@/components/ui/status-pill'
import type { TaskView } from '@/lib/tasks/view-types'

export function TaskRow({
  task,
  onToggle,
  onEdit,
}: {
  task: TaskView
  onToggle: (task: TaskView, button: HTMLButtonElement) => void
  onEdit: (task: TaskView) => void
}) {
  const closed = task.status !== 'open'
  const overdue = task.group === 'overdue'
  return (
    <li id={`task-${task.id}`} className="flex items-start gap-1 py-1" data-task-id={task.id}>
      <button
        type="button"
        data-task-toggle
        aria-label={closed ? `Reopen ${task.title}` : `Complete ${task.title}`}
        onClick={(e) => onToggle(task, e.currentTarget)}
        className="group inline-flex size-11 shrink-0 items-center justify-center rounded-full"
      >
        <span
          aria-hidden
          className={`inline-flex size-6 items-center justify-center rounded-full border-2 transition-colors ${
            closed
              ? 'border-positive bg-positive text-white'
              : 'border-line-strong text-transparent group-hover:border-accent group-hover:text-accent'
          }`}
        >
          <Check className="size-4" strokeWidth={3} />
        </span>
      </button>
      <div className="min-w-0 flex-1 py-2.5">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={`Edit ${task.title}`}
          onClick={() => onEdit(task)}
          className={`block w-full break-words rounded text-left text-[15px] leading-snug hover:text-accent-strong ${
            closed ? 'text-ink-muted line-through' : 'text-ink'
          }`}
        >
          {task.title}
        </button>
        <TaskMeta task={task} overdue={overdue} />
      </div>
    </li>
  )
}

function TaskMeta({ task, overdue }: { task: TaskView; overdue: boolean }) {
  const items: React.ReactNode[] = []
  if (task.closedLabel) {
    items.push(<span key="closed">{task.closedLabel}</span>)
  } else if (task.dueLabel) {
    items.push(
      <span
        key="due"
        className={`inline-flex items-center gap-1 ${overdue ? 'font-medium text-danger' : ''}`}
      >
        <CalendarClock aria-hidden className="size-3.5" />
        <span className="sr-only">{overdue ? 'Overdue, was due' : 'Due'}</span>
        {task.dueLabel}
      </span>,
    )
  }
  if (task.priority) {
    items.push(
      <Pill
        key="priority"
        tone={task.priority === 1 ? 'danger' : task.priority === 2 ? 'caution' : 'neutral'}
      >
        <span className="sr-only">Priority </span>P{task.priority}
      </Pill>,
    )
  }
  if (task.durationLabel) {
    items.push(
      <span key="duration" className="inline-flex items-center gap-1">
        <Timer aria-hidden className="size-3.5" />
        <span className="sr-only">Takes about</span>
        {task.durationLabel}
      </span>,
    )
  }
  if (task.splittable) {
    items.push(
      <span key="split" className="inline-flex items-center gap-1">
        <Scissors aria-hidden className="size-3.5" />
        Splittable
      </span>,
    )
  }
  if (task.projectId) {
    items.push(
      <span key="project" className="inline-flex items-center gap-1">
        <FolderKanban aria-hidden className="size-3.5" />
        <span className="sr-only">Project</span>
        {task.projectName ?? 'Project unavailable'}
      </span>,
    )
  }
  if (task.reminder && task.status === 'open') {
    items.push(
      <span key="reminder" className="inline-flex items-center gap-1">
        <Bell aria-hidden className="size-3.5" />
        <span className="sr-only">Reminder</span>
        {task.reminder.label}
      </span>,
    )
  }
  if (items.length === 0) return null
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
      {items}
    </p>
  )
}
