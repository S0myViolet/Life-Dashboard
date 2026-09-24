'use client'
/**
 * One plan block (or list item) with its owner actions. Works without JavaScript (plain forms
 * posting to server actions); with JavaScript, messages appear inline and keyboard focus stays
 * on "Earlier"/"Later" after a move so items can be reordered repeatedly from the keyboard.
 */
import { useActionState, useEffect, useId, useRef } from 'react'
import { ArrowDown, ArrowUp, Check, CircleCheck, Pin, PinOff, RotateCcw, X } from 'lucide-react'
import { Pill } from '@/components/ui/status-pill'
import { planBlockAction, type PlanActionState } from '@/lib/planner/actions'
import type { PlanBlockView } from '@/lib/planner/view'

const STATE_PILL: Record<
  PlanBlockView['state'],
  { label: string; tone: 'neutral' | 'accent' | 'positive' }
> = {
  suggested: { label: 'Suggested', tone: 'neutral' },
  accepted: { label: 'Accepted', tone: 'accent' },
  pinned: { label: 'Pinned', tone: 'accent' },
  done: { label: 'Done', tone: 'positive' },
  dismissed: { label: 'Dismissed', tone: 'neutral' },
}

const actionButton =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9'
const primaryButton =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9'
const iconButton =
  'inline-flex size-11 items-center justify-center rounded-lg border border-line-strong bg-surface text-ink hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40 sm:size-9'

