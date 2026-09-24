/**
 * Settings server-action bodies (lib/settings/service.ts) against a real database:
 * untrusted FormData in, validated writes through the owner transaction (RLS) out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getOwnerSettings, withOwner, type OwnerClaims, type Tx } from '@personal-home/db'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  type TestDatabase,
} from '@personal-home/db/testing'
import {
  changeHomeLayoutFromForm,
  saveAvailableHoursFromForm,
  saveTimezoneFromForm,
} from '@/lib/settings/service'

// Provided by packages/db/test/global-setup.ts (the vitest globalSetup).
declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

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
beforeEach(async () => {
  await t.db`
    update public.owner_settings
    set timezone = 'Europe/London', timezone_confirmed = false, available_hours = null,
        home_layout = '[]'::jsonb
  `
})

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}

const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, owner, fn)
const asStranger = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, stranger, fn)
const saved = () => asOwner((tx) => getOwnerSettings(tx))

describe('saveTimezoneFromForm', () => {
  it('saves and confirms a valid IANA timezone', async () => {
    const state = await asOwner((tx) =>
      saveTimezoneFromForm(tx, form({ timezone: 'America/New_York' })),
    )
    expect(state).toEqual({ status: 'saved', message: 'Timezone set to America/New_York.' })
    expect(await saved()).toMatchObject({
      timezone: 'America/New_York',
      timezoneConfirmed: true,
    })
  })

  it('accepts a legacy device spelling and stores a name the database knows', async () => {
    const state = await asOwner((tx) =>
      saveTimezoneFromForm(tx, form({ timezone: 'Asia/Calcutta' })),
    )
    expect(state.status).toBe('saved')
    expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain((await saved())?.timezone)
  })

  it('rejects missing, junk and injection-shaped values without writing', async () => {
    for (const timezone of [
      undefined,
      '',
      'Mars/Olympus',
      "Europe/London'; drop table x; --",
      'x'.repeat(200),
    ]) {
      const state = await asOwner((tx) =>
        saveTimezoneFromForm(tx, form(timezone === undefined ? {} : { timezone })),
      )
      expect(state.status, String(timezone)).toBe('error')
      expect(state.status === 'error' && state.fieldErrors?.timezone).toBeTruthy()
    }
    expect(await saved()).toMatchObject({ timezone: 'Europe/London', timezoneConfirmed: false })
  })

  it('does nothing for a signed-in stranger', async () => {
    const state = await asStranger((tx) =>
      saveTimezoneFromForm(tx, form({ timezone: 'Asia/Tokyo' })),
    )
    expect(state).toMatchObject({ status: 'error', message: 'Only the owner can change settings.' })
    expect((await saved())?.timezone).toBe('Europe/London')
  })
})

describe('changeHomeLayoutFromForm', () => {
  it('hides, shows, moves and resets modules', async () => {
    expect(
      await asOwner((tx) =>
        changeHomeLayoutFromForm(tx, form({ op: 'hide', module: 'health_preview' })),
      ),
    ).toEqual({ status: 'saved', message: 'Health hidden.' })
    expect(
      await asOwner((tx) =>
        changeHomeLayoutFromForm(tx, form({ op: 'move', module: 'briefing', direction: 'up' })),
      ),
    ).toEqual({ status: 'saved', message: 'Latest briefing moved up.' })

    const layout = (await saved())?.homeLayout
    expect(layout?.map((e) => e.module).slice(0, 4)).toEqual([
      'needs_attention',
      'todays_plan',
      'briefing',
      'today',
    ])
    expect(layout?.find((e) => e.module === 'health_preview')?.hidden).toBe(true)

    await asOwner((tx) => changeHomeLayoutFromForm(tx, form({ op: 'reset' })))
    expect((await saved())?.homeLayout.every((e) => !e.hidden)).toBe(true)
  })

  it('refuses to hide required modules', async () => {
    const state = await asOwner((tx) =>
      changeHomeLayoutFromForm(tx, form({ op: 'hide', module: 'needs_attention' })),
    )
    expect(state).toEqual({ status: 'error', message: 'Needs attention always stays on Home.' })
    expect((await saved())?.homeLayout.find((e) => e.module === 'needs_attention')?.hidden).toBe(
      false,
    )
  })

  it('refuses to move required modules (a hand-built POST cannot bypass the editor)', async () => {
    const state = await asOwner((tx) =>
      changeHomeLayoutFromForm(
        tx,
        form({ op: 'move', module: 'needs_attention', direction: 'down' }),
      ),
    )
    expect(state).toEqual({
      status: 'error',
      message: 'Needs attention stays at the top of Home.',
    })
    expect((await saved())?.homeLayout.map((e) => e.module).slice(0, 2)).toEqual([
      'needs_attention',
      'todays_plan',
    ])
  })

  it('rejects malformed operations', async () => {
    const invalid: Record<string, string>[] = [
      {},
      { op: 'hide' },
      { op: 'hide', module: 'crypto_prices' },
      { op: 'move', module: 'today' },
      { op: 'move', module: 'today', direction: 'sideways' },
      { op: 'delete', module: 'today' },
    ]
    for (const fields of invalid) {
      const state = await asOwner((tx) => changeHomeLayoutFromForm(tx, form(fields)))
      expect(state, JSON.stringify(fields)).toEqual({
        status: 'error',
        message: 'That layout change is not valid.',
      })
    }
  })

  it('does nothing for a signed-in stranger', async () => {
    const state = await asStranger((tx) =>
      changeHomeLayoutFromForm(tx, form({ op: 'hide', module: 'interests' })),
    )
    expect(state).toMatchObject({ status: 'error', message: 'Only the owner can change settings.' })
    expect((await saved())?.homeLayout.find((e) => e.module === 'interests')?.hidden).toBe(false)
  })
})

describe('saveAvailableHoursFromForm', () => {
  const hours = (value: unknown) => form({ hours: JSON.stringify(value) })

  it('saves valid hours sorted, and clears them with an empty list', async () => {
    const state = await asOwner((tx) =>
      saveAvailableHoursFromForm(
        tx,
        hours([
          { weekday: 2, start: '09:00', end: '12:00' },
          { weekday: 1, start: '13:00', end: '17:30' },
          { weekday: 1, start: '09:00', end: '12:00' },
        ]),
      ),
    )
    expect(state).toEqual({ status: 'saved', message: 'Available hours saved.' })
    expect((await saved())?.availableHours).toEqual([
      { weekday: 1, start: '09:00', end: '12:00' },
      { weekday: 1, start: '13:00', end: '17:30' },
      { weekday: 2, start: '09:00', end: '12:00' },
    ])

    const cleared = await asOwner((tx) => saveAvailableHoursFromForm(tx, hours([])))
    expect(cleared).toEqual({ status: 'saved', message: 'Available hours cleared.' })
    const [row] = await t.db<{ isNull: boolean }[]>`
      select available_hours is null as is_null from public.owner_settings
    `
    expect(row?.isNull).toBe(true)
  })

  it('reports overlaps against the range they refer to and keeps the saved value', async () => {
    const state = await asOwner((tx) =>
      saveAvailableHoursFromForm(
        tx,
        hours([
          { weekday: 1, start: '09:00', end: '17:00' },
          { weekday: 1, start: '16:00', end: '18:00' },
        ]),
      ),
    )
    expect(state).toEqual({
      status: 'error',
      message: 'Some time ranges need fixing.',
      fieldErrors: { '1': 'Overlaps 09:00–17:00 on Monday' },
    })
    expect((await saved())?.availableHours).toBeNull()
  })

  it('rejects unreadable, oversized and malformed submissions', async () => {
    const bad: FormData[] = [
      form({}),
      form({ hours: '' }),
      form({ hours: '{not json' }),
      form({ hours: JSON.stringify([{ weekday: 1, start: '09:00', end: '17:00' }]).padEnd(9000) }),
      hours({ weekday: 1, start: '09:00', end: '17:00' }),
      hours([{ weekday: 8, start: '09:00', end: '17:00' }]),
      hours([{ weekday: 1, start: '9am', end: '17:00' }]),
      hours([{ weekday: 1, start: '17:00', end: '09:00' }]),
      hours([{ weekday: 1, start: '09:00', end: '17:00', note: 'extra' }]),
    ]
    for (const data of bad) {
      const state = await asOwner((tx) => saveAvailableHoursFromForm(tx, data))
      expect(state.status).toBe('error')
    }
    expect((await saved())?.availableHours).toBeNull()
  })

  it('does nothing for a signed-in stranger', async () => {
    const state = await asStranger((tx) =>
      saveAvailableHoursFromForm(tx, hours([{ weekday: 1, start: '09:00', end: '17:00' }])),
    )
    expect(state).toMatchObject({ status: 'error', message: 'Only the owner can change settings.' })
    expect((await saved())?.availableHours).toBeNull()
  })
})
