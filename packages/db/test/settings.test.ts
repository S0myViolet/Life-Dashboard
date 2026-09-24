import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { defaultHomeLayout, visibleHomeModules } from '@personal-home/core'
import {
  SettingsTimezoneNotRecognisedError,
  changeHomeLayout,
  getOwnerSettings,
  listTimezoneNames,
  resolveTimezoneName,
  updateAvailableHours,
  updateHomeLayout,
  updateTimezone,
  withOwner,
  type OwnerClaims,
} from '../src/index.ts'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  withAnon,
  type TestDatabase,
} from './harness.ts'

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

const asOwner = <T>(fn: Parameters<typeof withOwner<T>>[2]) => withOwner(t.db, owner, fn)
const asStranger = <T>(fn: Parameters<typeof withOwner<T>>[2]) => withOwner(t.db, stranger, fn)

describe('getOwnerSettings', () => {
  it('returns defaults for the owner with a repaired, complete layout', async () => {
    const s = await asOwner((tx) => getOwnerSettings(tx))
    expect(s).toMatchObject({
      timezone: 'Europe/London',
      timezoneConfirmed: false,
      availableHours: null,
      availableHoursInvalid: false,
      homeLayout: defaultHomeLayout(),
      notificationPrefs: {},
    })
    expect(s?.updatedAt).toBeInstanceOf(Date)
  })

  it('returns null for a signed-in stranger and permission denied for anon', async () => {
    expect(await asStranger((tx) => getOwnerSettings(tx))).toBeNull()
    await expect(withAnon(t.db, (tx) => getOwnerSettings(tx))).rejects.toThrow(/permission denied/)
  })

  it('flags invalid stored hours instead of presenting them as empty', async () => {
    await t.db`update public.owner_settings set available_hours = '[{"weekday":9}]'::jsonb`
    const s = await asOwner((tx) => getOwnerSettings(tx))
    expect(s).toMatchObject({ availableHours: null, availableHoursInvalid: true })
  })
})

describe('updateTimezone', () => {
  it('saves and confirms a timezone', async () => {
    const s = await asOwner((tx) => updateTimezone(tx, 'America/New_York', true))
    expect(s).toMatchObject({ timezone: 'America/New_York', timezoneConfirmed: true })
    const again = await asOwner((tx) => getOwnerSettings(tx))
    expect(again?.timezone).toBe('America/New_York')
  })

  it('stores a spelling the database knows for legacy device names', async () => {
    // Chrome reports Asia/Calcutta; whichever spelling this Postgres ships is stored.
    const resolved = await asOwner((tx) => resolveTimezoneName(tx, 'Asia/Calcutta'))
    expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain(resolved)
    const s = await asOwner((tx) => updateTimezone(tx, 'Asia/Calcutta', true))
    expect(s?.timezone).toBe(resolved)
  })

  it('rejects invalid input before touching the database', async () => {
    await expect(asOwner((tx) => updateTimezone(tx, 'Mars/Olympus', true))).rejects.toThrow(
      ZodError,
    )
    await expect(
      asOwner((tx) => updateTimezone(tx, "Europe/London'; drop table x; --", true)),
    ).rejects.toThrow(ZodError)
  })

  it('keeps the database trigger as the last line of defence', async () => {
    await expect(
      asOwner((tx) => tx`update public.owner_settings set timezone = 'Mars/Olympus'`),
    ).rejects.toThrow(/invalid IANA timezone/)
  })

  it('can store every zone this runtime lists (legacy spellings resolved)', async () => {
    const unresolved: string[] = []
    await asOwner(async (tx) => {
      for (const name of Intl.supportedValuesOf('timeZone')) {
        if ((await resolveTimezoneName(tx, name)) === null) unresolved.push(name)
      }
    })
    expect(unresolved).toEqual([])
  })

  it('throws SettingsTimezoneNotRecognisedError when the database has no spelling of a zone', async (ctx) => {
    // Intl accepts these backward-compatible names; some Postgres builds (including the
    // local one used here) ship tzdata without them. Skip where the database has them all.
    const names = new Set(await asOwner((tx) => listTimezoneNames(tx)))
    const missing = ['GB', 'US/Eastern', 'US/Pacific', 'NZ', 'Japan'].find((n) => !names.has(n))
    if (!missing) ctx.skip()
    await expect(asOwner((tx) => updateTimezone(tx, missing!, true))).rejects.toThrow(
      SettingsTimezoneNotRecognisedError,
    )
    expect((await asOwner((tx) => getOwnerSettings(tx)))?.timezone).toBe('Europe/London')
  })

  it('does nothing for a stranger and is denied for anon', async () => {
    expect(await asStranger((tx) => updateTimezone(tx, 'UTC', true))).toBeNull()
    const s = await asOwner((tx) => getOwnerSettings(tx))
    expect(s).toMatchObject({ timezone: 'Europe/London', timezoneConfirmed: false })
    await expect(withAnon(t.db, (tx) => updateTimezone(tx, 'UTC', true))).rejects.toThrow(
      /permission denied/,
    )
  })
})

