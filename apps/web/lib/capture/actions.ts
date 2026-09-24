'use server'
/**
 * Owner-side Server Actions for projects and the Chrome helper.
 *
 * Every action re-checks the owner session itself (a page-level check does not
 * protect an action) and validates its FormData with zod. Conversation and
 * project writes are RLS-enforced owner transactions; device and pairing-code
 * writes touch the private schema through a service transaction, only after the
 * owner check. Return values carry only what the UI renders.
 */
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import {
  CAPTURE_PROVIDER_LABELS,
  CAPTURE_UUID_RE,
  ProjectInputSchema,
  captureParseConversationUrl,
} from '@personal-home/core'
import {
  captureCreatePairingCode,
  captureRemoveConversation,
  captureRevokeDevice,
  captureSelectConversation,
  captureSetConversationPaused,
  createProject,
} from '@personal-home/db'
import { AttachFormSchema } from '@/lib/capture/forms'
import { serviceTransaction } from '@/lib/server/db'
import { requireOwner, withOwnerTx } from '@/lib/server/session'

const CHROME_HELPER_PATH = '/settings/chrome-helper'
const PROJECTS_PATH = '/projects'

const uuid = z.string().regex(CAPTURE_UUID_RE)

function revalidateCapturePages() {
  revalidatePath(CHROME_HELPER_PATH)
  revalidatePath(PROJECTS_PATH)
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

// ---------------------------------------------------------------------------
// Pairing and devices
// ---------------------------------------------------------------------------

export type PairingCodeState =
  | { status: 'idle' }
  | { status: 'created'; code: string; expiresAt: string }
  | { status: 'error'; message: string }

/** Creates a one-time code (shown once, valid 10 minutes). Any older unused code stops working. */
export async function createPairingCodeAction(): Promise<PairingCodeState> {
  await requireOwner()
  try {
    const { code, expiresAt } = await serviceTransaction((tx) => captureCreatePairingCode(tx))
    revalidatePath(CHROME_HELPER_PATH)
    return { status: 'created', code, expiresAt: expiresAt.toISOString() }
  } catch {
    return { status: 'error', message: 'Could not create a code. Try again.' }
  }
}

export async function revokeDeviceAction(formData: FormData): Promise<void> {
  await requireOwner()
  const id = uuid.safeParse(field(formData, 'deviceId'))
  if (!id.success) return
  await serviceTransaction((tx) => captureRevokeDevice(tx, id.data))
  revalidatePath(CHROME_HELPER_PATH)
}

// ---------------------------------------------------------------------------
// Selected conversations
// ---------------------------------------------------------------------------

const PauseSchema = z.object({
  conversationId: uuid,
  paused: z.enum(['true', 'false']).transform((v) => v === 'true'),
})

/** Pause, or resume/reconnect (clears a reported problem state; last good data was kept). */
export async function setConversationPausedAction(formData: FormData): Promise<void> {
  const parsed = PauseSchema.safeParse({
    conversationId: field(formData, 'conversationId'),
    paused: field(formData, 'paused'),
  })
  if (!parsed.success) {
    await requireOwner()
    return
  }
  await withOwnerTx((tx) =>
    captureSetConversationPaused(tx, parsed.data.conversationId, parsed.data.paused),
  )
  revalidateCapturePages()
}

/** Stops collecting and deletes the conversation's captured messages, versions and log. */
export async function removeConversationAction(formData: FormData): Promise<void> {
  const id = uuid.safeParse(field(formData, 'conversationId'))
  if (!id.success) {
    await requireOwner()
    return
  }
  await withOwnerTx((tx) => captureRemoveConversation(tx, id.data))
  revalidateCapturePages()
}

export type AttachState =
  | { status: 'idle' }
  | {
      status: 'selected'
      created: boolean
      /** An already selected conversation kept its project (none was chosen). */
      projectKept: boolean
      provider: string
      url: string
      conversationId: string
    }
  | { status: 'error'; message: string; field?: 'url' | 'projectId' }

/**
 * Select a conversation for collection (and attach it to a project). The Chrome
 * helper's token cannot do this: selection needs the owner's session.
 * Re-attaching an already selected conversation resumes it, and moves it only
 * when a project (or an explicit "No project") was chosen.
 */
export async function attachConversationAction(
  _prev: AttachState,
  formData: FormData,
): Promise<AttachState> {
  const parsed = AttachFormSchema.safeParse({
    url: field(formData, 'url'),
    projectId: field(formData, 'projectId'),
  })
  if (!parsed.success) {
    await requireOwner()
    const urlIssue = parsed.error.issues.some((i) => i.path[0] === 'url')
    return urlIssue
      ? { status: 'error', field: 'url', message: 'Paste a conversation link.' }
      : { status: 'error', field: 'projectId', message: 'Choose a project from the list.' }
  }
  if (!captureParseConversationUrl(parsed.data.url)) {
    await requireOwner()
    return {
      status: 'error',
      field: 'url',
      message:
        'That is not a conversation link. Use a link like https://chatgpt.com/c/… or https://claude.ai/chat/… (shared and temporary chats cannot be collected).',
    }
  }
  const result = await withOwnerTx((tx) =>
    captureSelectConversation(tx, { url: parsed.data.url, projectId: parsed.data.projectId }),
  )
  switch (result.status) {
    case 'invalid_url':
      return { status: 'error', field: 'url', message: 'That is not a conversation link.' }
    case 'unknown_project':
      return { status: 'error', field: 'projectId', message: 'That project no longer exists.' }
    case 'selected':
      revalidateCapturePages()
      return {
        status: 'selected',
        created: result.created,
        projectKept: !result.created && parsed.data.projectId === undefined,
        provider: CAPTURE_PROVIDER_LABELS[result.conversation.provider],
        url: result.conversation.url,
        conversationId: result.conversation.id,
      }
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type ProjectFormState =
  | { status: 'idle' }
  | { status: 'created'; name: string; at: number }
  | { status: 'error'; message: string; fields: Partial<Record<'name' | 'kind' | 'goal', string>> }

export async function createProjectAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const parsed = ProjectInputSchema.safeParse({
    name: field(formData, 'name'),
    kind: field(formData, 'kind'),
    goal: field(formData, 'goal'),
  })
  if (!parsed.success) {
    await requireOwner()
    const fields: Partial<Record<'name' | 'kind' | 'goal', string>> = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      if ((key === 'name' || key === 'kind' || key === 'goal') && !fields[key]) {
        fields[key] =
          key === 'kind'
            ? 'Choose work or personal.'
            : key === 'goal'
              ? 'Keep the goal under 2,000 characters.'
              : issue.message === 'Enter a name' || issue.message === 'Use a single line'
                ? issue.message
                : 'Use 1 to 120 characters.'
      }
    }
    return { status: 'error', message: 'Check the highlighted fields.', fields }
  }
  const project = await withOwnerTx((tx) => createProject(tx, parsed.data))
  revalidatePath(PROJECTS_PATH)
  return { status: 'created', name: project.name, at: Date.now() }
}
