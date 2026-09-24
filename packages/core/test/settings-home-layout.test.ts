import { describe, expect, it } from 'vitest'
import {
  HOME_MODULES,
  HomeLayoutOperationSchema,
  HomeLayoutSchema,
  REQUIRED_HOME_MODULES,
  applyHomeLayoutOperation,
  defaultHomeLayout,
  moveHomeModule,
  normalizeHomeLayout,
  setHomeModuleHidden,
  visibleHomeModules,
  type HomeLayout,
} from '../src/index.ts'

const order = (layout: HomeLayout) => layout.map((e) => e.module)

describe('normalizeHomeLayout', () => {
  it('returns the default order for empty, null or non-array input', () => {
    for (const raw of [[], null, undefined, {}, 'x', 42]) {
      expect(normalizeHomeLayout(raw)).toEqual(defaultHomeLayout())
    }
    expect(order(defaultHomeLayout())).toEqual([...HOME_MODULES])
  })

  it('keeps saved order, appends missing modules in default order', () => {
    const layout = normalizeHomeLayout([
      { module: 'interests', hidden: true },
      { module: 'briefing', hidden: false },
    ])
    expect(order(layout)).toEqual([
      'interests',
      'briefing',
      'needs_attention',
      'todays_plan',
      'today',
      'health_preview',
      'money_preview',
    ])
    expect(layout[0]).toEqual({ module: 'interests', hidden: true })
    expect(layout.slice(2).every((e) => !e.hidden)).toBe(true)
  })

  it('drops unknown modules, malformed entries and duplicates (first wins)', () => {
    const layout = normalizeHomeLayout([
      { module: 'spotify_wall', hidden: false },
      null,
      'today',
      { hidden: true },
      { module: 'money_preview', hidden: true },
      { module: 'money_preview', hidden: false },
      { module: 'today', hidden: 'yes' },
    ])
    expect(layout).toHaveLength(HOME_MODULES.length)
    expect(new Set(order(layout)).size).toBe(HOME_MODULES.length)
    expect(layout[0]).toEqual({ module: 'money_preview', hidden: true })
    // Non-boolean hidden is treated as visible rather than guessed.
    expect(layout[1]).toEqual({ module: 'today', hidden: false })
  })

  it('forces required modules visible even if stored hidden', () => {
    const layout = normalizeHomeLayout(
      REQUIRED_HOME_MODULES.map((module) => ({ module, hidden: true })),
    )
    for (const module of REQUIRED_HOME_MODULES) {
      expect(layout.find((e) => e.module === module)?.hidden).toBe(false)
    }
    expect(HomeLayoutSchema.safeParse(layout).success).toBe(true)
  })
})

describe('HomeLayoutSchema (strict, for writes)', () => {
  it('accepts the default layout', () => {
    expect(HomeLayoutSchema.safeParse(defaultHomeLayout()).success).toBe(true)
  })

  it('rejects missing, duplicated, unknown modules and hidden required modules', () => {
    const base = defaultHomeLayout()
    expect(HomeLayoutSchema.safeParse(base.slice(1)).success).toBe(false)
    const dup = [...base.slice(0, -1), { module: 'today', hidden: false }]
    expect(HomeLayoutSchema.safeParse(dup).success).toBe(false)
    const unknown = [...base.slice(0, -1), { module: 'unknown', hidden: false }]
    expect(HomeLayoutSchema.safeParse(unknown).success).toBe(false)
    const hiddenRequired = base.map((e) =>
      e.module === 'needs_attention' ? { ...e, hidden: true } : e,
    )
    const res = HomeLayoutSchema.safeParse(hiddenRequired)
    expect(res.success).toBe(false)
    expect(res.error?.issues[0]?.message).toMatch(/cannot be hidden/)
    const extraKey = base.map((e) => ({ ...e, extra: 1 }))
    expect(HomeLayoutSchema.safeParse(extraKey).success).toBe(false)
  })
})

describe('layout operations', () => {
  it('moves up/down and is a no-op at the ends', () => {
    const base = defaultHomeLayout()
    expect(order(moveHomeModule(base, 'todays_plan', 'up')).slice(0, 2)).toEqual([
      'todays_plan',
      'needs_attention',
    ])
    expect(order(moveHomeModule(base, 'needs_attention', 'up'))).toEqual(order(base))
    expect(order(moveHomeModule(base, 'interests', 'down'))).toEqual(order(base))
    const down = moveHomeModule(base, 'briefing', 'down')
    expect(order(down).indexOf('briefing')).toBe(order(base).indexOf('briefing') + 1)
    // Input is not mutated.
    expect(order(base)).toEqual([...HOME_MODULES])
  })

  it('hides and shows optional modules, refuses to hide required ones', () => {
    const base = defaultHomeLayout()
    const hidden = setHomeModuleHidden(base, 'health_preview', true)
    expect(hidden).toMatchObject({ ok: true, changed: true })
    if (!hidden.ok) throw new Error('unreachable')
    expect(visibleHomeModules(hidden.layout)).not.toContain('health_preview')
    const again = setHomeModuleHidden(hidden.layout, 'health_preview', true)
    expect(again).toMatchObject({ ok: true, changed: false })
    expect(setHomeModuleHidden(base, 'needs_attention', true)).toEqual({
      ok: false,
      error: 'required_module',
    })
    // Showing a required module is always fine (already visible).
    expect(setHomeModuleHidden(base, 'todays_plan', false)).toMatchObject({
      ok: true,
      changed: false,
    })
  })

  it('applies parsed operations, including reset', () => {
    let layout = defaultHomeLayout()
    const ops = [
      { op: 'hide', module: 'interests' },
      { op: 'move', module: 'money_preview', direction: 'up' },
      { op: 'move', module: 'money_preview', direction: 'up' },
    ]
    for (const raw of ops) {
      const op = HomeLayoutOperationSchema.parse(raw)
      const result = applyHomeLayoutOperation(layout, op)
      if (!result.ok) throw new Error(result.error)
      layout = result.layout
    }
    expect(visibleHomeModules(layout)).toEqual([
      'needs_attention',
      'todays_plan',
      'today',
      'money_preview',
      'briefing',
      'health_preview',
    ])
    const reset = applyHomeLayoutOperation(layout, { op: 'reset' })
    expect(reset).toMatchObject({ ok: true, changed: true })
    if (reset.ok) expect(reset.layout).toEqual(defaultHomeLayout())
    expect(applyHomeLayoutOperation(layout, { op: 'hide', module: 'todays_plan' })).toEqual({
      ok: false,
      error: 'required_module',
    })
  })

  it('rejects malformed operations at the boundary', () => {
    for (const raw of [
      { op: 'move', module: 'today', direction: 'sideways' },
      { op: 'hide', module: 'nope' },
      { op: 'delete', module: 'today' },
      { op: 'reset', module: 'today' },
      {},
    ]) {
      expect(HomeLayoutOperationSchema.safeParse(raw).success).toBe(false)
    }
  })
})
