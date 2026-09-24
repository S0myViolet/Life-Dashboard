'use server'

/**
 * Learning server actions. Server actions are public POST endpoints: each one
 * authenticates itself (withOwnerTx → requireOwner), validates every argument
 * (including bound ids) and runs in an RLS-scoped owner transaction. Return values are
 * shaped for the UI, never raw rows. Failures are logged by kind only — never the
 * submitted text.
 *
 * `logReading` is the object-argument entry point for Home's quick capture.
 */
import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { z } from 'zod'
import {
  BookInputSchema,
  BookStatusSchema,
  LearningGoalInputSchema,
  LearningGoalStatusSchema,
  PracticeHabitInputSchema,
  ReadingLogInputSchema,
  type BookStatus,
  type ReadingLogInput,
} from '@personal-home/core'
import {
  createBook,
  createLearningGoal,
  createPracticeHabit,
  deleteBook,
  deleteLearningGoal,
  deleteReadingLog,
  recordReadingLog,
  setBookStatus,
  setLearningGoalStatus,
  updateBook,
  updateLearningGoal,
  type Tx,
} from '@personal-home/db'
import { withOwnerTx } from '@/lib/server/session'
import {
  formError,
  formMultiline,
  formNumber,
  formNumberList,
  formText,
  zodFieldErrors,
  type FormActionState,
} from '@/components/learning/form-state'
import { progressHeadline } from '@/components/learning/format'
import { ownerToday } from '@/components/learning/owner-today'

const IdSchema = z.uuid()
const SAVE_FAILED = 'Could not save right now. Please try again.'

function logFailure(action: string, error: unknown) {
  const code = (error as { code?: unknown })?.code
  console.error(`learning action failed: ${action}`, {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === 'string' ? code : undefined,
  })
}

function revalidateLearning(bookId?: string | null) {
  revalidatePath('/learning')
  if (bookId) revalidatePath(`/learning/books/${bookId}`)
  // Home shows reading and goals in its previews and quick capture.
  revalidatePath('/')
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

function bookFromForm(fd: FormData) {
  const numberErrors: Record<string, string> = {}
  const raw = {
    title: formText(fd, 'title') ?? '',
    author: formText(fd, 'author'),
    totalPages: formNumber(fd, 'totalPages', numberErrors),
    status: formText(fd, 'status') ?? 'want',
    startedOn: formText(fd, 'startedOn'),
    finishedOn: formText(fd, 'finishedOn'),
  }
  const parsed = BookInputSchema.safeParse(raw)
  if (!parsed.success || Object.keys(numberErrors).length > 0) {
    const fieldErrors = {
      ...(parsed.success ? {} : zodFieldErrors(parsed.error)),
      ...numberErrors,
    }
    return { ok: false, fieldErrors } as const
  }
  return { ok: true, value: parsed.data } as const
}

export async function createBookAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const input = bookFromForm(formData)
  if (!input.ok) return formError('Check the highlighted fields.', input.fieldErrors)
  try {
    const book = await withOwnerTx(async (tx) => {
      const { today } = await ownerToday(tx)
      return createBook(tx, input.value, today)
    })
    revalidateLearning()
    return { status: 'saved', message: `Added “${book.title}”.` }
  } catch (error) {
    unstable_rethrow(error)
    logFailure('createBook', error)
    return formError(SAVE_FAILED)
  }
}

export async function updateBookAction(
  bookId: string,
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const id = IdSchema.safeParse(bookId)
  if (!id.success) return formError('That book could not be found.')
  const input = bookFromForm(formData)
  if (!input.ok) return formError('Check the highlighted fields.', input.fieldErrors)
  try {
    const book = await withOwnerTx(async (tx) => {
      const { today } = await ownerToday(tx)
      return updateBook(tx, id.data, input.value, today)
    })
    if (!book) return formError('That book could not be found.')
    revalidateLearning(book.id)
    return { status: 'saved', message: 'Saved.' }
  } catch (error) {
    unstable_rethrow(error)
    logFailure('updateBook', error)
    return formError(SAVE_FAILED)
  }
}