export function PlanBlock({
  block,
  showTime = true,
}: {
  block: PlanBlockView
  showTime?: boolean
}) {
  const [result, formAction, pending] = useActionState<PlanActionState | null, FormData>(
    planBlockAction,
    null,
  )
  const upRef = useRef<HTMLButtonElement>(null)
  const downRef = useRef<HTMLButtonElement>(null)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const ids = useId()

  useEffect(() => {
    if (!result?.ok) return
    if (result.intent === 'up') (upRef.current?.disabled ? downRef : upRef).current?.focus()
    if (result.intent === 'down') (downRef.current?.disabled ? upRef : downRef).current?.focus()
    if (result.intent === 'edit' && detailsRef.current) detailsRef.current.open = false
  }, [result])

  const pill = STATE_PILL[block.state]
  const muted = block.state === 'done' || block.state === 'dismissed'
  const tone = block.tentative
    ? 'border-tentative/30 bg-tentative-soft'
    : block.state === 'accepted' || block.state === 'pinned'
      ? 'border-accent/40 bg-accent-soft/40'
      : 'border-line bg-surface'

  const meta = [
    block.kindLabel,
    block.durationLabel,
    block.splitLabel ? `Part ${block.splitLabel}` : null,
  ].filter(Boolean)

  return (
    <li
      data-testid="plan-block"
      data-block-id={block.id}
      data-state={block.state}
      data-start={block.startIso ?? ''}
      data-title={block.title}
      className={`rounded-xl border px-3 py-3 sm:px-4 ${tone}`}
      aria-labelledby={`${ids}-title`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {showTime && block.timeLabel ? (
              <span className="font-mono text-sm tabular-nums text-ink-muted">
                {block.timeLabel}
              </span>
            ) : null}
            <span
              id={`${ids}-title`}
              className={`text-[15px] font-medium ${muted ? 'text-ink-muted line-through decoration-ink-faint' : 'text-ink'}`}
            >
              {block.title}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-ink-muted">{meta.join(' · ')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {block.priorityRank ? <Pill tone="accent">Priority {block.priorityRank}</Pill> : null}
          {block.tentative ? <Pill tone="tentative">Tentative</Pill> : null}
          {block.isNow && !muted ? <Pill tone="positive">Now</Pill> : null}
          <Pill tone={pill.tone}>
            {block.state === 'pinned' ? <Pin aria-hidden className="size-3" /> : null}
            {pill.label}
          </Pill>
        </div>
      </div>

      {block.tentative ? (
        <p className="mt-1 text-xs text-tentative">
          From an unconfirmed suggestion. Accept it only if you want it in today&apos;s plan.
        </p>
      ) : null}
      {block.note ? <p className="mt-1 text-xs text-caution">{block.note}</p> : null}
      {block.isPast && block.state === 'suggested' ? (
        <p className="mt-1 text-xs text-caution">
          This time has passed. Edit it or replan the day.
        </p>
      ) : null}
      {block.isPast && (block.state === 'accepted' || block.state === 'pinned') ? (
        <p className="mt-1 text-xs text-ink-muted">Time passed. Mark it done or move it later.</p>
      ) : null}
      {block.sourceStatus ? (
        <p className="mt-1 text-xs text-ink-muted">
          {block.sourceStatus === 'done' ? 'Completed in Tasks.' : 'Cancelled in Tasks.'}
        </p>
      ) : null}

      {hasActions(block) ? (
        <form action={formAction} className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <input type="hidden" name="blockId" value={block.id} />
          {block.can.accept ? (
            <button
              type="submit"
              name="intent"
              value="accept"
              className={primaryButton}
              disabled={pending}
              aria-label={`Accept “${block.title}”`}
            >
              <Check aria-hidden className="size-4" /> Accept
            </button>
          ) : null}
          {block.can.done ? (
            <button
              type="submit"
              name="intent"
              value="done"
              className={actionButton}
              disabled={pending}
              aria-label={`Mark “${block.title}” done`}
            >
              <CircleCheck aria-hidden className="size-4" /> Done
            </button>
          ) : null}
          {block.can.pin ? (
            <button
              type="submit"
              name="intent"
              value="pin"
              className={actionButton}
              disabled={pending}
              aria-label={`Pin “${block.title}”`}
            >
              <Pin aria-hidden className="size-4" /> Pin
            </button>
          ) : null}
          {block.can.unpin ? (
            <button
              type="submit"
              name="intent"
              value="unpin"
              className={actionButton}
              disabled={pending}
              aria-label={`Unpin “${block.title}”`}
            >
              <PinOff aria-hidden className="size-4" /> Unpin
            </button>
          ) : null}
          {block.can.moveUp || block.can.moveDown ? (
            <span className="inline-flex gap-1.5">
              <button
                ref={upRef}
                type="submit"
                name="intent"
                value="up"
                className={iconButton}
                disabled={pending || !block.can.moveUp}
                aria-label={`Move “${block.title}” earlier`}
                title="Move earlier"
              >
                <ArrowUp aria-hidden className="size-4" />
              </button>
              <button
                ref={downRef}
                type="submit"
                name="intent"
                value="down"
                className={iconButton}
                disabled={pending || !block.can.moveDown}
                aria-label={`Move “${block.title}” later`}
                title="Move later"
              >
                <ArrowDown aria-hidden className="size-4" />
              </button>
            </span>
          ) : null}
          {block.can.dismiss ? (
            <button
              type="submit"
              name="intent"
              value="dismiss"
              className={actionButton}
              disabled={pending}
              aria-label={`Dismiss “${block.title}”`}
            >
              <X aria-hidden className="size-4" /> Dismiss
            </button>
          ) : null}
          {block.can.restore ? (
            <button
              type="submit"
              name="intent"
              value="restore"
              className={actionButton}
              disabled={pending}
              aria-label={`Restore “${block.title}”`}
            >
              <RotateCcw aria-hidden className="size-4" /> Restore
            </button>
          ) : null}
        </form>
      ) : null}

      {block.can.edit ? (
        <details ref={detailsRef} className="mt-2 group">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-1 text-sm text-accent hover:text-accent-strong sm:min-h-9">
            Edit {block.startTime ? 'time or duration' : 'duration'}
          </summary>
          <form action={formAction} className="mt-2 flex flex-wrap items-end gap-3">
            <input type="hidden" name="blockId" value={block.id} />
            <input type="hidden" name="intent" value="edit" />
            {block.startTime ? (
              <label className="flex flex-col gap-1 text-xs text-ink-muted">
                Start
                <input
                  type="time"
                  name="startTime"
                  step={300}
                  defaultValue={block.startTime}
                  required
                  className="min-h-11 rounded-lg border border-line-strong bg-surface px-2 text-sm text-ink sm:min-h-9"
                />
              </label>
            ) : null}
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              Minutes
              <input
                type="number"
                name="minutes"
                min={5}
                max={720}
                step={5}
                inputMode="numeric"
                defaultValue={block.minutes}
                required
                className="min-h-11 w-24 rounded-lg border border-line-strong bg-surface px-2 text-sm text-ink sm:min-h-9"
              />
            </label>
            <button type="submit" className={primaryButton} disabled={pending}>
              Save
            </button>
          </form>
        </details>
      ) : null}

      <p aria-live="polite" className="mt-1 min-h-0 text-xs empty:hidden">
        {result?.message ? (
          <span className={result.ok ? 'text-positive' : 'text-danger'}>{result.message}</span>
        ) : null}
      </p>
    </li>
  )
}

function hasActions(b: PlanBlockView): boolean {
  const c = b.can
  return c.accept || c.done || c.pin || c.unpin || c.moveUp || c.moveDown || c.dismiss || c.restore
}
