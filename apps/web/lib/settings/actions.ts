'use server'

/**
 * Settings server actions. Server actions are public POST endpoints, so each
 * one authenticates itself (withOwnerTx → requireOwner) and validates its
 * input (service.ts) — the page-level check does not cover them.
 */
import { revalidatePath } from 'next/cache'
import { unstable_rethrow } from 'next/navigation'
import type { Tx } from '@personal-home/db'
import { withOwnerTx } from '@/lib/server/session'
import type { SettingsActionState } from './action-state'
import {
  changeHomeLayoutFromForm,
  saveAvailableHoursFromForm,
  saveTimezoneFromForm,
} from './service'

async function run(
  mutate: (tx: Tx, formData: FormData) => Promise<SettingsActionState>,
  formData: FormData,
  paths: string[],
): Promise<SettingsActionState> {
  try {
    const state = await withOwnerTx((tx) => mutate(tx, formData))
    if (state.status === 'saved') for (const path of paths) revalidatePath(path)
    return state
  } catch (error) {
    unstable_rethrow(error) // redirects from requireOwner()
    // Log the kind of failure only: never the submitted values.
    const code = (error as { code?: unknown })?.code
    console.error('settings action failed', {
      name: error instanceof Error ? error.name : typeof error,
      code: typeof code === 'string' ? code : undefined,
    })
    return { status: 'error', message: 'Could not save right now. Please try again.' }
  }
}

export async function saveTimezoneAction(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  return run(saveTimezoneFromForm, formData, ['/', '/settings', '/settings/timezone'])
}

export async function changeHomeLayoutAction(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  return run(changeHomeLayoutFromForm, formData, ['/', '/settings', '/settings/home-layout'])
}

export async function saveAvailableHoursAction(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  return run(saveAvailableHoursFromForm, formData, ['/', '/settings', '/settings/hours'])
}