describe('home layout', () => {
  it('applies operations atomically and persists them', async () => {
    await asOwner((tx) => changeHomeLayout(tx, { op: 'hide', module: 'health_preview' }))
    await asOwner((tx) => changeHomeLayout(tx, { op: 'move', module: 'briefing', direction: 'up' }))
    const s = await asOwner((tx) => getOwnerSettings(tx))
    expect(visibleHomeModules(s!.homeLayout)).toEqual([
      'needs_attention',
      'todays_plan',
      'briefing',
      'today',
      'money_preview',
      'interests',
    ])
  })

  it('refuses to hide or move required modules and reports no-op changes', async () => {
    expect(
      await asOwner((tx) => changeHomeLayout(tx, { op: 'hide', module: 'needs_attention' })),
    ).toEqual({ status: 'required_module' })
    for (const direction of ['up', 'down'] as const) {
      expect(
        await asOwner((tx) =>
          changeHomeLayout(tx, { op: 'move', module: 'needs_attention', direction }),
        ),
      ).toEqual({ status: 'required_module' })
    }
    // The first optional module cannot climb above the required ones.
    const noop = await asOwner((tx) =>
      changeHomeLayout(tx, { op: 'move', module: 'today', direction: 'up' }),
    )
    expect(noop).toMatchObject({ status: 'saved', changed: false })
    const s = await asOwner((tx) => getOwnerSettings(tx))
    expect(s!.homeLayout).toEqual(defaultHomeLayout())
  })

  it('serialises concurrent operations (no lost update)', async () => {
    await Promise.all([
      asOwner((tx) => changeHomeLayout(tx, { op: 'hide', module: 'interests' })),
      asOwner((tx) => changeHomeLayout(tx, { op: 'hide', module: 'money_preview' })),
      asOwner((tx) => changeHomeLayout(tx, { op: 'hide', module: 'health_preview' })),
    ])
    const s = await asOwner((tx) => getOwnerSettings(tx))
    expect(
      s!.homeLayout
        .filter((e) => e.hidden)
        .map((e) => e.module)
        .sort(),
    ).toEqual(['health_preview', 'interests', 'money_preview'])
  })

  it('validates full layouts on write', async () => {
    const layout = defaultHomeLayout().map((e) =>
      e.module === 'todays_plan' ? { ...e, hidden: true } : e,
    )
    await expect(asOwner((tx) => updateHomeLayout(tx, layout))).rejects.toThrow(ZodError)
    const [first, ...rest] = defaultHomeLayout()
    await expect(asOwner((tx) => updateHomeLayout(tx, [...rest, first!]))).rejects.toThrow(ZodError)
    await expect(
      asOwner((tx) => updateHomeLayout(tx, defaultHomeLayout().slice(2))),
    ).rejects.toThrow(ZodError)
  })

  it('is invisible to strangers and denied to anon', async () => {
    expect(
      await asStranger((tx) => changeHomeLayout(tx, { op: 'hide', module: 'interests' })),
    ).toEqual({ status: 'not_owner' })
    expect(await asStranger((tx) => updateHomeLayout(tx, defaultHomeLayout()))).toBeNull()
    await expect(
      withAnon(t.db, (tx) => changeHomeLayout(tx, { op: 'hide', module: 'interests' })),
    ).rejects.toThrow(/permission denied/)
    const s = await asOwner((tx) => getOwnerSettings(tx))
    expect(s!.homeLayout.every((e) => !e.hidden)).toBe(true)
  })
})

describe('available hours', () => {
  it('saves sorted hours and clears with an empty list', async () => {
    const s = await asOwner((tx) =>
      updateAvailableHours(tx, [
        { weekday: 2, start: '13:00', end: '17:00' },
        { weekday: 2, start: '09:00', end: '12:00' },
      ]),
    )
    expect(s?.availableHours).toEqual([
      { weekday: 2, start: '09:00', end: '12:00' },
      { weekday: 2, start: '13:00', end: '17:00' },
    ])
    const [raw] = await t.db<{ availableHours: unknown }[]>`
      select available_hours from public.owner_settings
    `
    expect(raw?.availableHours).toEqual(s?.availableHours)

    const cleared = await asOwner((tx) => updateAvailableHours(tx, []))
    expect(cleared?.availableHours).toBeNull()
    const [rawCleared] = await t.db<{ availableHours: unknown }[]>`
      select available_hours from public.owner_settings
    `
    expect(rawCleared?.availableHours).toBeNull()
  })

  it('rejects overlaps and leaves the saved value unchanged', async () => {
    await asOwner((tx) => updateAvailableHours(tx, [{ weekday: 1, start: '09:00', end: '17:00' }]))
    await expect(
      asOwner((tx) =>
        updateAvailableHours(tx, [
          { weekday: 1, start: '09:00', end: '12:00' },
          { weekday: 1, start: '11:00', end: '13:00' },
        ]),
      ),
    ).rejects.toThrow(ZodError)
    const s = await asOwner((tx) => getOwnerSettings(tx))
    expect(s?.availableHours).toEqual([{ weekday: 1, start: '09:00', end: '17:00' }])
  })

  it('does nothing for a stranger and is denied for anon', async () => {
    const hours = [{ weekday: 3 as const, start: '09:00', end: '10:00' }]
    expect(await asStranger((tx) => updateAvailableHours(tx, hours))).toBeNull()
    await expect(withAnon(t.db, (tx) => updateAvailableHours(tx, hours))).rejects.toThrow(
      /permission denied/,
    )
    const s = await asOwner((tx) => getOwnerSettings(tx))
    expect(s?.availableHours).toBeNull()
  })
})
