/**
 * Projects (minimal for Milestone 0). Milestone 2 adds notes, tasks, progress and questions.
 */
import { z } from 'zod'

export const PROJECT_KINDS = ['work', 'personal'] as const
export const ProjectKindSchema = z.enum(PROJECT_KINDS)
export type ProjectKind = z.infer<typeof ProjectKindSchema>

export const PROJECT_STATUSES = ['active', 'paused', 'done'] as const
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES)
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>

export const PROJECT_KIND_LABELS: Record<ProjectKind, string> = {
  work: 'Work',
  personal: 'Personal',
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
}

const singleLine = /^[^\p{Cc}\p{Zl}\p{Zp}]*$/u

export const ProjectInputSchema = z.strictObject({
  name: z.string().trim().min(1, 'Enter a name').max(120).regex(singleLine, 'Use a single line'),
  kind: ProjectKindSchema,
  goal: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : undefined)),
})
export type ProjectInput = z.infer<typeof ProjectInputSchema>
