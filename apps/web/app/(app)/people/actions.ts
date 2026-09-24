'use server'

/**
 * People server actions. Each one authenticates itself (withOwnerTx → requireOwner),
 * validates every argument (including bound ids) and runs in an RLS-scoped owner
 * transaction. Failures are logged by kind only — never names or notes.
 */
import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { z } from 'zod'
import {
  PersonDateInputSchema,
  PersonInputSchema,
  type PersonDateFields,
} from '@personal-home/core'
import {
  addPersonDate,
  createPerson,
  deletePerson,
  deletePersonDate,
  markCaughtUp,
  updatePerson,
} from '@personal-home/db'
import { withOwnerTx } from '@/lib/server/session'
import {
  formError,
  formMultiline,
  formNumber,
  formText,
  zodFieldErrors,
  type FormActionState,
} from '@/components/learning/form-state'
import { ownerToday } from '@/components/learning/owner-today'

const IdSchema = z.uuid()
const SAVE_FAILED = 'Could not save right now. Please try again.'

function logFailure(action: string, error: unknown) {
  const code = (error as { code?: unknown })?.code
  console.error(`people action failed: ${action}`, {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === 'string' ? code : undefined,
  })
}

function revalidatePeople(personId?: string | null) {
  revalidatePath('/people')
  if (personId) revalidatePath(`/people/${personId}`)
  // Home shows upcoming dates and due catch-ups.
  revalidatePath('/')
}

function personFromForm(fd: FormData, errors: Record<string, string>) {
  const cadence = formText(fd, 'catchUpEveryDays')
  const raw = {
    name: formText(fd, 'name') ?? '',
    relationship: formText(fd, 'relationship'),
    notes: formMultiline(fd, 'notes'),
    catchUpEveryDays: cadence == null ? null : formNumber(fd, 'catchUpEveryDays', errors),
    lastCaughtUpOn: formText(fd, 'lastCaughtUpOn'),
  }
  const parsed = PersonInputSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  // Keep an earlier "Enter a number" over the schema's message for the same field.
  for (const [key, message] of Object.entries(zodFieldErrors(parsed.error))) errors[key] ??= message
  return null
}

/** Month, day and optional year fields under a prefix (e.g. "birthday" → birthdayMonth). */
function dateFromForm(
  fd: FormData,
  prefix: string,
  label: string | null,
  errors: Record<string, string>,
  options: { optional: boolean },
): PersonDateFields | null {
  const field = (name: string) =>
    prefix ? `${prefix}${name[0]!.toUpperCase()}${name.slice(1)}` : name
  const month = formNumber(fd, field('month'), errors)
  const day = formNumber(fd, field('day'), errors)
  const year = formNumber(fd, field('year'), errors)
  const remind = formNumber(fd, field('remindDaysBefore'), errors)
  if (options.optional && month == null && day == null && year == null) return null
  if (month == null) errors[field('month')] ??= 'Pick a month'
  if (day == null) errors[field('day')] ??= 'Pick a day'
  if (month == null || day == null) return null
  const parsed = PersonDateInputSchema.safeParse({
    label: label ?? '',
    month,
    day,
    year,
    ...(remind == null ? {} : { remindDaysBefore: remind }),
  })
  if (!parsed.success) {
    for (const [key, message] of Object.entries(zodFieldErrors(parsed.error))) {
      errors[field(key)] ??= message
    }
    return null
  }
  return parsed.data
}

export async function createPersonAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const errors: Record<string, string> = {}
  const person = personFromForm(formData, errors)
  const birthday = dateFromForm(formData, 'birthday', 'Birthday', errors, { optional: true })
  if (!person || Object.keys(errors).length > 0) {
    return formError('Check the highlighted fields.', errors)
  }
  let personId: string
  try {
    const result = await withOwnerTx(async (tx) => {
      const { today } = await ownerToday(tx)
      const created = await createPerson(tx, person, today)
      if (created.ok && birthday) {
        const added = await addPersonDate(tx, created.value.id, birthday)
        if (!added.ok) throw new Error('birthday insert failed')
      }
      return created
    })
    if (!result.ok) {
      return result.reason === 'invalid'
        ? formError(result.message, { [result.field]: result.message })
        : formError(SAVE_FAILED)
    }
    personId = result.value.id
  } catch (error) {
    unstable_rethrow(error)
    logFailure('createPerson', error)
    return formError(SAVE_FAILED)
  }
  revalidatePeople(personId)
  redirect(`/people/${personId}`)
}

export async function updatePersonAction(
  personId: string,
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const id = IdSchema.safeParse(personId)
  if (!id.success) return formError('That person could not be found.')
  const errors: Record<string, string> = {}
  const person = personFromForm(formData, errors)
  if (!person || Object.keys(errors).length > 0) {
    return formError('Check the highlighted fields.', errors)
  }
  try {
    const result = await withOwnerTx(async (tx) => {
      const { today } = await ownerToday(tx)
      return updatePerson(tx, id.data, person, today)
    })
    if (!result.ok) {
      return result.reason === 'not_found'
        ? formError('That person could not be found.')
        : formError(result.message, { [result.field]: result.message })
    }
    revalidatePeople(id.data)
    return { status: 'saved', message: 'Saved.' }
  } catch (error) {
    unstable_rethrow(error)
    logFailure('updatePerson', error)
    return formError(SAVE_FAILED)
  }
}

export async function deletePersonAction(personId: string): Promise<void> {
  const id = IdSchema.parse(personId)
  await withOwnerTx((tx) => deletePerson(tx, id))
  revalidatePeople()
  redirect('/people')
}

/** "Caught up today": records the owner-local date. Idempotent. */
export async function markCaughtUpAction(personId: string): Promise<void> {
  const id = IdSchema.parse(personId)
  await withOwnerTx(async (tx) => {
    const { today } = await ownerToday(tx)
    return markCaughtUp(tx, id, today)
  })
  revalidatePeople(id)
}

export async function addPersonDateAction(
  personId: string,
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const id = IdSchema.safeParse(personId)
  if (!id.success) return formError('That person could not be found.')
  const errors: Record<string, string> = {}
  const label = formText(formData, 'label')
  if (!label) errors.label = 'Give the date a label'
  const date = dateFromForm(formData, '', label, errors, { optional: false })
  if (!date || Object.keys(errors).length > 0) {
    return formError('Check the highlighted fields.', errors)
  }
  try {
    const result = await withOwnerTx((tx) => addPersonDate(tx, id.data, date))
    if (!result.ok) return formError('That person could not be found.')
    revalidatePeople(id.data)
    return { status: 'saved', message: `Added ${result.value.label.toLowerCase()}.` }
  } catch (error) {
    unstable_rethrow(error)
    logFailure('addPersonDate', error)
    return formError(SAVE_FAILED)
  }
}

export async function deletePersonDateAction(dateId: string): Promise<void> {
  const id = IdSchema.parse(dateId)
  const deleted = await withOwnerTx((tx) => deletePersonDate(tx, id))
  revalidatePeople(deleted?.personId)
}
