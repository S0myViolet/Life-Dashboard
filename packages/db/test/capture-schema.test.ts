/**
 * Row Level Security, grants, constraints and cascades for the projects/capture migration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureIngestSnapshot,
  captureListConversations,
  captureSelectConversation,
  createProject,
  listProjects,
  withOwner,
  withService,
  type OwnerClaims,
} from '../src/index.ts'
import { CHAT_URL, at, makeSnapshot, thread } from './capture-fixtures.ts'
import { createAuthUser, createTestDatabase, seedOwner, withAnon, type TestDatabase } from './harness.ts'

let t: TestDatabase
let owner: OwnerClaims
let stranger: OwnerClaims

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  stranger = await createAuthUser(t.db, 'stranger@example.com')
})
afterAll(async () => {
  await t?.drop()
})

const TABLES = [
  'projects',
  'conversations',
  'captured_messages',
  'captured_message_versions',
  'capture_snapshots',
] as const

describe('projects/capture schema security', () => {
  it('every capture table is owner-only: stranger sees and changes nothing, anon is refused', async () => {
    const project = await withOwner(t.db, owner, (tx) =>
      createProject(tx, { name: 'Thesis', kind: 'work', goal: 'Submit by June' }),
    )
    const selected = await withOwner(t.db, owner, (tx) =>
      captureSelectConversation(tx, { url: CHAT_URL, projectId: project.id }),
    )
    expect(selected.status).toBe('selected')
    await withService(t.db, (tx) => captureIngestSnapshot(tx, makeSnapshot(at(0), thread(2))))

    for (const table of TABLES) {
      const own = await withOwner(t.db, owner, (tx) => tx.unsafe(`select count(*)::int as n from public.${table}`))
      expect(own[0]?.n, table).toBeGreaterThan(0)
      const theirs = await withOwner(t.db, stranger, (tx) =>
        tx.unsafe(`select count(*)::int as n from public.${table}`),
      )
      expect(theirs[0]?.n, table).toBe(0)
      await expect(
        withAnon(t.db, (tx) => tx.unsafe(`select count(*) from public.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/)
    }

    // A stranger cannot insert or update owner rows.
    await expect(
      withOwner(t.db, stranger, (tx) => tx`insert into public.projects (name, kind) values ('x', 'work')`),
    ).rejects.toThrow(/row-level security/)
    const updated = await withOwner(
      t.db,
      stranger,
      (tx) => tx`update public.conversations set capture_state = 'paused' returning id`,
    )
    expect(updated).toHaveLength(0)
    expect(await withOwner(t.db, stranger, (tx) => listProjects(tx))).toEqual([])
  })

  it('device and pairing tables are unreachable for authenticated and anon roles', async () => {
    for (const table of ['private.capture_devices', 'private.capture_pairing_codes']) {
      await expect(withOwner(t.db, owner, (tx) => tx.unsafe(`select * from ${table}`))).rejects.toThrow(
        /permission denied/,
      )
      await expect(withAnon(t.db, (tx) => tx.unsafe(`select * from ${table}`))).rejects.toThrow(
        /permission denied/,
      )
    }
  })

  it('rejects a URL that does not belong to the provider and a version of another message', async () => {
    await expect(
      withService(
        t.db,
        (tx) => tx`insert into public.conversations (provider, external_id, url)
                   values ('claude', gen_random_uuid(), 'https://chatgpt.com/c/x')`,
      ),
    ).rejects.toThrow(/check constraint/)

    const [a, b] = await withService(t.db, (tx) => tx<{ id: string }[]>`
      select id from public.captured_messages order by message_key limit 2`)
    const [versionOfB] = await withService(t.db, (tx) => tx<{ id: string }[]>`
      select id from public.captured_message_versions where message_id = ${b!.id}`)
    await expect(
      withService(
        t.db,
        (tx) => tx`update public.captured_messages set current_version_id = ${versionOfB!.id} where id = ${a!.id}`,
      ),
    ).rejects.toThrow(/foreign key/)
  })

  it('removing a project keeps its conversations; removing a conversation cascades everything', async () => {
    const [project] = await withOwner(t.db, owner, (tx) => listProjects(tx))
    await withOwner(t.db, owner, (tx) => tx`delete from public.projects where id = ${project!.id}`)
    const [conv] = await withOwner(t.db, owner, (tx) => captureListConversations(tx))
    expect(conv?.projectId).toBeNull()
    expect(conv?.messageCount).toBe(2)

    await withOwner(t.db, owner, (tx) => tx`delete from public.conversations where id = ${conv!.id}`)
    for (const table of ['captured_messages', 'captured_message_versions', 'capture_snapshots']) {
      const [row] = await withService(t.db, (tx) => tx.unsafe(`select count(*)::int as n from public.${table}`))
      expect(row?.n, table).toBe(0)
    }
  })
})