/** Form action for the status buttons (Start, Pause, Finish, Want to read). */
export async function setBookStatusAction(bookId: string, status: BookStatus): Promise<void> {
  const id = IdSchema.parse(bookId)
  const next = BookStatusSchema.parse(status)
  await withOwnerTx(async (tx) => {
    const { today } = await ownerToday(tx)
    return setBookStatus(tx, id, next, today)
  })
  revalidateLearning(id)
}

export async function deleteBookAction(bookId: string): Promise<void> {
  const id = IdSchema.parse(bookId)
  await withOwnerTx((tx) => deleteBook(tx, id))
  revalidateLearning()
  redirect('/learning')
}

// ---------------------------------------------------------------------------
// Reading logs
// ---------------------------------------------------------------------------

export type LogReadingResult =
  | {
      ok: true
      bookId: string
      bookTitle: string
      /** e.g. "Page 80 of 320 · 25%". */
      progress: string
      /** Set when logging started or resumed the book. */
      statusChangedFrom: BookStatus | null
    }
  | { ok: false; error: string; fieldErrors?: Partial<Record<string, string>> }

async function saveReadingLog(input: ReadingLogInput): Promise<LogReadingResult> {
  const parsed = ReadingLogInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Enter a page, pages read, a percentage or minutes.',
      fieldErrors: zodFieldErrors(parsed.error),
    }
  }
  try {
    const result = await withOwnerTx(async (tx: Tx) => {
      const { today } = await ownerToday(tx)
      return recordReadingLog(tx, parsed.data, today)
    })
    if (!result.ok) {
      return result.reason === 'not_found'
        ? { ok: false, error: 'That book could not be found.' }
        : { ok: false, error: result.message, fieldErrors: { [result.field]: result.message } }
    }
    revalidateLearning(result.value.book.id)
    return {
      ok: true,
      bookId: result.value.book.id,
      bookTitle: result.value.book.title,
      progress: progressHeadline(result.value.progress),
      statusChangedFrom: result.value.statusChangedFrom,
    }
  } catch (error) {
    unstable_rethrow(error)
    logFailure('logReading', error)
    return { ok: false, error: SAVE_FAILED }
  }
}

/**
 * Quick "log reading" for Home: `logReading({ bookId, pageReached | pagesRead | percent,
 * minutes?, note?, localDate? })`. Any one measure is enough; a page reached and a
 * percentage cannot both be given. `localDate` defaults to the owner's today.
 */
export async function logReading(input: ReadingLogInput): Promise<LogReadingResult> {
  return saveReadingLog(input)
}

const MEASURES = ['page', 'pages', 'percent'] as const

/** The book page's log form: one measure chosen with radio buttons, plus optional extras. */
export async function logReadingAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const numberErrors: Record<string, string> = {}
  const measure = MEASURES.find((m) => m === formText(formData, 'measure')) ?? 'page'
  const amount = formNumber(formData, 'amount', numberErrors)
  const minutes = formNumber(formData, 'minutes', numberErrors)
  if (Object.keys(numberErrors).length > 0) {
    return formError('Check the highlighted fields.', numberErrors)
  }
  const result = await saveReadingLog({
    bookId: formText(formData, 'bookId') ?? '',
    pageReached: measure === 'page' ? amount : null,
    pagesRead: measure === 'pages' ? amount : null,
    percent: measure === 'percent' ? amount : null,
    minutes,
    note: formMultiline(formData, 'note'),
    localDate: formText(formData, 'localDate') ?? undefined,
  })
  if (!result.ok) {
    // The single "amount" box stands for whichever measure was chosen.
    const fe = result.fieldErrors ?? {}
    const amountError = fe.pageReached ?? fe.pagesRead ?? fe.percent
    const fieldErrors: Record<string, string> = {}
    if (amountError) fieldErrors.amount = amountError
    if (fe.minutes) fieldErrors.minutes = fe.minutes
    if (fe.note) fieldErrors.note = fe.note
    if (fe.localDate) fieldErrors.localDate = fe.localDate
    if (fe.bookId) return formError('That book could not be found.')
    return formError(result.error, fieldErrors)
  }
  const started = result.statusChangedFrom ? ' Marked as reading.' : ''
  return { status: 'saved', message: `Logged: ${result.progress}.${started}` }
}

