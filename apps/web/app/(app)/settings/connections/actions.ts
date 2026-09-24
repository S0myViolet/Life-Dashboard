'use server'
/**
 * Owner-driven connection changes: pause, resume, rename, disconnect.
 *
 * Every action re-checks the owner session, insists on a same-origin request
 * (Next.js lets Origin-less action requests through), validates its input with
 * zod and re-reads the connection by id on the server. Nothing here contacts a
 * provider except disconnect's best-effort token revocation.
 */
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { coreEnv } from '@/lib/env'
import { getDb } from '@/lib/server/db'
import { requireOwner } from '@/lib/server/session'
import {
  connectionAdminDisconnect,
  connectionAdminPause,
  connectionAdminRename,
  connectionAdminResume,
} from '@/lib/integrations/admin'
import { isSameOriginRequest } from '@/lib/integrations/request-guard'
import { tokenEncryptionKey } from '@/lib/integrations/settings'

const PATH = '/settings/connections'

const IdForm = z.object({ id: z.uuid() })
const RenameForm = z.object({
  id: z.uuid(),
  label: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\u0000-\u001f\u007f]*$/),
})

async function guard(): Promise<void> {
  await requireOwner()
  const h = await headers()
  if (!isSameOriginRequest(h.get('origin'), coreEnv().APP_URL)) {
    throw new Error('Request rejected: it did not come from this app.')
  }
}

function idFrom(formData: FormData): string | null {
  const parsed = IdForm.safeParse({ id: formData.get('id') })
  return parsed.success ? parsed.data.id : null
}

export async function pauseConnection(formData: FormData): Promise<void> {
  await guard()
  const id = idFrom(formData)
  if (id) await connectionAdminPause(getDb(), id, new Date())
  revalidatePath(PATH)
}

export async function resumeConnection(formData: FormData): Promise<void> {
  await guard()
  const id = idFrom(formData)
  if (id) await connectionAdminResume(getDb(), id, new Date())
  revalidatePath(PATH)
}

export async function renameConnection(formData: FormData): Promise<void> {
  await guard()
  const parsed = RenameForm.safeParse({ id: formData.get('id'), label: formData.get('label') })
  if (parsed.success) await connectionAdminRename(getDb(), parsed.data.id, parsed.data.label)
  revalidatePath(PATH)
}

export async function disconnectConnection(formData: FormData): Promise<void> {
  await guard()
  const id = idFrom(formData)
  // The confirm step posts `confirm=yes`; a bare request disconnects nothing.
  if (!id || formData.get('confirm') !== 'yes') {
    revalidatePath(PATH)
    return
  }
  const result = await connectionAdminDisconnect({
    db: getDb(),
    id,
    key: await tokenEncryptionKey(),
    fetch: globalThis.fetch,
    now: () => new Date(),
  })
  revalidatePath(PATH)
  if (result) {
    const params = new URLSearchParams({ disconnected: result.provider, revoke: result.revoke })
    redirect(`${PATH}?${params.toString()}`)
  }
}
