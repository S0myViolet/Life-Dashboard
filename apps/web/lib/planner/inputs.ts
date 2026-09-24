/**
 * Boundary validation for planner form posts (server actions). Pure, so it is unit-tested.
 */
import { CalendarDateSchema, WallClockTimeSchema } from '@personal-home/core'
import { z } from 'zod'

export const PLAN_BLOCK_INTENTS = [
  'accept',
  'pin',
  'unpin',
  'dismiss',
  'restore',
  'done',
  'up',
  'down',
  'edit',
] as const
export type PlanBlockIntent = (typeof PLAN_BLOCK_INTENTS)[number]

export const PlanBlockFormSchema = z
  .object({
    blockId: z.uuid({ message: 'Unknown plan item.' }),
    intent: z.enum(PLAN_BLOCK_INTENTS, { message: 'Unknown action.' }),
    startTime: z
      .union([WallClockTimeSchema, z.literal('')], { message: 'Enter a start time as HH:MM.' })
      .optional()
      .transform((v) => (v ? v : null)),
    minutes: z
      .union([z.literal(''), z.coerce.number({ message: 'Enter the duration in minutes.' })])
      .optional()
      .transform((v) => (v === '' || v === undefined ? undefined : v))
      .pipe(
        z
          .number()
          .int({ message: 'Use whole minutes.' })
          .min(5, { message: 'Duration must be at least 5 minutes.' })
          .max(720, { message: 'Duration must be 12 hours or less.' })
          .optional(),
      ),
  })
  .refine((v) => v.intent !== 'edit' || v.minutes !== undefined, {
    message: 'Enter the duration in minutes.',
    path: ['minutes'],
  })
export type PlanBlockForm = z.infer<typeof PlanBlockFormSchema>

export const PlanDayFormSchema = z.object({
  localDate: CalendarDateSchema,
})

const FIELDS = ['blockId', 'intent', 'startTime', 'minutes', 'localDate'] as const

/** FormData → plain object of the known text fields (files and unknown keys are ignored). */
export function planFormFields(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of FIELDS) {
    const v = formData.get(key)
    if (typeof v === 'string') out[key] = v.trim().slice(0, 100)
  }
  return out
}

export type PlanParseResult<T> = { ok: true; data: T } | { ok: false; message: string }

export function parsePlanForm<S extends z.ZodType>(
  schema: S,
  formData: FormData,
): PlanParseResult<z.infer<S>> {
  const parsed = schema.safeParse(planFormFields(formData))
  if (parsed.success) return { ok: true, data: parsed.data }
  return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' }
}