export async function deleteReadingLogAction(logId: string): Promise<void> {
  const id = IdSchema.parse(logId)
  const deleted = await withOwnerTx((tx) => deleteReadingLog(tx, id))
  revalidateLearning(deleted?.bookId)
}

// ---------------------------------------------------------------------------
// Learning goals
// ---------------------------------------------------------------------------

async function saveGoal(goalId: string | null, formData: FormData): Promise<FormActionState> {
  const numberErrors: Record<string, string> = {}
  const habitChoice = formText(formData, 'habitId')
  const title = formText(formData, 'title') ?? ''
  const raw = {
    title,
    details: formMultiline(formData, 'details'),
    targetDate: formText(formData, 'targetDate'),
    status: formText(formData, 'status') ?? 'active',
    habitId: habitChoice === 'new' ? null : habitChoice,
    bookId: formText(formData, 'bookId'),
    dailyMinutes: formNumber(formData, 'dailyMinutes', numberErrors),
  }
  const parsed = LearningGoalInputSchema.safeParse(raw)
  const fieldErrors: Record<string, string> = {
    ...(parsed.success ? {} : zodFieldErrors(parsed.error)),
    ...numberErrors,
  }
  let newHabit: z.output<typeof PracticeHabitInputSchema> | null = null
  if (habitChoice === 'new') {
    const habit = PracticeHabitInputSchema.safeParse({
      title: formText(formData, 'newHabitTitle') ?? title,
      weekdays: formNumberList(formData, 'newHabitWeekdays'),
    })
    if (habit.success) newHabit = habit.data
    else {
      const e = zodFieldErrors(habit.error)
      if (e.title) fieldErrors.newHabitTitle = e.title
      if (e.weekdays) fieldErrors.newHabitWeekdays = e.weekdays
    }
  }
  if (!parsed.success || Object.keys(fieldErrors).length > 0) {
    return formError('Check the highlighted fields.', fieldErrors)
  }

  try {
    const result = await withOwnerTx(async (tx) => {
      const fields = { ...parsed.data }
      if (newHabit) fields.habitId = (await createPracticeHabit(tx, newHabit)).id
      return goalId ? updateLearningGoal(tx, goalId, fields) : createLearningGoal(tx, fields)
    })
    if (!result.ok) {
      return result.reason === 'not_found'
        ? formError('That goal could not be found.')
        : formError(result.message, { [result.field]: result.message })
    }
    revalidateLearning()
    revalidatePath(`/learning/goals/${result.value.id}`)
    return {
      status: 'saved',
      message: goalId ? 'Saved.' : `Added “${result.value.title}”.`,
      values: { habitId: result.value.habitId },
    }
  } catch (error) {
    unstable_rethrow(error)
    logFailure(goalId ? 'updateGoal' : 'createGoal', error)
    return formError(SAVE_FAILED)
  }
}

export async function createGoalAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  return saveGoal(null, formData)
}

export async function updateGoalAction(
  goalId: string,
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const id = IdSchema.safeParse(goalId)
  if (!id.success) return formError('That goal could not be found.')
  return saveGoal(id.data, formData)
}

export async function setGoalStatusAction(goalId: string, status: string): Promise<void> {
  const id = IdSchema.parse(goalId)
  const next = LearningGoalStatusSchema.parse(status)
  await withOwnerTx((tx) => setLearningGoalStatus(tx, id, next))
  revalidateLearning()
  revalidatePath(`/learning/goals/${id}`)
}

export async function deleteGoalAction(goalId: string): Promise<void> {
  const id = IdSchema.parse(goalId)
  await withOwnerTx((tx) => deleteLearningGoal(tx, id))
  revalidateLearning()
  redirect('/learning')
}
