/**
 * Read models for the owner's capture pages. Callers pass the session from
 * requireOwner(); conversation/project reads are RLS-enforced owner
 * transactions, device reads are service reads of the private schema (no hashes).
 */
import 'server-only'
import {
  captureListConversations,
  captureListDevices,
  captureLivePairingCodeExpiry,
  listProjects,
  type CaptureConversationRow,
  type CaptureDeviceRow,
  type ProjectRow,
  type Tx,
} from '@personal-home/db'
import { ownerTransaction, serviceTransaction } from '@/lib/server/db'
import type { OwnerSession } from '@/lib/server/session'

async function ownerTimezone(tx: Tx): Promise<string> {
  const [row] = await tx<{ timezone: string }[]>`select timezone from public.owner_settings`
  return row?.timezone ?? 'Europe/London'
}

export interface ChromeHelperPageData {
  timezone: string
  conversations: CaptureConversationRow[]
  devices: CaptureDeviceRow[]
  liveCodeExpiresAt: Date | null
}

export async function loadChromeHelperPage(session: OwnerSession): Promise<ChromeHelperPageData> {
  const [owner, service] = await Promise.all([
    ownerTransaction(session.claims, async (tx) => ({
      timezone: await ownerTimezone(tx),
      conversations: await captureListConversations(tx),
    })),
    serviceTransaction(async (tx) => ({
      devices: await captureListDevices(tx),
      liveCodeExpiresAt: await captureLivePairingCodeExpiry(tx),
    })),
  ])
  return { ...owner, ...service }
}

export interface ProjectsPageData {
  timezone: string
  projects: ProjectRow[]
  conversations: CaptureConversationRow[]
}

export async function loadProjectsPage(session: OwnerSession): Promise<ProjectsPageData> {
  return ownerTransaction(session.claims, async (tx) => ({
    timezone: await ownerTimezone(tx),
    projects: await listProjects(tx),
    conversations: await captureListConversations(tx),
  }))
}

export async function loadProjectOptions(session: OwnerSession): Promise<ProjectRow[]> {
  return ownerTransaction(session.claims, (tx) => listProjects(tx))
}
