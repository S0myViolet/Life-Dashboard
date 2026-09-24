/**
 * Projects repository (owner transactions, RLS enforced). Minimal for Milestone 0.
 */
import {
  CAPTURE_UUID_RE,
  ProjectInputSchema,
  type ProjectInput,
  type ProjectKind,
  type ProjectStatus,
} from '@personal-home/core'
import type { Tx } from '../client.ts'

export interface ProjectRow {
  id: string
  name: string
  kind: ProjectKind
  goal: string | null
  status: ProjectStatus
  createdAt: Date
  updatedAt: Date
  conversationCount: number
}

export async function listProjects(tx: Tx): Promise<ProjectRow[]> {
  return tx<ProjectRow[]>`
    select p.id, p.name, p.kind, p.goal, p.status, p.created_at, p.updated_at,
           (select count(*)::int from public.conversations c where c.project_id = p.id)
             as conversation_count
    from public.projects p
    order by case p.status when 'active' then 0 when 'paused' then 1 else 2 end,
             p.created_at desc
  `
}

export async function createProject(tx: Tx, input: ProjectInput): Promise<ProjectRow> {
  const p = ProjectInputSchema.parse(input)
  const [row] = await tx<ProjectRow[]>`
    insert into public.projects (name, kind, goal)
    values (${p.name}, ${p.kind}, ${p.goal ?? null})
    returning id, name, kind, goal, status, created_at, updated_at, 0 as conversation_count
  `
  if (!row) throw new Error('project insert returned no row')
  return row
}

export async function projectExists(tx: Tx, projectId: string): Promise<boolean> {
  if (!CAPTURE_UUID_RE.test(projectId)) return false
  const [row] = await tx<{ ok: boolean }[]>`
    select exists (select 1 from public.projects where id = ${projectId}::uuid) as ok
  `
  return row?.ok === true
}
