/**
 * Parsing for the owner's capture forms (kept out of the 'use server' actions
 * module so it can be unit tested).
 */
import { z } from 'zod'
import { CAPTURE_UUID_RE } from '@personal-home/core'

/**
 * The project choice on the attach form. `keep` (the default on /projects,
 * where the pasted link may already be selected) leaves an existing
 * conversation's project alone; '' is an explicit "No project"; otherwise a
 * project id. The form component sends the same literal.
 */
export const ATTACH_KEEP_PROJECT = 'keep'

export const AttachFormSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  projectId: z
    .union([z.literal(ATTACH_KEEP_PROJECT), z.literal(''), z.string().regex(CAPTURE_UUID_RE)])
    // undefined: keep the current project (none for a new conversation); null: no project.
    .transform((v): string | null | undefined => (v === ATTACH_KEEP_PROJECT ? undefined : v === '' ? null : v)),
})
